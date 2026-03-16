import { useState, useEffect, useMemo, useCallback, useRef } from "react";

const BASE = "https://srdcovka.eurooil.cz/api/verejne";

const CORS_PROXIES = [
  (url) => url, // direct first
  (url) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
];

async function fetchWithCorsRetry(url) {
  let lastError;
  for (const proxy of CORS_PROXIES) {
    try {
      const res = await fetch(proxy(url));
      if (res.ok) return res;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error("Všechny pokusy o načtení selhaly (CORS).");
}

const getToken = () => {
  const now = new Date();
  const pad = (n, len = 2) => String(n).padStart(len, "0");
  // .NET-style: 7 fractional digits on seconds
  const ms = now.getUTCMilliseconds();
  const frac = String(ms).padStart(3, "0") + String(Math.floor(Math.random() * 10000)).padStart(4, "0");
  const stamp =
    `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}` +
    `T${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}` +
    `.${frac}Z`;
  return encodeURIComponent(stamp);
};

const FUEL_PALETTE = {
  "natural 95": { color: "#16a34a", bg: "#dcfce7", icon: "⛽" },
  "natural 98": { color: "#2563eb", bg: "#dbeafe", icon: "⛽" },
  nafta: { color: "#d97706", bg: "#fef3c7", icon: "🛢️" },
  "nafta premium": { color: "#ea580c", bg: "#ffedd5", icon: "🛢️" },
  "nafta prémiová": { color: "#ea580c", bg: "#ffedd5", icon: "🛢️" },
  lpg: { color: "#9333ea", bg: "#f3e8ff", icon: "💨" },
  cng: { color: "#0891b2", bg: "#cffafe", icon: "💨" },
  adblue: { color: "#3b82f6", bg: "#dbeafe", icon: "💧" },
  e85: { color: "#059669", bg: "#d1fae5", icon: "🌿" },
};

function matchFuel(name) {
  const n = (name || "").toLowerCase();
  for (const [key, val] of Object.entries(FUEL_PALETTE)) {
    if (n.includes(key)) return val;
  }
  if (n.includes("benzin") || n.includes("petrol")) return FUEL_PALETTE["natural 95"];
  if (n.includes("diesel") || n.includes("motorová")) return FUEL_PALETTE["nafta"];
  return { color: "#64748b", bg: "#f1f5f9", icon: "⛽" };
}

function formatPrice(p) {
  if (p == null || p === 0) return "—";
  const num = typeof p === "string" ? parseFloat(p) : p;
  if (isNaN(num)) return "—";
  return num.toFixed(2) + " Kč";
}

// Deep search for arrays in nested objects
function findArrays(obj, depth = 0) {
  if (depth > 3) return [];
  const results = [];
  if (Array.isArray(obj)) {
    results.push(obj);
  } else if (obj && typeof obj === "object") {
    for (const val of Object.values(obj)) {
      results.push(...findArrays(val, depth + 1));
    }
  }
  return results;
}

function extractStations(raw) {
  if (!raw) return [];
  const arrays = findArrays(raw);
  // Pick the longest array that contains objects
  const candidates = arrays
    .filter((a) => a.length > 0 && typeof a[0] === "object" && !Array.isArray(a[0]))
    .sort((a, b) => b.length - a.length);
  const list = candidates[0] || [];
  return list.map((s, i) => {
    const name = s.nazev || s.nazevCs || s.name || s.jmeno || s.title || s.label || `Stanice ${i + 1}`;
    const addr = s.adresa || s.adresaCs || s.address || s.ulice || "";
    const city = s.mesto || s.mestoCs || s.city || s.obec || "";
    const region = s.kraj || s.region || s.okres || "";
    const zip = s.psc || s.zip || "";
    const id = s.id || s.kod || s.code || s.stationId || i;
    const lat = s.lat || s.latitude || s.gpsLat || s.souradniceX || s.souradnice?.lat || s.gps?.lat || null;
    const lng = s.lng || s.longitude || s.lon || s.gpsLng || s.gpsLon || s.souradniceY || s.souradnice?.lng || s.gps?.lng || null;
    let fuels = s.produkty || s.pohonneHmoty || s.fuels || s.prices || s.ceny || s.ceniky || s.paliva || s.products || [];
    if (!Array.isArray(fuels)) {
      if (typeof fuels === "object" && fuels !== null) {
        fuels = Object.entries(fuels).map(([k, v]) => ({
          name: k,
          price: typeof v === "number" ? v : v?.cena || v?.price || 0,
        }));
      } else {
        fuels = [];
      }
    }
    const normalizedFuels = fuels.map((f) => ({
      name: f.nazev || f.nazevCs || f.name || f.produkt || f.fuel || f.typ || f.druh || "Neznámé",
      price: f.cena || f.price || f.cenaBezSlevy || f.cenaSDph || f.value || f.amount || 0,
      discountPrice: f.cenaSeSlevou || f.cenaSleva || f.discountPrice || f.slevovaCena || null,
      unit: f.jednotka || f.unit || "Kč/l",
    }));
    return { id, name, address: addr, city, region, zip, lat, lng, fuels: normalizedFuels, raw: s };
  });
}

function extractPrices(raw) {
  if (!raw) return [];
  const arrays = findArrays(raw);
  const candidates = arrays
    .filter((a) => a.length > 0 && typeof a[0] === "object")
    .sort((a, b) => b.length - a.length);
  return candidates[0] || [];
}

// Merge prices into stations if they come from separate endpoints
function mergeData(stations, prices) {
  if (!prices || prices.length === 0) return stations;
  // Try to match by station id/code
  const priceMap = {};
  prices.forEach((p) => {
    const key = p.stanice || p.stationId || p.id || p.kod || p.code;
    if (key) {
      if (!priceMap[key]) priceMap[key] = [];
      priceMap[key].push(p);
    }
  });
  if (Object.keys(priceMap).length === 0) return stations;
  return stations.map((s) => {
    const extra = priceMap[s.id] || [];
    if (extra.length > 0 && s.fuels.length === 0) {
      s.fuels = extra.map((e) => ({
        name: e.nazev || e.produkt || e.name || "Neznámé",
        price: e.cena || e.price || 0,
        discountPrice: e.cenaSeSlevou || e.slevovaCena || null,
        unit: e.jednotka || "Kč/l",
      }));
    }
    return s;
  });
}

// ─── Components ─────────────────────────────────────────

function Loader() {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "80px 20px", gap: 16 }}>
      <div style={{
        width: 48, height: 48, border: "3px solid #e2e8f0", borderTopColor: "#d97706",
        borderRadius: "50%", animation: "spin 0.8s linear infinite"
      }} />
      <p style={{ color: "#64748b", fontSize: 14, fontFamily: "'DM Sans', sans-serif" }}>Načítám data z EuroOil API…</p>
      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
    </div>
  );
}

