// ─────────────────────────────────────────────────────────────────────────────
// Founder Executive Dashboard — Production Safety Layer
//
// Single-screen health snapshot. Goal: assess full ecosystem health in < 30 s.
//
// Sections:
//   1. System Safety — kill switches, financial locks, backup status
//   2. Fraud Reserve — balance, coverage, recent events
//   3. Provider Health — each gateway's score
//   4. Live Operations — trades today, volume, queues, settlement
//   5. Quick Actions — link to admin tabs
//
// Auto-refreshes every 30 s.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback } from "react";
import {
  Shield, ShieldAlert, Lock, Wallet, Activity,
  AlertTriangle, CheckCircle2, RefreshCw, Loader2,
  TrendingUp, Users, Zap, Server, Database,
  AlertOctagon, ArrowRight, Clock,
} from "lucide-react";
import { getSystemSafetyStatus } from "../server-functions/kill-switch";
import { getFraudReserveStatus }  from "../server-functions/fraud-reserve";
import { getMissionControlData }  from "../server-functions/mission-control";

type SafetyData = Awaited<ReturnType<typeof getSystemSafetyStatus>>;
type ReserveData = Awaited<ReturnType<typeof getFraudReserveStatus>>;
type MCData = Awaited<ReturnType<typeof getMissionControlData>>;

function StatusDot({ ok }: { ok: boolean | null }) {
  if (ok === null) return <div className="size-2.5 rounded-full bg-slate-500" />;
  return <div className={`size-2.5 rounded-full ${ok ? "bg-green-400" : "bg-red-400"}`} />;
}

