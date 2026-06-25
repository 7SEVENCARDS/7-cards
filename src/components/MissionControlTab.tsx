// ─────────────────────────────────────────────────────────────────────────────
// Mission Control Tab — Executive Command Center
//
// Auto-refreshes every 30 seconds.
// Core metrics: users, trades, volume, queues, vendors, settlement, risk,
//               events, reconciliation, trust, treasury, providerHealth
// BI metrics:   userLtv, vendorLtv, premiumConversion, fraudRate,
//               inventoryVelocity, profitByBrand, regionalPerformance,
//               treasuryVelocity, providerHealth (success rates detail)
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback } from "react";
import {
  Users, TrendingUp, DollarSign, AlertTriangle,
  CheckCircle2, Clock, Activity, Shield,
  Zap, RefreshCw, Building2, BarChart3,
  AlertOctagon, Loader2, CircleDot, ArrowUpRight,
  Crown, Globe, Package, Target, Gauge, Server,
  ShieldAlert, Wallet, Map, Download,
} from "lucide-react";
import { getMissionControlData, triggerWeeklyAnalyticsReport } from "../server-functions/mission-control";
import { getKillSwitchStatus } from "../server-functions/kill-switch";

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
function fmtMins(m: number) {
  if (m < 60)  return `${m}m`;
  if (m < 1440) return `${(m / 60).toFixed(1)}h`;
  return `${(m / 1440).toFixed(1)}d`;
}

