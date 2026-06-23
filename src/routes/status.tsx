// ─────────────────────────────────────────────────────────────────────────────
// Public Status Page — Phase 18
//
// Accessible at: 7evencards.xyz/status (no auth required)
// Shows real-time system health from /api/health
// Displays: Operational | Partial Degradation | Outage per service
// ─────────────────────────────────────────────────────────────────────────────

import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

export const Route = createFileRoute("/status")({
  component: StatusPage,
});

interface HealthData {
  ok: boolean;
  ts: number;
  release: string | null;
  critical: Record<string, boolean>;
  optional: Record<string, boolean>;
  db: { ok: boolean; latencyMs: number | null; error: string | null };
}

type ServiceStatus = "operational" | "degraded" | "outage";

interface ServiceRow {
  key: string;
  name: string;
  status: ServiceStatus;
  latencyMs?: number | null;
  required: boolean;
}

const SERVICE_LABELS: Record<string, string> = {
  supabase:       "Database & Auth",
  squadco:        "Payment Gateway (Squad)",
  reloadly:       "Gift Card Network",
  busha:          "Crypto Gateway",
  onesignal:      "Push Notifications",
  app_secret:     "Application Security",
  cron:           "Scheduled Tasks",
  telegram:       "Vendor Telegram Bot",
  admin_telegram: "Admin Telegram Bot",
  resend:         "Email (Transactional)",
  dojah:          "KYC — Dojah",
  mono:           "KYC & Payments — Mono",
  sentry:         "Error Monitoring",
};

function getStatusColor(status: ServiceStatus): string {
  if (status === "operational") return "#22c55e";
  if (status === "degraded")    return "#f59e0b";
  return "#ef4444";
}

function getStatusLabel(status: ServiceStatus): string {
  if (status === "operational") return "Operational";
  if (status === "degraded")    return "Degraded";
  return "Outage";
}

function getOverallStatus(services: ServiceRow[]): ServiceStatus {
  const required = services.filter(s => s.required);
  if (required.some(s => s.status === "outage"))   return "outage";
  if (services.some(s => s.status !== "operational")) return "degraded";
  return "operational";
}