function formatNgn(n: number) {
  if (n >= 1_000_000) return `₦${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `₦${(n / 1_000).toFixed(0)}K`;
  return `₦${n.toLocaleString()}`;
}

function scoreColor(score: number) {
  if (score >= 80) return "#22c55e";
  if (score >= 60) return "#f59e0b";
  return "#ef4444";
}

function timeAgo(iso: string | null) {
  if (!iso) return "—";
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (m < 1)  return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

interface SectionCardProps {
  title: string;
  icon: typeof Shield;
  status?: "ok" | "warn" | "critical" | "unknown";
  children: React.ReactNode;
}
function SectionCard({ title, icon: Icon, status = "unknown", children }: SectionCardProps) {
  const borderColor = status === "ok" ? "border-green-500/20" : status === "warn" ? "border-amber-500/30" : status === "critical" ? "border-red-500/40" : "border-white/5";
  return (
    <div className={`bg-gradient-card rounded-2xl border ${borderColor} p-4 space-y-3`}>
      <div className="flex items-center gap-2">
        <Icon className={`size-4 ${status === "ok" ? "text-green-400" : status === "warn" ? "text-amber-400" : status === "critical" ? "text-red-400" : "text-muted-foreground"}`} />
        <span className="text-xs font-bold text-white uppercase tracking-wider">{title}</span>
      </div>
      {children}
    </div>
  );
}

export function FounderDashboard() {
  const [safety,   setSafety]   = useState<SafetyData | null>(null);
  const [reserve,  setReserve]  = useState<ReserveData | null>(null);
  const [mc,       setMc]       = useState<MCData | null>(null);
  const [loading,  setLoading]  = useState(true);
  const [lastAt,   setLastAt]   = useState<Date | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, r, m] = await Promise.all([
        getSystemSafetyStatus({ data: {} }),
        getFraudReserveStatus({ data: {} }),
        getMissionControlData({ data: {} }),
      ]);
      setSafety(s);
      setReserve(r);
      setMc(m);
      setLastAt(new Date());
    } catch { /* silent — show stale */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [load]);

  const frozenCount  = safety?.frozenCount ?? 0;
  const reserveStatus = reserve?.status ?? "unknown";
  const overallOk    = frozenCount === 0 && reserveStatus === "healthy" && (safety?.backupOk !== false);

  return (
    <div className="p-4 pb-10 space-y-4 max-w-2xl mx-auto">
      {/* Title + refresh */}
      <div className="flex items-center justify-between pt-2">
        <div>
          <h1 className="text-lg font-extrabold text-white">Founder Dashboard</h1>
          <p className="text-[11px] text-muted-foreground">
            {lastAt ? `Updated ${timeAgo(lastAt.toISOString())}` : "Loading…"}
          </p>
        </div>
        <button onClick={load} disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-secondary rounded-full text-[11px] font-bold text-muted-foreground disabled:opacity-50">
          <RefreshCw className={`size-3 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {/* Overall status banner */}
      <div className={`rounded-2xl p-4 flex items-center gap-3 border ${
        overallOk
          ? "bg-green-500/10 border-green-500/20"
          : "bg-red-500/10 border-red-500/30"
      }`}>
        <div className={`size-3 rounded-full flex-shrink-0 ${overallOk ? "bg-green-400" : "bg-red-400"} shadow-[0_0_8px_currentColor]`} />
        <div>
          <p className="font-bold text-sm text-white">
            {overallOk ? "All Systems Operational" : "Attention Required"}
          </p>
          <p className="text-[11px] text-muted-foreground">
            {frozenCount > 0 ? `${frozenCount} kill switch active · ` : ""}
            {reserveStatus !== "healthy" ? `Fraud reserve ${reserveStatus} · ` : ""}
            {safety?.backupOk === false ? "Backup failure · " : ""}
            {overallOk ? "No issues detected" : "See sections below"}
          </p>
        </div>
      </div>

      {loading && !safety && (
        <div className="flex justify-center py-8">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      )}

      {/* ── 1. System Safety ─────────────────────────────────────────────────── */}
      {safety && (
        <SectionCard
          title="System Safety"
          icon={Shield}
          status={frozenCount > 0 ? "critical" : safety.backupOk === false ? "warn" : "ok"}
        >
          <div className="grid grid-cols-3 gap-2">
            <div className="bg-background/50 rounded-xl p-3 text-center">
              <div className={`text-xl font-extrabold ${frozenCount > 0 ? "text-red-400" : "text-green-400"}`}>
                {frozenCount}
              </div>
              <div className="text-[10px] text-muted-foreground mt-0.5">Kill Switches</div>
            </div>
            <div className="bg-background/50 rounded-xl p-3 text-center">
              <div className="text-xl font-extrabold text-cyan">
                {safety.activeLockCount}
              </div>
              <div className="text-[10px] text-muted-foreground mt-0.5">Active Locks</div>
            </div>
            <div className="bg-background/50 rounded-xl p-3 text-center">
              <div className={`text-xl font-extrabold ${safety.backupOk === false ? "text-red-400" : safety.backupOk === true ? "text-green-400" : "text-slate-400"}`}>
                {safety.backupOk === null ? "—" : safety.backupOk ? "✓" : "✗"}
              </div>
              <div className="text-[10px] text-muted-foreground mt-0.5">Backup</div>
            </div>
          </div>

          {/* Frozen switch list */}
          {frozenCount > 0 && (
            <div className="space-y-1">
              {safety.killSwitches.filter(ks => ks.frozen).map(ks => (
                <div key={ks.key} className="flex items-center gap-2 bg-red-500/10 rounded-xl px-3 py-2">
                  <ShieldAlert className="size-3 text-red-400 flex-shrink-0" />
                  <span className="text-[11px] text-red-300 font-semibold">{ks.label} — FROZEN</span>
                  <span className="ml-auto text-[10px] text-red-400/60">{timeAgo(ks.updatedAt)}</span>
                </div>
              ))}
            </div>
          )}

          {/* Active locks detail */}
          {safety.activeLockCount > 0 && (
            <div className="space-y-1">
              {safety.activeLocks.slice(0, 3).map(l => (
                <div key={l.lock_key} className="flex items-center gap-2 bg-cyan/5 rounded-xl px-3 py-2">
                  <Lock className="size-3 text-cyan flex-shrink-0" />
                  <span className="text-[11px] text-cyan/80 font-mono truncate">{l.lock_key}</span>
                  <span className="ml-auto text-[10px] text-muted-foreground flex-shrink-0">{timeAgo(l.locked_at)}</span>
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      )}

      {/* ── 2. Fraud Reserve ─────────────────────────────────────────────────── */}
      {reserve && (
        <SectionCard
          title="Fraud Reserve"
          icon={Wallet}
          status={reserve.status === "healthy" ? "ok" : reserve.status === "warning" ? "warn" : "critical"}
        >
          <div className="flex items-end gap-4">
            <div>
              <div className={`text-2xl font-extrabold ${
                reserve.status === "critical" ? "text-red-400" :
                reserve.status === "warning"  ? "text-amber-400" : "text-green-400"
              }`}>
                {formatNgn(reserve.balanceNgn)}
              </div>
              <div className="text-[11px] text-muted-foreground">Current Balance</div>
            </div>
            <div className="text-right flex-1">
              <div className="text-sm font-bold text-white">
                {reserve.coverageMonths >= 12 ? ">12" : reserve.coverageMonths.toFixed(1)} mo
              </div>
              <div className="text-[11px] text-muted-foreground">Coverage</div>
            </div>
          </div>

          {/* Reserve health bar */}
          <div className="h-2 bg-white/10 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all"
              style={{
                width:      `${Math.min(100, (reserve.coverageMonths / 3) * 100)}%`,
                background: reserve.status === "critical" ? "#ef4444" : reserve.status === "warning" ? "#f59e0b" : "#22c55e",
              }}
            />
          </div>

          <div className="flex items-center justify-between text-[10px] text-muted-foreground">
            <span>Avg monthly loss: {formatNgn(reserve.avgMonthlyLossNgn)}</span>
            <span className={`font-bold uppercase ${
              reserve.status === "critical" ? "text-red-400" :
              reserve.status === "warning"  ? "text-amber-400" : "text-green-400"
            }`}>{reserve.status}</span>
          </div>
        </SectionCard>
      )}

      {/* ── 3. Provider Health ────────────────────────────────────────────────── */}
      {mc && (
        <SectionCard
          title="Provider Health"
          icon={Server}
          status={
            mc.providerHealth?.some((p: { healthScore: number }) => p.healthScore < 50) ? "critical" :
            mc.providerHealth?.some((p: { healthScore: number }) => p.healthScore < 70) ? "warn" : "ok"
          }
        >
          <div className="space-y-2">
            {(mc.providerHealth ?? []).slice(0, 6).map((p: { provider: string; gateway: string; healthScore: number; status: string; callsLast1h: number }) => (
              <div key={p.provider} className="flex items-center gap-3">
                <div className="w-24 text-[11px] text-white font-semibold capitalize truncate">{p.provider}</div>
                <div className="flex-1 h-1.5 bg-white/10 rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${p.healthScore}%`, background: scoreColor(p.healthScore) }}
                  />
                </div>
                <div className="w-8 text-right text-[11px] font-bold" style={{ color: scoreColor(p.healthScore) }}>
                  {p.healthScore}
                </div>
                <div className="text-[10px] text-muted-foreground w-12 text-right">
                  {p.callsLast1h}r/1h
                </div>
              </div>
            ))}
          </div>
        </SectionCard>
      )}

      {/* ── 4. Live Operations ───────────────────────────────────────────────── */}
      {mc && (
        <SectionCard title="Live Operations" icon={Activity} status="ok">
          <div className="grid grid-cols-2 gap-2">
            {[
              { label: "Today's Volume", value: `₦${((mc.volumeToday ?? 0) / 1_000_000).toFixed(1)}M`, icon: TrendingUp },
              { label: "Trades Today",   value: mc.tradesToday ?? 0,   icon: Zap },
              { label: "Pending KYC",    value: mc.kycPending ?? 0,    icon: Users },
              { label: "Manual Review",  value: mc.manualReview ?? 0,  icon: AlertTriangle },
              { label: "Active Vendors", value: mc.activeVendors ?? 0, icon: Users },
              { label: "Risk Events",    value: mc.criticalRisk ?? 0,  icon: AlertOctagon },
            ].map(({ label, value, icon: Icon }) => (
              <div key={label} className="bg-background/50 rounded-xl p-3 flex items-center gap-2">
                <Icon className="size-3.5 text-muted-foreground flex-shrink-0" />
                <div>
                  <div className="text-sm font-bold text-white">{value}</div>
                  <div className="text-[10px] text-muted-foreground">{label}</div>
                </div>
              </div>
            ))}
          </div>
        </SectionCard>
      )}

      {/* ── 5. Backup Status ─────────────────────────────────────────────────── */}
      {safety && (
        <SectionCard
          title="Data Integrity"
          icon={Database}
          status={safety.backupOk === false ? "critical" : safety.backupOk === true ? "ok" : "unknown"}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <StatusDot ok={safety.backupOk} />
              <span className="text-[12px] text-white">
                {safety.backupOk === null  ? "Backup status unknown" :
                 safety.backupOk          ? "Backup verified"        : "Backup verification failed"}
              </span>
            </div>
            <span className="text-[10px] text-muted-foreground">
              {safety.lastBackupCheck ? `Checked ${timeAgo(safety.lastBackupCheck)}` : "Never checked"}
            </span>
          </div>
        </SectionCard>
      )}

      {/* Footer note */}
      <p className="text-center text-[10px] text-muted-foreground pb-2">
        Auto-refreshes every 30 s · 7SEVEN CARDS Production Safety Layer
      </p>
    </div>
  );
}