const EVENT_LABELS: Record<string, string> = {
  TradeCreated:        "Trade created",
  TradeCompleted:      "Trade completed",
  TradeAssigned:       "Trade assigned",
  UserVerified:        "KYC verified",
  UserRegistered:      "New user",
  VendorApproved:      "Vendor approved",
  VendorSuspended:     "Vendor suspended",
  FraudDetected:       "Fraud detected",
  SettlementCompleted: "Settlement done",
  SettlementFailed:    "Settlement failed",
  WalletCredited:      "Wallet credited",
  ReconciliationRun:   "Reconciliation ran",
  FeatureFlagChanged:  "Flag toggled",
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

function ProgressBar({ value, max, color = "bg-cyan" }: { value: number; max: number; color?: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
      <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${pct}%` }} />
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export function MissionControlTab() {
  const [data, setData]             = useState<MCData | null>(null);
  const [ksAlert, setKsAlert]       = useState<string[]>([]);
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [sending, setSending]       = useState(false);
  const [sendResult, setSendResult] = useState<{ ok: boolean; label: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const d = await getMissionControlData({ data: {} });
      setData(d);
      getKillSwitchStatus({ data: {} }).then(s => setKsAlert(s.filter(x => x.frozen).map(x => x.label))).catch(() => {});
      setLastRefresh(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load mission control data");
    } finally {
      setLoading(false);
    }
  }, []);

  const handleSendReport = useCallback(async () => {
    setSending(true);
    setSendResult(null);
    try {
      const result = await triggerWeeklyAnalyticsReport({ data: {} });
      setSendResult({
        ok:    result.ok,
        label: result.ok
          ? `Sent to ${result.recipientCount} recipient${result.recipientCount !== 1 ? "s" : ""} + Telegram`
          : "Send failed — check server logs",
      });
    } catch (e) {
      setSendResult({ ok: false, label: e instanceof Error ? e.message : "Send failed" });
    } finally {
      setSending(false);
      setTimeout(() => setSendResult(null), 8_000);
    }
  }, []);

  const handleExportCsv = useCallback(() => {
    if (!data) return;
    const now = new Date().toISOString();
    const rows: string[] = [];

    const cell = (v: string | number) => {
      const s = String(v);
      return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const row = (...cols: (string | number)[]) => rows.push(cols.map(cell).join(","));
    const blank = () => rows.push("");
    const heading = (t: string) => { blank(); rows.push(`# ${t}`); };

    rows.push("# 7SEVEN CARDS — Mission Control Analytics Export");
    rows.push(`# Generated: ${now}`);
    rows.push(`# Data timestamp: ${new Date(data.ts).toISOString()}`);

    heading("PLATFORM SUMMARY");
    row("Metric", "Value");
    row("Total Users", data.users.total);
    row("KYC Verified Users", data.users.kycVerified);
    row("Premium Members", data.users.premium);
    row("New Users Today", data.users.newToday);
    row("Active Today", data.users.dailyActive);
    row("Trades Paid (All-Time)", data.trades.paid);
    row("Trades Failed (All-Time)", data.trades.failed);
    row("Trades Pending", data.trades.pending);
    row("Trades Today", data.trades.today);
    row("Trades This Week", data.trades.thisWeek);
    row("Volume Today (NGN)", data.volume.todayNgn);
    row("Volume Today (USD)", data.volume.todayUsd);
    row("Volume This Month (NGN)", data.volume.monthNgn);
    row("Volume This Month (USD)", data.volume.monthUsd);
    row("Volume All-Time (NGN)", data.volume.allTimeNgn);
    row("Volume All-Time (USD)", data.volume.allTimeUsd);
    row("Unreconciled Trades", data.settlement.unreconciled);
    row("Unreconciled (NGN)", data.settlement.unreconciledNgn);

    if (data.userLtv) {
      heading(`USER LTV (Last ${data.userLtv.windowDays} Days)`);
      row("Metric", "Value");
      row("Average LTV (NGN)", data.userLtv.avgNgn);
      row("Average LTV (USD)", data.userLtv.avgUsd);
      row("Average Trades Per User", data.userLtv.avgTradesPerUser);
      row("Active Paying Users", data.userLtv.activePayingUsers);
    }

    if (data.vendorLtv) {
      heading("VENDOR LTV");
      row("Metric", "Value");
      row("Avg Lifetime Funded (NGN)", data.vendorLtv.avgLifetimeNgn);
      row("Total Funded All-Time (NGN)", data.vendorLtv.totalFundedNgn);
      row("Total Current Balance (NGN)", data.vendorLtv.totalBalanceNgn);
      row("Vendor Count", data.vendorLtv.vendorCount);
    }

    if (data.premiumConversion) {
      heading("PREMIUM CONVERSION");
      row("Metric", "Value");
      row("Premium Members", data.premiumConversion.premiumUsers);
      row("Total Users", data.premiumConversion.totalUsers);
      row("Conversion Rate (%)", data.premiumConversion.conversionRate);
    }

    if (data.fraudRate) {
      heading("FRAUD RATE");
      row("Metric", "Value");
      row("Fraud Events (30d)", data.fraudRate.fraudCount30d);
      row("Total Trades", data.fraudRate.totalTrades);
      row("Fraud Rate (%)", data.fraudRate.ratePct);
      row("Critical Risk Active", data.risk.critical);
      row("High Risk Active", data.risk.high);
    }

    if (data.inventoryVelocity && data.inventoryVelocity.sampleSize > 0) {
      heading("INVENTORY VELOCITY (TRADE → SETTLEMENT)");
      row("Metric", "Value (minutes)");
      row("Average Settlement Time", data.inventoryVelocity.avgMinutes);
      row("Median Settlement Time", data.inventoryVelocity.medianMinutes);
      row("P90 Settlement Time", data.inventoryVelocity.p90Minutes);
      row("Sample Size (trades)", data.inventoryVelocity.sampleSize);
    }

    if (data.treasuryVelocity) {
      heading("TREASURY VELOCITY (Last 24h)");
      row("Metric", "Value");
      row("Total Decisions (24h)", data.treasuryVelocity.totalDecisions24h);
      row("Avg Decisions Per Hour", data.treasuryVelocity.avgDecisionsPerHour);
      row("Buy Rate (%)", data.treasuryVelocity.buyRate24hPct);
      row("Buy Decisions Today", data.treasury.buyDecisionsToday);
      row("Route Decisions Today", data.treasury.vendorRouteToday);
      blank();
      row("Hour", "Total Decisions", "Buy", "Route");
      for (const h of data.treasuryVelocity.hourly) row(h.hour, h.total, h.buy, h.route);
    }

    if (data.profitByBrand && data.profitByBrand.length > 0) {
      heading("PROFIT PER CARD TYPE");
      row("Brand", "Trades", "Total NGN", "Total USD", "Avg NGN per Trade", "Avg Rate (NGN/$)");
      for (const b of data.profitByBrand) row(b.brand, b.count, b.totalNgn, b.totalUsd, b.avgNgnPerTrade, b.avgRateNgn);
    }

    if (data.providerHealth && data.providerHealth.length > 0) {
      heading("PROVIDER SUCCESS RATES (Last 1h)");
      row("Provider", "Success Rate (%)", "Total Calls", "Avg Latency (ms)", "Status");
      for (const p of data.providerHealth) row(p.provider, p.successRate, p.totalCalls, p.avgLatencyMs, p.status);
    }

    if (data.regionalPerformance && data.regionalPerformance.length > 0) {
      heading("REGIONAL PERFORMANCE");
      row("Region", "Trades", "Share (%)", "Total NGN", "Total USD");
      for (const r of data.regionalPerformance) row(r.region, r.count, r.sharePct, r.totalNgn, r.totalUsd);
    }

    heading("QUEUES");
    row("Queue", "Count");
    row("KYC Pending", data.queues.kycPending);
    row("Manual Review", data.queues.manualReview);
    row("Escrow / Payout", data.queues.escrow);
    row("Support Open", data.queues.support);

    const csv = rows.join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `7cards-analytics-${now.slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [data]);

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

  const totalQueueItems    = data.queues.kycPending + data.queues.manualReview + data.queues.escrow;
  const hasRiskAlerts      = data.risk.critical + data.risk.high > 0;
  const hasSettlementIssue = data.settlement.unreconciled > 0;
  const topBrandNgn        = data.profitByBrand?.[0]?.totalNgn ?? 1;
  const topRegionCount     = data.regionalPerformance?.[0]?.count ?? 1;

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
        <div className="flex items-center gap-2">
          {/* Send Now — triggers weekly email + Telegram push on demand */}
          <button
            onClick={handleSendReport}
            disabled={sending || loading}
            className={`flex items-center gap-1.5 text-xs py-1.5 px-3 rounded-lg border transition-colors ${
              sendResult
                ? sendResult.ok
                  ? "text-green-400 bg-green-400/10 border-green-400/20"
                  : "text-red-400 bg-red-400/10 border-red-400/20"
                : "text-muted-foreground bg-secondary border-transparent hover:border-border"
            }`}
            title="Send weekly analytics report now (email + Telegram)"
          >
            {sending
              ? <><Loader2 className="size-3 animate-spin" /> Sending…</>
              : sendResult
                ? sendResult.ok
                  ? <><CheckCircle2 className="size-3" /> {sendResult.label}</>
                  : <><AlertTriangle className="size-3" /> {sendResult.label}</>
                : <><Zap className="size-3" /> Send Report</>
            }
          </button>

          {data && (
            <button
              onClick={handleExportCsv}
              className="flex items-center gap-1.5 text-xs text-gold py-1.5 px-3 rounded-lg bg-gold/10 border border-gold/20 hover:bg-gold/20 transition-colors"
              title="Download analytics as CSV"
            >
              <Download className="size-3" /> Export CSV
            </button>
          )}
          <button
            onClick={load}
            disabled={loading}
            className="flex items-center gap-1.5 text-xs text-muted-foreground py-1.5 px-3 rounded-lg bg-secondary"
          >
            <RefreshCw className={`size-3 ${loading ? "animate-spin" : ""}`} /> Refresh
          </button>
        </div>
      </div>

      {/* ── ALERT BANNER ── */}
      {(hasRiskAlerts || hasSettlementIssue) && (
        <div className="rounded-2xl border border-red-500/30 bg-red-500/5 p-4 space-y-1.5">
          <div className="flex items-center gap-2 text-red-400 font-bold text-sm">
            <AlertOctagon className="size-4" /> Attention Required
          </div>
          {data.risk.critical > 0 && (
            <p className="text-xs text-red-300">{data.risk.critical} CRITICAL risk entity/ies flagged</p>
          )}
          {data.risk.high > 0 && (
            <p className="text-xs text-orange-300">{data.risk.high} HIGH risk entity/ies active</p>
          )}
          {hasSettlementIssue && (
            <p className="text-xs text-yellow-300">
              {data.settlement.unreconciled} unreconciled trade(s) — {formatNgn(data.settlement.unreconciledNgn)} outstanding
            </p>
          )}
        </div>
      )}

      {/* ── USERS ── */}
      <section>
        <SectionHeader icon={Users} label="Users" />
        <div className="grid grid-cols-2 gap-3">
          <BigMetric icon={Users}        label="Total Users"  value={data.users.total.toLocaleString()}       color="text-cyan" />
          <BigMetric icon={Activity}     label="Active Today" value={data.users.dailyActive.toLocaleString()} color="text-green-400" sub="sessions updated today" />
          <BigMetric icon={ArrowUpRight} label="New Today"    value={data.users.newToday.toLocaleString()}    color="text-cyan" />
          <BigMetric icon={Shield}       label="KYC Verified" value={data.users.kycVerified.toLocaleString()} color="text-gold" />
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
          <BigMetric icon={DollarSign}   label="Today (NGN)"  value={formatNgn(data.volume.todayNgn)}   color="text-green-400" sub={formatUsd(data.volume.todayUsd)} />
          <BigMetric icon={DollarSign}   label="This Month"   value={formatNgn(data.volume.monthNgn)}   color="text-cyan"      sub={formatUsd(data.volume.monthUsd)} />
          <BigMetric icon={BarChart3}    label="All-Time NGN" value={formatNgn(data.volume.allTimeNgn)} color="text-gold"      sub={formatUsd(data.volume.allTimeUsd)} />
          <BigMetric icon={CheckCircle2} label="Unreconciled" value={formatNgn(data.settlement.unreconciledNgn)} color={data.settlement.unreconciled > 0 ? "text-red-400" : "text-muted-foreground"} sub={`${data.settlement.unreconciled} trade(s)`} />
        </div>
      </section>

      {/* ── USER LTV ── */}
      {data.userLtv && (
        <section>
          <SectionHeader icon={Target} label={`User LTV (Last ${data.userLtv.windowDays}d)`} />
          <div className="grid grid-cols-2 gap-3">
            <BigMetric icon={Wallet}   label="Avg LTV (NGN)"       value={formatNgn(data.userLtv.avgNgn)}          color="text-gold" sub={formatUsd(data.userLtv.avgUsd)} />
            <BigMetric icon={BarChart3} label="Avg Trades / User"  value={`${data.userLtv.avgTradesPerUser}x`}      color="text-cyan" sub={`${data.userLtv.activePayingUsers.toLocaleString()} active payers`} />
          </div>
        </section>
      )}

      {/* ── VENDOR LTV ── */}
      {data.vendorLtv && (
        <section>
          <SectionHeader icon={Building2} label="Vendor LTV" />
          <div className="grid grid-cols-2 gap-3">
            <BigMetric icon={Wallet}   label="Avg Lifetime NGN"  value={formatNgn(data.vendorLtv.avgLifetimeNgn)}  color="text-emerald-400" sub={`${data.vendorLtv.vendorCount} vendors`} />
            <BigMetric icon={DollarSign} label="Total Funded NGN" value={formatNgn(data.vendorLtv.totalFundedNgn)} color="text-cyan" sub={`${formatNgn(data.vendorLtv.totalBalanceNgn)} balance`} />
          </div>
        </section>
      )}

      {/* ── PREMIUM CONVERSION ── */}
      {data.premiumConversion && (
        <section>
          <SectionHeader icon={Crown} label="Premium Conversion" />
          <MCCard>
            <div className="flex items-center justify-between mb-3">
              <div>
                <p className="text-2xl font-extrabold text-gold">{data.premiumConversion.conversionRate}%</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">conversion rate</p>
              </div>
              <div className="text-right">
                <p className="text-sm font-bold text-gold">{data.premiumConversion.premiumUsers.toLocaleString()}</p>
                <p className="text-[10px] text-muted-foreground">premium members</p>
                <p className="text-[10px] text-muted-foreground">of {data.premiumConversion.totalUsers.toLocaleString()} users</p>
              </div>
            </div>
            <ProgressBar value={data.premiumConversion.premiumUsers} max={data.premiumConversion.totalUsers} color="bg-gold" />
          </MCCard>
        </section>
      )}

      {/* ── FRAUD RATE ── */}
      {data.fraudRate && (
        <section>
          <SectionHeader icon={ShieldAlert} label="Fraud Rate" />
          <div className="grid grid-cols-2 gap-3">
            <BigMetric
              icon={ShieldAlert}
              label="Fraud Rate (30d)"
              value={`${data.fraudRate.ratePct}%`}
              color={data.fraudRate.ratePct > 2 ? "text-red-400" : data.fraudRate.ratePct > 0.5 ? "text-orange-400" : "text-green-400"}
              sub={`${data.fraudRate.fraudCount30d} events`}
            />
            <BigMetric
              icon={AlertTriangle}
              label="Risk Flags Active"
              value={(data.risk.critical + data.risk.high).toString()}
              color={data.risk.critical > 0 ? "text-red-400" : data.risk.high > 0 ? "text-orange-400" : "text-muted-foreground"}
              sub={`${data.risk.critical} critical · ${data.risk.high} high`}
            />
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
      )}

      {/* ── TREASURY VELOCITY ── */}
      {data.treasuryVelocity && (
        <section>
          <SectionHeader icon={Zap} label="Treasury Velocity (24h)" />
          <div className="grid grid-cols-3 gap-2 mb-3">
            <div className="bg-gradient-card rounded-xl border border-white/5 p-3 text-center">
              <p className="text-base font-extrabold text-gold tabular-nums">{data.treasuryVelocity.totalDecisions24h}</p>
              <p className="text-[9px] text-muted-foreground mt-0.5">Decisions</p>
            </div>
            <div className="bg-gradient-card rounded-xl border border-white/5 p-3 text-center">
              <p className="text-base font-extrabold text-cyan tabular-nums">{data.treasuryVelocity.avgDecisionsPerHour}</p>
              <p className="text-[9px] text-muted-foreground mt-0.5">Per Hour</p>
            </div>
            <div className="bg-gradient-card rounded-xl border border-white/5 p-3 text-center">
              <p className="text-base font-extrabold text-emerald-400 tabular-nums">{data.treasuryVelocity.buyRate24hPct}%</p>
              <p className="text-[9px] text-muted-foreground mt-0.5">Buy Rate</p>
            </div>
          </div>
          {data.treasuryVelocity.hourly.length > 0 && (
            <MCCard>
              <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wide mb-3">Hourly Decision Volume</p>
              <div className="flex items-end gap-0.5 h-16 w-full">
                {data.treasuryVelocity.hourly.map(h => {
                  const maxH = Math.max(...data.treasuryVelocity.hourly.map(x => x.total), 1);
                  const heightPct = Math.max(4, (h.total / maxH) * 100);
                  return (
                    <div key={h.hour} className="flex-1 flex flex-col items-center justify-end gap-0.5 min-w-0">
                      <div
                        className="w-full rounded-t-sm bg-gold/60 min-h-[2px]"
                        style={{ height: `${heightPct}%` }}
                        title={`${h.hour}: ${h.total} decisions`}
                      />
                    </div>
                  );
                })}
              </div>
              <div className="flex justify-between mt-1">
                <span className="text-[9px] text-muted-foreground">{data.treasuryVelocity.hourly[0]?.hour ?? ""}</span>
                <span className="text-[9px] text-muted-foreground">{data.treasuryVelocity.hourly[data.treasuryVelocity.hourly.length - 1]?.hour ?? ""}</span>
              </div>
            </MCCard>
          )}
          <div className="grid grid-cols-3 gap-2 mt-2">
            <div className="bg-gradient-card rounded-xl border border-white/5 p-3 text-center">
              <p className="text-sm font-extrabold text-gold tabular-nums">{data.treasury.buyDecisionsToday}</p>
              <p className="text-[9px] text-muted-foreground mt-0.5">Buy Today</p>
            </div>
            <div className="bg-gradient-card rounded-xl border border-white/5 p-3 text-center">
              <p className="text-sm font-extrabold text-cyan tabular-nums">{data.treasury.vendorRouteToday}</p>
              <p className="text-[9px] text-muted-foreground mt-0.5">Route Today</p>
            </div>
            <div className="bg-gradient-card rounded-xl border border-white/5 p-3 text-center">
              <p className="text-sm font-extrabold text-muted-foreground tabular-nums">{data.treasury.totalDecisionsToday}</p>
              <p className="text-[9px] text-muted-foreground mt-0.5">Total Today</p>
            </div>
          </div>
        </section>
      )}

      {/* ── INVENTORY VELOCITY ── */}
      {data.inventoryVelocity && data.inventoryVelocity.sampleSize > 0 && (
        <section>
          <SectionHeader icon={Gauge} label="Inventory Velocity (Trade → Settlement)" />
          <div className="grid grid-cols-3 gap-2">
            <div className="bg-gradient-card rounded-2xl border border-white/5 p-4 text-center">
              <p className="text-lg font-extrabold text-cyan">{fmtMins(data.inventoryVelocity.avgMinutes)}</p>
              <p className="text-[9px] text-muted-foreground mt-1">Average</p>
            </div>
            <div className="bg-gradient-card rounded-2xl border border-white/5 p-4 text-center">
              <p className="text-lg font-extrabold text-emerald-400">{fmtMins(data.inventoryVelocity.medianMinutes)}</p>
              <p className="text-[9px] text-muted-foreground mt-1">Median</p>
            </div>
            <div className="bg-gradient-card rounded-2xl border border-white/5 p-4 text-center">
              <p className="text-lg font-extrabold text-orange-400">{fmtMins(data.inventoryVelocity.p90Minutes)}</p>
              <p className="text-[9px] text-muted-foreground mt-1">P90</p>
            </div>
          </div>
          <p className="text-[10px] text-muted-foreground text-center mt-2">
            Based on {data.inventoryVelocity.sampleSize.toLocaleString()} settled trades
          </p>
        </section>
      )}

      {/* ── PROFIT PER CARD TYPE ── */}
      {data.profitByBrand && data.profitByBrand.length > 0 && (
        <section>
          <SectionHeader icon={Package} label="Profit Per Card Type" />
          <MCCard>
            <div className="space-y-3">
              {data.profitByBrand.map((b) => (
                <div key={b.brand}>
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-xs font-semibold truncate">{b.brand}</span>
                      <span className="text-[9px] text-muted-foreground shrink-0">{b.count} trades</span>
                    </div>
                    <div className="text-right shrink-0 ml-2">
                      <p className="text-xs font-extrabold text-gold">{formatNgn(b.totalNgn)}</p>
                      {b.avgRateNgn > 0 && (
                        <p className="text-[9px] text-muted-foreground">₦{b.avgRateNgn.toLocaleString()}/$</p>
                      )}
                    </div>
                  </div>
                  <ProgressBar value={b.totalNgn} max={topBrandNgn} color="bg-gold/60" />
                </div>
              ))}
            </div>
          </MCCard>
        </section>
      )}

      {/* ── PROVIDER SUCCESS RATES ── */}
      {data.providerHealth && data.providerHealth.length > 0 && (
        <section>
          <SectionHeader icon={Server} label="Provider Success Rates (Last 1h)" />
          <MCCard>
            <div className="space-y-3">
              {data.providerHealth.map((p) => (
                <div key={p.provider}>
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <span className={`size-2 rounded-full shrink-0 ${p.status === "healthy" ? "bg-green-400" : p.status === "degraded" ? "bg-orange-400" : "bg-red-400"}`} />
                      <span className="text-xs font-semibold capitalize">{p.provider}</span>
                    </div>
                    <div className="flex items-center gap-3 text-right shrink-0">
                      {p.avgLatencyMs > 0 && (
                        <span className="text-[10px] text-muted-foreground">{p.avgLatencyMs}ms</span>
                      )}
                      <span className={`text-xs font-extrabold ${p.status === "healthy" ? "text-green-400" : p.status === "degraded" ? "text-orange-400" : "text-red-400"}`}>
                        {p.successRate}%
                      </span>
                      <span className="text-[9px] text-muted-foreground">{p.totalCalls} calls</span>
                    </div>
                  </div>
                  <ProgressBar
                    value={p.successRate}
                    max={100}
                    color={p.status === "healthy" ? "bg-green-400" : p.status === "degraded" ? "bg-orange-400" : "bg-red-400"}
                  />
                </div>
              ))}
            </div>
          </MCCard>
        </section>
      )}

      {/* ── REGIONAL PERFORMANCE ── */}
      {data.regionalPerformance && data.regionalPerformance.length > 0 && (
        <section>
          <SectionHeader icon={Globe} label="Regional Performance" />
          <MCCard>
            <div className="space-y-3">
              {data.regionalPerformance.map((r) => (
                <div key={r.region}>
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2 min-w-0">
                      <Map className="size-3 text-muted-foreground shrink-0" />
                      <span className="text-xs font-semibold truncate">{r.region}</span>
                      <span className="text-[9px] text-muted-foreground shrink-0">{r.count} trades · {r.sharePct}%</span>
                    </div>
                    <span className="text-xs font-bold text-cyan shrink-0 ml-2">{formatNgn(r.totalNgn)}</span>
                  </div>
                  <ProgressBar value={r.count} max={topRegionCount} color="bg-cyan/60" />
                </div>
              ))}
            </div>
          </MCCard>
        </section>
      )}

      {/* ── ACTION QUEUES ── */}
      <section>
        <SectionHeader icon={Clock} label="Action Queues" />
        <MCCard urgent={totalQueueItems > 5}>
          <div className="divide-y divide-white/5">
            <QueueRow icon={Shield}        label="KYC Pending"    count={data.queues.kycPending}   color="text-gold"       urgent={data.queues.kycPending > 0} />
            <QueueRow icon={AlertTriangle} label="Manual Review"  count={data.queues.manualReview} color="text-orange-400" urgent={data.queues.manualReview > 0} />
            <QueueRow icon={DollarSign}    label="Escrow / Payout" count={data.queues.escrow}      color="text-cyan"       urgent={data.queues.escrow > 3} />
            <QueueRow icon={Users}         label="Support"         count={data.queues.support}     color="text-purple-400" />
          </div>
        </MCCard>
      </section>

      {/* ── VENDORS ── */}
      <section>
        <SectionHeader icon={Building2} label="Vendors" />
        <div className="grid grid-cols-2 gap-3 mb-3">
          <BigMetric icon={CheckCircle2}  label="Active"    value={data.vendors.active.toLocaleString()}    color="text-green-400" />
          <BigMetric icon={AlertTriangle} label="Suspended" value={data.vendors.suspended.toLocaleString()} color="text-red-400" />
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