export default function StatusPage() {
  const [health, setHealth]       = useState<HealthData | null>(null);
  const [loading, setLoading]     = useState(true);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);
  const [error, setError]         = useState<string | null>(null);

  async function fetchHealth() {
    setLoading(true);
    setError(null);
    try {
      const res  = await fetch("/api/health");
      const data = await res.json() as HealthData;
      setHealth(data);
      setLastChecked(new Date());
    } catch (e) {
      setError("Could not reach health endpoint. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchHealth();
    const interval = setInterval(fetchHealth, 60_000);  // auto-refresh every 60s
    return () => clearInterval(interval);
  }, []);

  const services: ServiceRow[] = health
    ? [
        ...Object.entries(health.critical).map(([key, ok]) => ({
          key,
          name:     SERVICE_LABELS[key] ?? key,
          status:   (ok ? "operational" : "outage") as ServiceStatus,
          required: true,
          latencyMs: key === "supabase" ? health.db.latencyMs : undefined,
        })),
        ...Object.entries(health.optional).map(([key, ok]) => ({
          key,
          name:     SERVICE_LABELS[key] ?? key,
          status:   (ok ? "operational" : "degraded") as ServiceStatus,
          required: false,
        })),
      ]
    : [];

  const overall = health ? getOverallStatus(services) : null;

  return (
    <div style={{
      minHeight: "100vh",
      background: "#0f172a",
      color: "#f1f5f9",
      fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
    }}>
      {/* Header */}
      <div style={{
        background: "#1e293b",
        borderBottom: "1px solid #334155",
        padding: "20px 24px",
        display: "flex",
        alignItems: "center",
        gap: "12px",
      }}>
        <div style={{ fontSize: "24px", fontWeight: 700, color: "#f59e0b" }}>
          7SEVEN CARDS
        </div>
        <div style={{ color: "#94a3b8", fontSize: "14px" }}>
          System Status
        </div>
      </div>

      <div style={{ maxWidth: 760, margin: "0 auto", padding: "40px 24px" }}>
        {/* Overall status banner */}
        {overall && (
          <div style={{
            background: overall === "operational" ? "#064e3b" : overall === "degraded" ? "#451a03" : "#450a0a",
            border: `1px solid ${getStatusColor(overall)}30`,
            borderRadius: 12,
            padding: "24px",
            marginBottom: 32,
            display: "flex",
            alignItems: "center",
            gap: 16,
          }}>
            <div style={{
              width: 16,
              height: 16,
              borderRadius: "50%",
              background: getStatusColor(overall),
              flexShrink: 0,
              boxShadow: `0 0 8px ${getStatusColor(overall)}`,
            }} />
            <div>
              <div style={{ fontSize: 20, fontWeight: 700 }}>
                {overall === "operational" && "All Systems Operational"}
                {overall === "degraded"    && "Partial Service Degradation"}
                {overall === "outage"      && "Service Outage"}
              </div>
              <div style={{ fontSize: 13, color: "#94a3b8", marginTop: 4 }}>
                {lastChecked && `Last checked ${lastChecked.toLocaleTimeString()}`}
                {health?.release && <span style={{ marginLeft: 12, opacity: 0.6 }}>v{health.release.slice(0, 7)}</span>}
              </div>
            </div>
          </div>
        )}

        {loading && !health && (
          <div style={{ textAlign: "center", color: "#94a3b8", padding: "60px 0" }}>
            Checking system status…
          </div>
        )}

        {error && (
          <div style={{
            background: "#450a0a",
            border: "1px solid #ef444430",
            borderRadius: 8,
            padding: "16px",
            marginBottom: 24,
            color: "#fca5a5",
          }}>
            {error}
          </div>
        )}

        {/* Core services */}
        {services.filter(s => s.required).length > 0 && (
          <section style={{ marginBottom: 32 }}>
            <h2 style={{ fontSize: 13, fontWeight: 600, color: "#64748b", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 12 }}>
              Core Services
            </h2>
            <div style={{ border: "1px solid #1e293b", borderRadius: 10, overflow: "hidden" }}>
              {services.filter(s => s.required).map((svc, i) => (
                <ServiceRow key={svc.key} svc={svc} first={i === 0} />
              ))}
            </div>
          </section>
        )}

        {/* Optional services */}
        {services.filter(s => !s.required).length > 0 && (
          <section style={{ marginBottom: 32 }}>
            <h2 style={{ fontSize: 13, fontWeight: 600, color: "#64748b", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 12 }}>
              Supporting Services
            </h2>
            <div style={{ border: "1px solid #1e293b", borderRadius: 10, overflow: "hidden" }}>
              {services.filter(s => !s.required).map((svc, i) => (
                <ServiceRow key={svc.key} svc={svc} first={i === 0} />
              ))}
            </div>
          </section>
        )}

        {/* Refresh button */}
        <div style={{ textAlign: "center" }}>
          <button
            onClick={fetchHealth}
            disabled={loading}
            style={{
              background: "#1e293b",
              border: "1px solid #334155",
              color: "#94a3b8",
              padding: "8px 20px",
              borderRadius: 6,
              cursor: loading ? "not-allowed" : "pointer",
              fontSize: 13,
            }}
          >
            {loading ? "Checking…" : "↻ Refresh"}
          </button>
        </div>

        {/* Footer */}
        <div style={{ textAlign: "center", marginTop: 48, color: "#475569", fontSize: 12 }}>
          <p>
            <a href="https://7evencards.xyz" style={{ color: "#f59e0b", textDecoration: "none" }}>
              7evencards.xyz
            </a>
            {" "}·{" "}
            <a href="mailto:support@7evencards.xyz" style={{ color: "#64748b", textDecoration: "none" }}>
              support@7evencards.xyz
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}

function ServiceRow({ svc, first }: { svc: ServiceRow; first: boolean }) {
  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "14px 18px",
      background: "#1e293b",
      borderTop: first ? "none" : "1px solid #0f172a",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: getStatusColor(svc.status),
          flexShrink: 0,
        }} />
        <span style={{ fontSize: 14 }}>{svc.name}</span>
        {svc.latencyMs !== undefined && svc.latencyMs !== null && (
          <span style={{ fontSize: 12, color: "#64748b", marginLeft: 4 }}>
            {svc.latencyMs}ms
          </span>
        )}
      </div>
      <span style={{
        fontSize: 12,
        fontWeight: 600,
        color: getStatusColor(svc.status),
        background: `${getStatusColor(svc.status)}18`,
        padding: "3px 10px",
        borderRadius: 99,
      }}>
        {getStatusLabel(svc.status)}
      </span>
    </div>
  );
}
