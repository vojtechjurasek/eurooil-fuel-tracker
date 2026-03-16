import React from 'react'
import ReactDOM from 'react-dom/client'
import FuelTracker from './FuelTracker.jsx'

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          minHeight: "100vh",
          background: "linear-gradient(180deg, #fdfbf7 0%, #f8f4eb 100%)",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontFamily: "'DM Sans', sans-serif",
        }}>
          <div style={{
            maxWidth: 500, padding: 32, borderRadius: 16,
            background: "#fef2f2", border: "1px solid #fecaca", textAlign: "center",
          }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>⚠️</div>
            <h3 style={{ color: "#991b1b", margin: "0 0 8px", fontSize: 16, fontWeight: 600 }}>
              Něco se pokazilo
            </h3>
            <p style={{ color: "#b91c1c", fontSize: 13, margin: "0 0 16px", lineHeight: 1.5 }}>
              {this.state.error?.message || "Neočekávaná chyba aplikace."}
            </p>
            <button
              onClick={() => window.location.reload()}
              style={{
                background: "#dc2626", color: "#fff", border: "none", padding: "10px 24px",
                borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: 600,
              }}
            >
              Obnovit stránku
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <FuelTracker />
    </ErrorBoundary>
  </React.StrictMode>,
)