function ErrorBox({ message, onRetry }) {
  return (
    <div style={{
      margin: "40px auto", maxWidth: 500, padding: 32, borderRadius: 16,
      background: "#fef2f2", border: "1px solid #fecaca", textAlign: "center",
      fontFamily: "'DM Sans', sans-serif"
    }}>
      <div style={{ fontSize: 40, marginBottom: 12 }}>⚠️</div>
      <h3 style={{ color: "#991b1b", margin: "0 0 8px", fontSize: 16, fontWeight: 600 }}>Chyba při načítání</h3>
      <p style={{ color: "#b91c1c", fontSize: 13, margin: "0 0 16px", lineHeight: 1.5 }}>{message}</p>
      <button onClick={onRetry} style={{
        background: "#dc2626", color: "#fff", border: "none", padding: "10px 24px",
        borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: 600
      }}>Zkusit znovu</button>
    </div>
  );
}

function FuelBadge({ fuel }) {
  const m = matchFuel(fuel.name);
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 10,
      padding: "8px 12px", borderRadius: 10,
      background: m.bg, border: `1px solid ${m.color}22`,
      minWidth: 0
    }}>
      <span style={{ fontSize: 16, flexShrink: 0 }}>{m.icon}</span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 12, color: "#64748b", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{fuel.name}</div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
          <span style={{ fontSize: 16, fontWeight: 700, color: m.color, fontFamily: "'Space Mono', monospace" }}>
            {formatPrice(fuel.price)}
          </span>
          {fuel.discountPrice != null && fuel.discountPrice > 0 && (
            <span style={{ fontSize: 12, fontWeight: 600, color: "#16a34a", fontFamily: "'Space Mono', monospace" }}>
              → {formatPrice(fuel.discountPrice)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function StationCard({ station, expanded, onToggle }) {
  const hasFuels = station.fuels.length > 0;
  return (
    <div
      onClick={onToggle}
      style={{
        background: "#fff",
        borderRadius: 14,
        border: expanded ? "2px solid #d97706" : "1px solid #e2e8f0",
        padding: expanded ? "16px" : "14px 16px",
        cursor: "pointer",
        transition: "all 0.2s ease",
        boxShadow: expanded ? "0 8px 30px rgba(217,119,6,0.12)" : "0 1px 3px rgba(0,0,0,0.04)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <h3 style={{
            margin: 0, fontSize: 15, fontWeight: 700, color: "#0f172a",
            fontFamily: "'DM Sans', sans-serif",
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis"
          }}>
            {station.name}
          </h3>
          <p style={{
            margin: "3px 0 0", fontSize: 12, color: "#94a3b8",
            fontFamily: "'DM Sans', sans-serif",
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis"
          }}>
            {[station.address, station.city, station.zip].filter(Boolean).join(", ") || "Adresa nedostupná"}
          </p>
        </div>
        {hasFuels && (
          <div style={{
            flexShrink: 0, display: "flex", alignItems: "center", gap: 4,
            background: "#fef3c7", padding: "4px 10px", borderRadius: 20, marginTop: 2
          }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: "#92400e", fontFamily: "'Space Mono', monospace" }}>
              {station.fuels.length}
            </span>
            <span style={{ fontSize: 11, color: "#a16207" }}>paliv</span>
          </div>
        )}
      </div>

      {!expanded && hasFuels && (
        <div style={{
          display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap"
        }}>
          {station.fuels.slice(0, 3).map((f, i) => {
            const m = matchFuel(f.name);
            return (
              <span key={i} style={{
                fontSize: 12, fontWeight: 600, color: m.color,
                background: m.bg, padding: "3px 8px", borderRadius: 6,
                fontFamily: "'Space Mono', monospace"
              }}>
                {m.icon} {formatPrice(f.price)}
              </span>
            );
          })}
          {station.fuels.length > 3 && (
            <span style={{ fontSize: 11, color: "#94a3b8", alignSelf: "center" }}>
              +{station.fuels.length - 3}
            </span>
          )}
        </div>
      )}

      {expanded && (
        <div style={{ marginTop: 14 }}>
          {hasFuels ? (
            <div style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
              gap: 8,
            }}>
              {station.fuels.map((f, i) => (
                <FuelBadge key={i} fuel={f} />
              ))}
            </div>
          ) : (
            <p style={{ fontSize: 13, color: "#94a3b8", margin: 0 }}>Žádné ceny paliv nejsou k dispozici.</p>
          )}
          {station.region && (
            <div style={{
              marginTop: 10, paddingTop: 10, borderTop: "1px solid #f1f5f9",
              fontSize: 12, color: "#94a3b8",
            }}>
              📍 Kraj: {station.region}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Stats({ stations }) {
  const allFuels = stations.flatMap((s) => s.fuels);
  const fuelTypes = {};
  allFuels.forEach((f) => {
    const key = f.name;
    if (!fuelTypes[key]) fuelTypes[key] = { prices: [], name: key };
    if (f.price > 0) fuelTypes[key].prices.push(f.price);
  });
  const summaries = Object.values(fuelTypes)
    .filter((ft) => ft.prices.length > 0)
    .map((ft) => ({
      name: ft.name,
      min: Math.min(...ft.prices),
      max: Math.max(...ft.prices),
      avg: ft.prices.reduce((a, b) => a + b, 0) / ft.prices.length,
      count: ft.prices.length,
    }))
    .sort((a, b) => b.count - a.count);

  if (summaries.length === 0) return null;

  return (
    <div style={{
      background: "#fff", borderRadius: 14, border: "1px solid #e2e8f0",
      padding: 20, marginBottom: 20,
    }}>
      <h3 style={{
        margin: "0 0 14px", fontSize: 14, fontWeight: 700, color: "#0f172a",
        fontFamily: "'DM Sans', sans-serif",
        display: "flex", alignItems: "center", gap: 8,
      }}>
        <span style={{ fontSize: 18 }}>📊</span> Přehled cen paliv
      </h3>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 10 }}>
        {summaries.map((s) => {
          const m = matchFuel(s.name);
          return (
            <div key={s.name} style={{
              padding: "12px 14px", borderRadius: 10,
              background: `linear-gradient(135deg, ${m.bg}, #fff)`,
              border: `1px solid ${m.color}22`,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
                <span style={{ fontSize: 14 }}>{m.icon}</span>
                <span style={{ fontSize: 12, fontWeight: 600, color: m.color, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#64748b", marginBottom: 4 }}>
                <span>MIN</span><span>PRŮMĚR</span><span>MAX</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontFamily: "'Space Mono', monospace", fontSize: 13, fontWeight: 700 }}>
                <span style={{ color: "#16a34a" }}>{s.min.toFixed(2)}</span>
                <span style={{ color: "#64748b" }}>{s.avg.toFixed(2)}</span>
                <span style={{ color: "#dc2626" }}>{s.max.toFixed(2)}</span>
              </div>
              <div style={{ fontSize: 10, color: "#94a3b8", marginTop: 4, textAlign: "right" }}>
                {s.count} stanic
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DebugPanel({ rawStations, rawPrices }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginBottom: 16 }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          background: "none", border: "1px solid #e2e8f0", padding: "6px 14px",
          borderRadius: 8, cursor: "pointer", fontSize: 11, color: "#94a3b8",
          fontFamily: "'DM Sans', sans-serif",
        }}
      >
        {open ? "Skrýt" : "Zobrazit"} API debug
      </button>
      {open && (
        <div style={{ marginTop: 8 }}>
          <details style={{ marginBottom: 8 }}>
            <summary style={{ cursor: "pointer", fontSize: 12, color: "#64748b" }}>cerpaci-stanice response</summary>
            <pre style={{
              background: "#1e293b", color: "#e2e8f0", padding: 12, borderRadius: 8,
              fontSize: 11, maxHeight: 300, overflow: "auto", whiteSpace: "pre-wrap"
            }}>{JSON.stringify(rawStations, null, 2)}</pre>
          </details>
          <details>
            <summary style={{ cursor: "pointer", fontSize: 12, color: "#64748b" }}>ceniky response</summary>
            <pre style={{
              background: "#1e293b", color: "#e2e8f0", padding: 12, borderRadius: 8,
              fontSize: 11, maxHeight: 300, overflow: "auto", whiteSpace: "pre-wrap"
            }}>{JSON.stringify(rawPrices, null, 2)}</pre>
          </details>
        </div>
      )}
    </div>
  );
}

// ─── Main App ────────────────────────────────────────────

export default function FuelTracker() {
  const [stations, setStations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState("");
  const [fuelFilter, setFuelFilter] = useState("all");
  const [sortBy, setSortBy] = useState("name");
  const [expandedId, setExpandedId] = useState(null);
  const [rawStations, setRawStations] = useState(null);
  const [rawPrices, setRawPrices] = useState(null);
  const [lastUpdate, setLastUpdate] = useState(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = getToken();
      const [stRes, prRes] = await Promise.allSettled([
        fetchWithCorsRetry(`${BASE}/cerpaci-stanice?token=${token}`),
        fetchWithCorsRetry(`${BASE}/ceniky?token=${token}`),
      ]);

      let stData = null;
      let prData = null;

      if (stRes.status === "fulfilled") {
        stData = await stRes.value.json();
        setRawStations(stData);
      }
      if (prRes.status === "fulfilled") {
        prData = await prRes.value.json();
        setRawPrices(prData);
      }

      if (!stData && !prData) {
        throw new Error("Nepodařilo se načíst data z API. Možný CORS problém nebo vypršelý token – zkuste stránku obnovit.");
      }

      let parsed = extractStations(stData);
      const prices = extractPrices(prData);
      const merged = mergeData(parsed, prices);

      // If stations have no fuels but prices have station references, try to build from prices
      if (merged.length === 0 && prices.length > 0) {
        // Prices might be the main data
        const grouped = {};
        prices.forEach((p) => {
          const key = p.stanice || p.stationId || p.id || "unknown";
          if (!grouped[key]) grouped[key] = { id: key, name: p.nazevStanice || p.staniceName || key, fuels: [] };
          grouped[key].fuels.push({
            name: p.nazev || p.produkt || p.name || "Neznámé",
            price: p.cena || p.price || 0,
            discountPrice: p.cenaSeSlevou || null,
            unit: "Kč/l",
          });
        });
        const built = Object.values(grouped).map((g) => ({
          ...g, address: "", city: "", region: "", zip: "", lat: null, lng: null, raw: g,
        }));
        if (built.length > 0) {
          setStations(built);
          setLastUpdate(new Date());
          setLoading(false);
          return;
        }
      }

      setStations(merged);
      setLastUpdate(new Date());
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Collect all fuel type names
  const allFuelTypes = useMemo(() => {
    const set = new Set();
    stations.forEach((s) => s.fuels.forEach((f) => set.add(f.name)));
    return Array.from(set).sort();
  }, [stations]);

  // Filter & sort
  const filtered = useMemo(() => {
    let list = stations;
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.address.toLowerCase().includes(q) ||
          s.city.toLowerCase().includes(q) ||
          s.region.toLowerCase().includes(q) ||
          s.zip.includes(q)
      );
    }
    if (fuelFilter !== "all") {
      list = list.filter((s) => s.fuels.some((f) => f.name === fuelFilter));
    }
    if (sortBy === "name") {
      list = [...list].sort((a, b) => a.name.localeCompare(b.name, "cs"));
    } else if (sortBy === "cheapest") {
      list = [...list].sort((a, b) => {
        const target = fuelFilter !== "all" ? fuelFilter : null;
        const priceA = Math.min(...a.fuels.filter((f) => (!target || f.name === target) && f.price > 0).map((f) => f.price), Infinity);
        const priceB = Math.min(...b.fuels.filter((f) => (!target || f.name === target) && f.price > 0).map((f) => f.price), Infinity);
        return priceA - priceB;
      });
    } else if (sortBy === "expensive") {
      list = [...list].sort((a, b) => {
        const target = fuelFilter !== "all" ? fuelFilter : null;
        const priceA = Math.max(...a.fuels.filter((f) => (!target || f.name === target) && f.price > 0).map((f) => f.price), 0);
        const priceB = Math.max(...b.fuels.filter((f) => (!target || f.name === target) && f.price > 0).map((f) => f.price), 0);
        return priceB - priceA;
      });
    } else if (sortBy === "city") {
      list = [...list].sort((a, b) => (a.city || "").localeCompare(b.city || "", "cs"));
    }
    return list;
  }, [stations, search, fuelFilter, sortBy]);

  return (
    <div style={{
      minHeight: "100vh",
      background: "linear-gradient(180deg, #fdfbf7 0%, #f8f4eb 100%)",
      fontFamily: "'DM Sans', sans-serif",
    }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet" />

      {/* Header */}
      <div style={{
        background: "linear-gradient(135deg, #1c1917 0%, #292524 100%)",
        padding: "28px 20px 24px",
        borderBottom: "3px solid #d97706",
      }}>
        <div style={{ maxWidth: 900, margin: "0 auto" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4 }}>
            <div style={{
              width: 42, height: 42, borderRadius: 12,
              background: "linear-gradient(135deg, #d97706, #f59e0b)",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 22, boxShadow: "0 4px 15px rgba(217,119,6,0.4)"
            }}>⛽</div>
            <div>
              <h1 style={{
                margin: 0, fontSize: 22, fontWeight: 700, color: "#fff",
                letterSpacing: "-0.02em"
              }}>
                EuroOil <span style={{ color: "#f59e0b" }}>Fuel Tracker</span>
              </h1>
              <p style={{ margin: 0, fontSize: 11, color: "#a8a29e", letterSpacing: "0.05em", textTransform: "uppercase" }}>
                Sledování cen pohonných hmot
              </p>
            </div>
          </div>
          {lastUpdate && (
            <div style={{ fontSize: 11, color: "#78716c", marginTop: 8 }}>
              🔄 Aktualizováno: {lastUpdate.toLocaleString("cs-CZ")}
            </div>
          )}
        </div>
      </div>

      {/* Content */}
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "20px 16px 60px" }}>
        {loading ? (
          <Loader />
        ) : error ? (
          <ErrorBox message={error} onRetry={fetchData} />
        ) : (
          <>
            {/* Debug */}
            <DebugPanel rawStations={rawStations} rawPrices={rawPrices} />

            {/* Stats overview */}
            <Stats stations={stations} />

            {/* Controls */}
            <div style={{
              display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 16,
              alignItems: "center"
            }}>
              {/* Search */}
              <div style={{ flex: "1 1 200px", position: "relative" }}>
                <span style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", fontSize: 14, color: "#94a3b8" }}>🔍</span>
                <input
                  type="text"
                  placeholder="Hledat stanici, město, PSČ…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  style={{
                    width: "100%", padding: "10px 12px 10px 36px",
                    borderRadius: 10, border: "1px solid #e2e8f0",
                    fontSize: 13, background: "#fff", outline: "none",
                    fontFamily: "'DM Sans', sans-serif",
                    boxSizing: "border-box",
                  }}
                />
              </div>

              {/* Fuel filter */}
              <select
                value={fuelFilter}
                onChange={(e) => setFuelFilter(e.target.value)}
                style={{
                  padding: "10px 12px", borderRadius: 10, border: "1px solid #e2e8f0",
                  fontSize: 13, background: "#fff", color: "#0f172a", cursor: "pointer",
                  fontFamily: "'DM Sans', sans-serif",
                }}
              >
                <option value="all">Všechna paliva</option>
                {allFuelTypes.map((ft) => (
                  <option key={ft} value={ft}>{ft}</option>
                ))}
              </select>

              {/* Sort */}
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value)}
                style={{
                  padding: "10px 12px", borderRadius: 10, border: "1px solid #e2e8f0",
                  fontSize: 13, background: "#fff", color: "#0f172a", cursor: "pointer",
                  fontFamily: "'DM Sans', sans-serif",
                }}
              >
                <option value="name">Dle názvu</option>
                <option value="cheapest">Nejlevnější</option>
                <option value="expensive">Nejdražší</option>
                <option value="city">Dle města</option>
              </select>

              {/* Refresh */}
              <button
                onClick={fetchData}
                style={{
                  padding: "10px 16px", borderRadius: 10, border: "none",
                  background: "#d97706", color: "#fff", fontSize: 13, fontWeight: 600,
                  cursor: "pointer", fontFamily: "'DM Sans', sans-serif",
                  whiteSpace: "nowrap",
                }}
              >
                🔄 Obnovit
              </button>
            </div>

            {/* Count */}
            <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 12 }}>
              Zobrazeno {filtered.length} z {stations.length} stanic
            </div>

            {/* Station List */}
            {filtered.length === 0 ? (
              <div style={{
                textAlign: "center", padding: "60px 20px", color: "#94a3b8", fontSize: 14,
              }}>
                <div style={{ fontSize: 40, marginBottom: 12 }}>🔍</div>
                Žádné stanice neodpovídají filtru.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {filtered.map((s) => (
                  <StationCard
                    key={s.id}
                    station={s}
                    expanded={expandedId === s.id}
                    onToggle={() => setExpandedId(expandedId === s.id ? null : s.id)}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
