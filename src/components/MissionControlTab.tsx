// ─────────────────────────────────────────────────────────────────────────────
// Mission Control Tab — Phases 4 & 5
//
// Executive command center for 7SEVEN CARDS admin.
// Auto-refreshes every 30 seconds.
// Displays: users, trades, volume, queues, vendors, settlements, risk, events.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback } from "react";
import {
  Users, TrendingUp, DollarSign, AlertTriangle,
  CheckCircle2, Clock, Activity, Shield,
  Zap, RefreshCw, Building2, BarChart3,
  AlertOctagon, Loader2, CircleDot, ArrowUpRight,
} from "lucide-react";
import { getMissionControlData } from "../server-functions/mission-control";

type MCData = Awaited<ReturnType<typeof getMissionControlData>>;

// ── Formatting helpers ────────────────────────────────────────────────────────
function formatNgn(n: number) {
  if (n >= 1_000_000) return `₦${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `₦${(n / 1_000).toFixed(1)}K`;
  return `₦${n.toLocaleString()}`;
}
function formatUsd(n: number) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}
function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1)  return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const EVENT_LABELS: Record<string, string> = {
  TradeCreated:          "Trade created",
  TradeCompleted:        "Trade completed",
  TradeAssigned:         "Trade assigned",
  UserVerified:          "KYC verified",
  UserRegistered:        "New user",
  VendorApproved:        "Vendor approved",
  VendorSuspended:       "Vendor suspended",
  FraudDetected:         "⛔ Fraud detected",
  SettlementCompleted:   "Settlement done",
  SettlementFailed:      "Settlement failed",
  WalletCredited:        "Wallet credited",
  ReconciliationRun:     "Reconciliation ran",
  FeatureFlagChanged:    "Flag toggled",
};

// ── Sub-components ────────────────────────────────────────────────────────────

function MCCard({ children, urgent }: { children: React.ReactNode; urgent?: boolean }) {
  return (
    <div className={`bg-gradient-card rounded-2xl border ${urgent ? "border-red-500/30" : "border-white/5"} p-4`}>
      {children}
    </div>
  );
}

function BigMetric({ icon: Icon, label, value, sub, color }: {
  icon: typeof Users; label: string; value: string; sub?: string; color: string;
}) {
  return (
    <div className="bg-gradient-card rounded-2xl border border-white/5 p-4 flex flex-col gap-1">
      <div className="flex items-center gap-2 mb-1">
        <Icon className={`size-4 ${color}`} />
        <span className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wide">{label}</span>
      </div>
      <p className={`text-xl font-extrabold ${color}`}>{value}</p>
      {sub && <p className="text-[10px] text-muted-foreground">{sub}</p>}
    </div>
  );
}

function QueueRow({ icon: Icon, label, count, color, urgent }: {
  icon: typeof Clock; label: string; count: number; color: string; urgent?: boolean;
}) {
  return (
    <div className={`flex items-center justify-between px-4 py-3 ${urgent ? "bg-red-500/5" : ""}`}>
      <div className="flex items-center gap-3">
        <Icon className={`size-4 ${urgent && count > 0 ? "text-red-400" : color}`} />
        <span className="text-sm font-semibold">{label}</span>
      </div>
      <span className={`text-sm font-bold tabular-nums ${urgent && count > 0 ? "text-red-400" : count > 0 ? color : "text-muted-foreground"}`}>
        {count}
      </span>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export function MissionControlTab() {
  const [data, setData]       = useState<MCData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const d = await getMissionControlData({ data: {} });
      setData(d);
      setLastRefresh(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load mission control data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, [load]);

  if (!data && loading) {
    return (
      <div className="flex justify-center items-center py-20">
        <Loader2 className="size-7 animate-spin text-cyan" />
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="px-5 py-10 text-center">
        <p className="text-sm text-red-400 mb-3">{error}</p>
        <button onClick={load} className="text-xs text-cyan underline">Retry</button>
      </div>
    );
  }

  if (!data) return null;

  const totalQueueItems = data.queues.kycPending + data.queues.manualReview + data.queues.escrow;
  const hasRiskAlerts   = data.risk.critical + data.risk.high > 0;
  const hasSettlementIssue = data.settlement.unreconciled > 0;

  return (
    <div className="px-4 pt-4 pb-12 space-y-5">

      {/* ── Status bar ── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <CircleDot className={`size-3.5 ${loading ? "text-gold animate-pulse" : "text-green-400"}`} />
          <span className="text-xs text-muted-foreground">
            {loading ? "Refreshing…" : lastRefresh ? `Updated ${lastRefresh.toLocaleTimeString()}` : ""}
          </span>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-1.5 text-xs text-muted-foreground py-1.5 px-3 rounded-lg bg-secondary"
        >
          <RefreshCw className={`size-3 ${loading ? "animate-spin" : ""}`} /> Refresh
        </button>
      </div>

      {/* ── ALERT BANNER — risk / settlement issues ── */}
      {(hasRiskAlerts || hasSettlementIssue) && (
        <div className="rounded-2xl border border-red-500/30 bg-red-500/5 p-4 space-y-1.5">
          <div className="flex items-center gap-2 text-red-400 font-bold text-sm">
            <AlertOctagon className="size-4" /> Attention Required
          </div>
          {data.risk.critical > 0 && (
            <p className="text-xs text-red-300">⛔ {data.risk.critical} CRITICAL risk entity/ies flagged</p>
          )}
          {data.risk.high > 0 && (
            <p className="text-xs text-orange-300">⚠️ {data.risk.high} HIGH risk entity/ies active</p>
          )}
          {hasSettlementIssue && (
            <p className="text-xs text-yellow-300">
              💰 {data.settlement.unreconciled} unreconciled trade(s) — {formatNgn(data.settlement.unreconciledNgn)} outstanding
            </p>
          )}
        </div>
      )}

      {/* ── USERS ── */}
      <section>
        <SectionHeader icon={Users} label="Users" />
        <div className="grid grid-cols-2 gap-3">
          <BigMetric icon={Users}       label="Total Users"    value={data.users.total.toLocaleString()}       color="text-cyan" />
          <BigMetric icon={Activity}    label="Active Today"   value={data.users.dailyActive.toLocaleString()} color="text-green-400" sub="sessions updated today" />
          <BigMetric icon={ArrowUpRight} label="New Today"     value={data.users.newToday.toLocaleString()}    color="text-cyan" />
          <BigMetric icon={Shield}      label="KYC Verified"   value={data.users.kycVerified.toLocaleString()} color="text-gold" />
        </div>
      </section>

      {/* ── TRADES ── */}
      <section>
        <SectionHeader icon={TrendingUp} label="Trade Activity" />
        <div className="grid grid-cols-3 gap-2 mb-2">
          <MiniStat label="Pending"    value={data.trades.pending}    color="text-gold" />
          <MiniStat label="Processing" value={data.trades.processing} color="text-cyan" />
          <MiniStat label="Paid"       value={data.trades.paid}       color="text-green-400" />
          <MiniStat label="Failed"     value={data.trades.failed}     color="text-red-400" />
          <MiniStat label="Today"      value={data.trades.today}      color="text-cyan" />
          <MiniStat label="This Week"  value={data.trades.thisWeek}   color="text-muted-foreground" />
        </div>
      </section>

      {/* ── VOLUME ── */}
      <section>
        <SectionHeader icon={DollarSign} label="Trade Volume" />
        <div className="grid grid-cols-2 gap-3">
          <BigMetric icon={DollarSign} label="Today (NGN)"   value={formatNgn(data.volume.todayNgn)}   color="text-green-400" sub={formatUsd(data.volume.todayUsd)} />
          <BigMetric icon={DollarSign} label="This Month"    value={formatNgn(data.volume.monthNgn)}   color="text-cyan"      sub={formatUsd(data.volume.monthUsd)} />
          <BigMetric icon={BarChart3}  label="All-Time NGN"  value={formatNgn(data.volume.allTimeNgn)} color="text-gold"      sub={formatUsd(data.volume.allTimeUsd)} />
          <BigMetric icon={CheckCircle2} label="Unreconciled" value={formatNgn(data.settlement.unreconciledNgn)} color={data.settlement.unreconciled > 0 ? "text-red-400" : "text-muted-foreground"} sub={`${data.settlement.unreconciled} trade(s)`} />
        </div>
      </section>

      {/* ── ACTION QUEUES ── */}
      <section>
        <SectionHeader icon={Clock} label="Action Queues" />
        <MCCard urgent={totalQueueItems > 5}>
          <div className="divide-y divide-white/5">
            <QueueRow icon={Shield}       label="KYC Pending"    count={data.queues.kycPending}   color="text-gold"       urgent={data.queues.kycPending > 0} />
            <QueueRow icon={AlertTriangle} label="Manual Review"  count={data.queues.manualReview} color="text-orange-400" urgent={data.queues.manualReview > 0} />
            <QueueRow icon={DollarSign}   label="Escrow / Payout" count={data.queues.escrow}       color="text-cyan"       urgent={data.queues.escrow > 3} />
            <QueueRow icon={Users}        label="Support"         count={data.queues.support}      color="text-purple-400" />
          </div>
        </MCCard>
      </section>

      {/* ── VENDORS ── */}
      <section>
        <SectionHeader icon={Building2} label="Vendors" />
        <div className="grid grid-cols-2 gap-3 mb-3">
          <BigMetric icon={CheckCircle2}   label="Active"    value={data.vendors.active.toLocaleString()}    color="text-green-400" />
          <BigMetric icon={AlertTriangle}  label="Suspended" value={data.vendors.suspended.toLocaleString()} color="text-red-400" />
        </div>
        {data.vendors.top.length > 0 && (
          <MCCard>
            <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wide mb-3">Top Vendors by Score</p>
            <div className="space-y-2">
              {data.vendors.top.map((v, i) => (
                <div key={v.id} className="flex items-center justify-between">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-[10px] text-muted-foreground w-4 shrink-0">{i + 1}.</span>
                    <span className="text-xs font-semibold truncate">{v.business_name}</span>
                    <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full capitalize shrink-0
                      ${v.performance_tier === "platinum" ? "bg-cyan/15 text-cyan"
                      : v.performance_tier === "gold"     ? "bg-gold/15 text-gold"
                      : v.performance_tier === "silver"   ? "bg-white/10 text-white/70"
                      : "bg-orange-500/10 text-orange-400"}`}>
                      {v.performance_tier}
                    </span>
                  </div>
                  <span className="text-xs font-bold text-green-400 shrink-0">
                    {Number(v.performance_score).toFixed(0)}
                  </span>
                </div>
              ))}
            </div>
          </MCCard>
        )}
      </section>

      {/* ── RISK & FRAUD ── */}
      <section>
        <SectionHeader icon={AlertOctagon} label="Risk & Fraud" />
        <div className="grid grid-cols-2 gap-3 mb-3">
          <BigMetric icon={AlertOctagon} label="Critical Risk" value={data.risk.critical.toString()} color={data.risk.critical > 0 ? "text-red-400" : "text-muted-foreground"} />
          <BigMetric icon={AlertTriangle} label="High Risk"    value={data.risk.high.toString()}     color={data.risk.high > 0 ? "text-orange-400" : "text-muted-foreground"} />
        </div>
        {data.risk.fraudEvents.length > 0 && (
          <MCCard urgent>
            <p className="text-[10px] font-bold text-red-400 uppercase tracking-wide mb-3">Recent Fraud Events</p>
            <div className="space-y-2">
              {data.risk.fraudEvents.map((e, i) => (
                <div key={i} className="flex items-center justify-between">
                  <div className="flex items-center gap-2 min-w-0">
                    <AlertOctagon className="size-3 text-red-400 shrink-0" />
                    <span className="text-xs text-red-300 truncate">
                      {(e.payload?.verdict as string) ?? "fraud"} — {e.entity_id.slice(0, 8)}
                    </span>
                  </div>
                  <span className="text-[10px] text-muted-foreground shrink-0">{timeAgo(e.occurred_at)}</span>
                </div>
              ))}
            </div>
          </MCCard>
        )}
      </section>

      {/* ── RECONCILIATION ── */}
      {data.reconciliation && (
        <section>
          <SectionHeader icon={CheckCircle2} label="Last Reconciliation" />
          <MCCard urgent={data.reconciliation.total_issues > 0}>
            <div className="flex items-center justify-between mb-2">
              <span className={`text-xs font-bold px-2 py-1 rounded-full capitalize
                ${data.reconciliation.status === "completed" ? "bg-green-500/15 text-green-400"
                : data.reconciliation.status === "partial"   ? "bg-gold/15 text-gold"
                : "bg-red-500/15 text-red-400"}`}>
                {data.reconciliation.status}
              </span>
              <span className="text-[10px] text-muted-foreground">{timeAgo(data.reconciliation.started_at)}</span>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div>
                <span className="text-muted-foreground">Issues</span>
                <span className={`ml-2 font-bold ${data.reconciliation.total_issues > 0 ? "text-red-400" : "text-green-400"}`}>
                  {data.reconciliation.total_issues}
                </span>
              </div>
              <div>
                <span className="text-muted-foreground">Unreconciled</span>
                <span className="ml-2 font-bold">{data.reconciliation.unreconciled_trades}</span>
              </div>
            </div>
          </MCCard>
        </section>
      )}

      {/* ── LIVE EVENT FEED ── */}
      {data.recentEvents.length > 0 && (
        <section>
          <SectionHeader icon={Zap} label="Live Event Feed" />
          <MCCard>
            <div className="space-y-2.5">
              {data.recentEvents.map((e) => (
                <div key={e.id} className="flex items-center gap-3">
                  <div className={`size-1.5 rounded-full shrink-0
                    ${e.event_type.includes("Fraud")     ? "bg-red-400"
                    : e.event_type.includes("Failed")    ? "bg-red-400"
                    : e.event_type.includes("Completed") ? "bg-green-400"
                    : e.event_type.includes("Created")   ? "bg-cyan"
                    : "bg-muted-foreground/40"}`} />
                  <span className="text-xs text-foreground/80 flex-1 truncate">
                    {EVENT_LABELS[e.event_type] ?? e.event_type}
                  </span>
                  <span className="text-[10px] text-muted-foreground shrink-0">{timeAgo(e.occurred_at)}</span>
                </div>
              ))}
            </div>
          </MCCard>
        </section>
      )}

    </div>
  );
}

// ── Small helpers ─────────────────────────────────────────────────────────────
function SectionHeader({ icon: Icon, label }: { icon: typeof Users; label: string }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <Icon className="size-3.5 text-muted-foreground" />
      <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">{label}</p>
    </div>
  );
}

function MiniStat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="bg-gradient-card rounded-xl border border-white/5 p-3 text-center">
      <p className={`text-base font-extrabold tabular-nums ${color}`}>{value.toLocaleString()}</p>
      <p className="text-[9px] text-muted-foreground mt-0.5">{label}</p>
    </div>
  );
}
