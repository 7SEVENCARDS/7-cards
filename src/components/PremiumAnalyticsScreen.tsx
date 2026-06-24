// ─────────────────────────────────────────────────────────────────────────────
// PremiumAnalyticsScreen — Phase 15
//
// Advanced analytics dashboard for Premium members:
//
//   Overview  — trust score ring, member stats, benefit summary
//   Trades    — volume, success rate, daily bar chart, top brands
//   Trust     — signal breakdown, premium contribution, score history
//   Milestones— loyalty roadmap (30/90/180/365 days)
//   Referrals — earnings, count, pending balance
// ─────────────────────────────────────────────────────────────────────────────

import React, { useState } from "react";
import {
  ChevronLeft, Loader2, TrendingUp, ShieldCheck, Crown, Star,
  Trophy, Zap, Wallet, BarChart3, Target, Clock, CheckCircle2,
  Circle, ArrowUpRight, RefreshCw, Lock, Heart, Award,
  Users, DollarSign, Activity,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { getPremiumAnalytics } from "../server-functions/premium-analytics";

// ─── Types ────────────────────────────────────────────────────────────────────
type AnalyticsTab = "overview" | "trades" | "trust" | "milestones" | "referrals";

interface Props {
  userId: string;
  onBack: () => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const ngn  = (n: number) => `₦${n.toLocaleString("en-NG")}`;
const usd  = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct  = (n: number) => `${n}%`;

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-NG", { day: "numeric", month: "short", year: "numeric" });
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mb-2">
      {children}
    </p>
  );
}

function MetricTile({
  icon: Icon, label, value, sub, color = "text-cyan", accent = "bg-cyan/10",
}: {
  icon: typeof BarChart3; label: string; value: string | number; sub?: string;
  color?: string; accent?: string;
}) {
  return (
    <div className="bg-card rounded-2xl border border-border p-4">
      <div className={`size-9 rounded-xl ${accent} grid place-items-center mb-3`}>
        <Icon className={`size-4 ${color}`} />
      </div>
      <p className="text-xl font-extrabold">{value}</p>
      <p className="text-[11px] text-muted-foreground">{label}</p>
      {sub && <p className={`text-[10px] font-semibold mt-0.5 ${color}`}>{sub}</p>}
    </div>
  );
}

// Trust level colours
const LEVEL_COLORS: Record<string, string> = {
  New:      "text-white/50",
  Verified: "text-emerald-400",
  Trusted:  "text-cyan",
  Elite:    "text-gold",
};
const LEVEL_BG: Record<string, string> = {
  New:      "bg-white/10",
  Verified: "bg-emerald-500/15",
  Trusted:  "bg-cyan/15",
  Elite:    "bg-gold/15",
};

// Readable signal labels
const SIGNAL_LABELS: Record<string, string> = {
  monoVerified:          "Mono Bank Link",
  ninVerified:           "NIN Verification",
  bvnVerified:           "BVN Verification",
  bankOwnershipVerified: "Bank Ownership",
  tradeHistory:          "Trade History",
  settlementHistory:     "Settlement Track",
  fraudPenalty:          "Fraud Penalty",
  chargebackPenalty:     "Chargeback Penalty",
  deviceReputation:      "Device Reputation",
  referralQuality:       "Referral Quality",
  accountAge:            "Account Age",
  supportEscalations:    "Support Escalations",
  disputePenalty:        "Dispute Penalty",
  premiumMember:         "Premium Membership",
};

// Score ring SVG
function ScoreRing({ score, level }: { score: number; level: string }) {
  const r = 54;
  const circ = 2 * Math.PI * r;
  const dash = (score / 100) * circ;
  const color = level === "Elite" ? "#E8C44A" : level === "Trusted" ? "#00E5FF" : level === "Verified" ? "#10b981" : "#6b7280";

  return (
    <svg width="140" height="140" viewBox="0 0 140 140" className="mx-auto">
      <circle cx="70" cy="70" r={r} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="10" />
      <circle
        cx="70" cy="70" r={r} fill="none" stroke={color} strokeWidth="10"
        strokeDasharray={`${dash} ${circ}`}
        strokeLinecap="round"
        transform="rotate(-90 70 70)"
        style={{ transition: "stroke-dasharray 0.8s ease" }}
      />
      <text x="70" y="65" textAnchor="middle" fill="white" fontSize="26" fontWeight="800">{score}</text>
      <text x="70" y="82" textAnchor="middle" fill={color} fontSize="11" fontWeight="700">{level}</text>
      <text x="70" y="96" textAnchor="middle" fill="rgba(255,255,255,0.4)" fontSize="9">/100</text>
    </svg>
  );
}

// Simple bar chart
function BarChart({ bars, maxVal, color = "bg-cyan" }: {
  bars: { label: string; value: number }[];
  maxVal: number;
  color?: string;
}) {
  if (!bars.length) return <p className="text-[11px] text-muted-foreground text-center py-6">No data for this period.</p>;
  return (
    <div className="flex items-end gap-1 h-24 w-full">
      {bars.map(({ label, value }) => (
        <div key={label} className="flex-1 flex flex-col items-center gap-1 min-w-0">
          <div className="w-full flex items-end justify-center" style={{ height: "76px" }}>
            <div
              className={`w-full max-w-[32px] ${color} rounded-t-md opacity-80 transition-all`}
              style={{ height: maxVal > 0 ? `${Math.max(2, (value / maxVal) * 76)}px` : "2px" }}
            />
          </div>
          <p className="text-[8px] text-muted-foreground text-center leading-none truncate w-full px-0.5">
            {label.slice(5)}
          </p>
        </div>
      ))}
    </div>
  );
}

// Milestone progress step
function MilestoneStep({
  days, label, benefit, achieved, achievedAt, progress, daysLeft, isLast,
}: {
  days: number; label: string; benefit: string; achieved: boolean;
  achievedAt: string | null; progress: number; daysLeft: number; isLast: boolean;
}) {
  return (
    <div className="flex gap-4">
      {/* Connector */}
      <div className="flex flex-col items-center">
        <div className={`size-9 rounded-full grid place-items-center flex-shrink-0 ${achieved ? "bg-gold/20" : "bg-card border border-border"}`}>
          {achieved
            ? <Trophy className="size-4 text-gold" />
            : daysLeft < 30
              ? <Clock className="size-4 text-cyan" />
              : <Circle className="size-4 text-white/20" />}
        </div>
        {!isLast && <div className="w-0.5 flex-1 mt-1 bg-border" />}
      </div>

      {/* Content */}
      <div className={`flex-1 pb-5 ${isLast ? "" : ""}`}>
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className={`text-sm font-bold ${achieved ? "text-gold" : "text-foreground"}`}>{label}</p>
            <p className="text-[11px] text-muted-foreground mt-0.5">{benefit}</p>
          </div>
          <div className="text-right shrink-0">
            {achieved
              ? <span className="text-[10px] font-bold text-gold bg-gold/10 px-2 py-0.5 rounded-full">✓ Done</span>
              : <span className="text-[11px] font-semibold text-muted-foreground">{daysLeft}d left</span>}
          </div>
        </div>

        {!achieved && (
          <div className="mt-2">
            <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
              <div className="h-full bg-cyan rounded-full transition-all" style={{ width: `${progress}%` }} />
            </div>
            <p className="text-[9px] text-muted-foreground mt-0.5 text-right">{progress}%</p>
          </div>
        )}

        {achieved && achievedAt && (
          <p className="text-[10px] text-gold mt-1">Achieved {fmtDate(achievedAt)}</p>
        )}
      </div>
    </div>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────
export function PremiumAnalyticsScreen({ userId, onBack }: Props) {
  const [activeTab, setActiveTab] = useState<AnalyticsTab>("overview");

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["premium-analytics", userId],
    queryFn: () => getPremiumAnalytics({ data: {} }),
    staleTime: 3 * 60_000,
    retry: 1,
  });

  const TABS: { key: AnalyticsTab; label: string; icon: typeof BarChart3 }[] = [
    { key: "overview",   label: "Overview",   icon: BarChart3   },
    { key: "trades",     label: "Trades",     icon: TrendingUp  },
    { key: "trust",      label: "Trust",      icon: ShieldCheck },
    { key: "milestones", label: "Milestones", icon: Trophy      },
    { key: "referrals",  label: "Referrals",  icon: Users       },
  ];

  const d = data as typeof data & {
    trust: { score: number; level: string; breakdown: Record<string, number>; computedAt: string | null; reason: string; premiumBonus: number };
    trades: { total: number; successful: number; successRate: number; totalVolumeUsd: number; totalPayoutNgn: number; daily: { date: string; count: number; volumeUsd: number; payoutNgn: number }[]; topBrands: { brand: string; count: number }[] };
    referrals: { totalEarned: number; pendingEarned: number; count: number };
    milestones: { days: number; label: string; benefit: string; achieved: boolean; achievedAt: string | null; progress: number; daysLeft: number }[];
    daysSince: number;
    memberSince: string | null;
    expiresAt: string | null;
    premiumType: string;
  } | undefined;

  const maxVol = Math.max(...(d?.trades.daily ?? []).map(r => r.volumeUsd), 1);
  const maxCnt = Math.max(...(d?.trades.daily ?? []).map(r => r.count), 1);
  const trustBreakdown = Object.entries(d?.trust.breakdown ?? {}).filter(([k]) => k !== "premiumMember");

  // ── Overview sub-content ──────────────────────────────────────────────────
  const OverviewSection = () => (
    <div className="space-y-5">
      {/* Trust ring hero */}
      <div className="bg-gradient-hero rounded-3xl p-6 shadow-glow-jungle relative overflow-hidden">
        <div className="absolute -right-8 -top-8 size-40 rounded-full bg-gold/10 blur-2xl pointer-events-none" />
        <div className="flex items-center gap-3 mb-4 relative">
          <Crown className="size-5 text-gold" />
          <p className="text-sm font-bold text-white">Trust Score Progress</p>
          {d?.trust.premiumBonus ? (
            <span className="ml-auto text-[10px] font-bold text-gold bg-gold/20 px-2 py-0.5 rounded-full">
              +{d.trust.premiumBonus} Premium Boost
            </span>
          ) : null}
        </div>
        <ScoreRing score={d?.trust.score ?? 0} level={d?.trust.level ?? "New"} />
        <p className="text-[11px] text-white/60 text-center mt-3 leading-relaxed">{d?.trust.reason}</p>
      </div>

      {/* Member stats */}
      <div className="grid grid-cols-2 gap-3">
        <MetricTile icon={Activity}    label="Days Premium"   value={d?.daysSince ?? 0}                                 color="text-gold"        accent="bg-gold/10"         />
        <MetricTile icon={TrendingUp}  label="Trades (90d)"  value={(d?.trades.total ?? 0).toLocaleString()}           color="text-cyan"        accent="bg-cyan/10"         />
        <MetricTile icon={DollarSign}  label="Volume Traded" value={usd(d?.trades.totalVolumeUsd ?? 0)}                color="text-emerald-400" accent="bg-emerald-500/10"  />
        <MetricTile icon={Target}      label="Success Rate"  value={pct(d?.trades.successRate ?? 0)}                   color="text-cyan"        accent="bg-cyan/10"         />
      </div>

      {/* Referral earnings */}
      {(d?.referrals.totalEarned ?? 0) > 0 && (
        <div className="bg-card rounded-2xl border border-border p-4 flex items-center gap-3">
          <div className="size-10 rounded-xl bg-gold/15 grid place-items-center">
            <Award className="size-5 text-gold" />
          </div>
          <div className="flex-1">
            <p className="text-sm font-bold">Referral Earnings</p>
            <p className="text-[11px] text-muted-foreground">from {d?.referrals.count} referrals</p>
          </div>
          <div className="text-right">
            <p className="text-base font-extrabold text-gold">{ngn(d?.referrals.totalEarned ?? 0)}</p>
            {(d?.referrals.pendingEarned ?? 0) > 0 && (
              <p className="text-[10px] text-muted-foreground">{ngn(d.referrals.pendingEarned)} pending</p>
            )}
          </div>
        </div>
      )}

      {/* Milestone teaser */}
      <div className="bg-card rounded-2xl border border-border p-4">
        <SectionLabel>Loyalty Progress</SectionLabel>
        <div className="flex gap-2">
          {[30, 90, 180, 365].map(days => {
            const ms = d?.milestones.find(m => m.days === days);
            return (
              <div key={days} className={`flex-1 rounded-xl p-2.5 text-center ${ms?.achieved ? "bg-gold/10 border border-gold/30" : "bg-secondary"}`}>
                {ms?.achieved ? <Trophy className="size-4 text-gold mx-auto mb-1" /> : <Lock className="size-4 text-white/20 mx-auto mb-1" />}
                <p className={`text-[9px] font-bold ${ms?.achieved ? "text-gold" : "text-muted-foreground"}`}>
                  {days < 365 ? `${days}d` : "1yr"}
                </p>
              </div>
            );
          })}
        </div>
        <button onClick={() => setActiveTab("milestones")}
          className="w-full mt-3 text-[11px] font-semibold text-cyan text-center flex items-center justify-center gap-1">
          View full roadmap <ArrowUpRight className="size-3" />
        </button>
      </div>

      {/* Rate snapshot */}
      {(d?.rateHistory ?? []).length > 0 && (
        <div className="bg-card rounded-2xl border border-border p-4">
          <SectionLabel>Current Rates (Live)</SectionLabel>
          <div className="space-y-1.5">
            {(d?.rateHistory ?? []).slice(0, 5).map((r, i) => (
              <div key={i} className="flex items-center justify-between">
                <p className="text-[11px] font-semibold">{r.brand}</p>
                <p className="text-[11px] font-bold text-gold">{ngn(r.rate)}/$</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );

  // ── Trades sub-content ────────────────────────────────────────────────────
  const TradesSection = () => (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3">
        <MetricTile icon={BarChart3}    label="Total Trades"    value={(d?.trades.total ?? 0).toLocaleString()}              />
        <MetricTile icon={CheckCircle2} label="Successful"       value={(d?.trades.successful ?? 0).toLocaleString()}          color="text-emerald-400" accent="bg-emerald-500/10" />
        <MetricTile icon={Target}       label="Success Rate"     value={pct(d?.trades.successRate ?? 0)}                       />
        <MetricTile icon={DollarSign}   label="USD Volume (90d)" value={usd(d?.trades.totalVolumeUsd ?? 0)}                    color="text-gold" accent="bg-gold/10" />
      </div>

      <div className="bg-card rounded-2xl border border-border p-4">
        <p className="text-[10px] text-muted-foreground font-bold uppercase tracking-widest mb-1">Total NGN Received</p>
        <p className="text-2xl font-extrabold text-gold">{ngn(d?.trades.totalPayoutNgn ?? 0)}</p>
        <p className="text-[11px] text-muted-foreground">last 90 days</p>
      </div>

      {/* Daily volume chart */}
      <div className="bg-card rounded-2xl border border-border p-4">
        <SectionLabel>Daily Volume (USD) — Last 30 days</SectionLabel>
        <BarChart
          bars={(d?.trades.daily ?? []).map(r => ({ label: r.date, value: r.volumeUsd }))}
          maxVal={maxVol}
          color="bg-cyan"
        />
      </div>

      {/* Daily trade count chart */}
      <div className="bg-card rounded-2xl border border-border p-4">
        <SectionLabel>Daily Trades — Last 30 days</SectionLabel>
        <BarChart
          bars={(d?.trades.daily ?? []).map(r => ({ label: r.date, value: r.count }))}
          maxVal={maxCnt}
          color="bg-gold"
        />
      </div>

      {/* Top brands */}
      {(d?.trades.topBrands ?? []).length > 0 && (
        <div className="bg-card rounded-2xl border border-border p-4">
          <SectionLabel>Top Brands</SectionLabel>
          <div className="space-y-2">
            {(d?.trades.topBrands ?? []).map(({ brand, count }) => {
              const maxB = Math.max(...(d?.trades.topBrands ?? []).map(b => b.count), 1);
              return (
                <div key={brand} className="flex items-center gap-3">
                  <p className="text-[11px] font-semibold w-24 shrink-0">{brand}</p>
                  <div className="flex-1 h-1.5 rounded-full bg-secondary overflow-hidden">
                    <div className="h-full bg-cyan rounded-full" style={{ width: `${(count / maxB) * 100}%` }} />
                  </div>
                  <p className="text-[11px] font-bold w-6 text-right">{count}</p>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );

  // ── Trust sub-content ─────────────────────────────────────────────────────
  const TrustSection = () => (
    <div className="space-y-5">
      {/* Hero ring */}
      <div className="bg-gradient-hero rounded-3xl p-6 shadow-glow-jungle relative overflow-hidden">
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute -right-8 -top-8 size-40 rounded-full bg-cyan/10 blur-2xl" />
        </div>
        <ScoreRing score={d?.trust.score ?? 0} level={d?.trust.level ?? "New"} />
        <div className="mt-3 flex justify-center gap-2 flex-wrap">
          {["New", "Verified", "Trusted", "Elite"].map(lvl => (
            <span key={lvl} className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${d?.trust.level === lvl ? `${LEVEL_BG[lvl]} ${LEVEL_COLORS[lvl]}` : "bg-white/5 text-white/30"}`}>
              {lvl}
            </span>
          ))}
        </div>
      </div>

      {/* Premium trust boost */}
      {(d?.trust.premiumBonus ?? 0) > 0 && (
        <div className="bg-gold/10 border border-gold/30 rounded-2xl p-4 flex items-center gap-3">
          <Crown className="size-5 text-gold" />
          <div className="flex-1">
            <p className="text-sm font-bold text-gold">Premium Trust Boost Active</p>
            <p className="text-[11px] text-muted-foreground">Your Premium membership contributes +{d?.trust.premiumBonus} to your score.</p>
          </div>
          <span className="text-xl font-extrabold text-gold">+{d?.trust.premiumBonus}</span>
        </div>
      )}

      {/* Signal breakdown */}
      <div className="bg-card rounded-2xl border border-border p-4">
        <SectionLabel>Signal Breakdown</SectionLabel>
        <div className="space-y-2.5">
          {trustBreakdown.map(([key, value]) => {
            const isNegative = value < 0;
            const absVal  = Math.abs(value);
            const barMax  = key === "accountAge" ? 20 : 15;
            return (
              <div key={key}>
                <div className="flex items-center justify-between mb-1">
                  <p className="text-[11px] font-semibold">{SIGNAL_LABELS[key] ?? key}</p>
                  <p className={`text-[11px] font-extrabold ${isNegative ? "text-pink" : value > 0 ? "text-emerald-400" : "text-muted-foreground"}`}>
                    {isNegative ? "-" : value > 0 ? "+" : ""}{absVal}
                  </p>
                </div>
                <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
                  <div
                    className={`h-full rounded-full ${isNegative ? "bg-pink" : "bg-emerald-500"} transition-all`}
                    style={{ width: `${Math.min(100, (absVal / barMax) * 100)}%` }}
                  />
                </div>
              </div>
            );
          })}
          {/* Premium row */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-1.5">
                <Crown className="size-3 text-gold" />
                <p className="text-[11px] font-semibold text-gold">Premium Membership</p>
              </div>
              <p className="text-[11px] font-extrabold text-gold">+{d?.trust.premiumBonus ?? 0}</p>
            </div>
            <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
              <div className="h-full rounded-full bg-gold transition-all"
                style={{ width: `${Math.min(100, ((d?.trust.premiumBonus ?? 0) / 13) * 100)}%` }} />
            </div>
          </div>
        </div>
      </div>

      {d?.trust.computedAt && (
        <p className="text-[10px] text-muted-foreground text-center">
          Score last computed {fmtDate(d.trust.computedAt)}
        </p>
      )}
    </div>
  );

  // ── Milestones sub-content ────────────────────────────────────────────────
  const MilestonesSection = () => (
    <div className="space-y-5">
      {/* Days counter */}
      <div className="bg-gradient-hero rounded-3xl p-6 shadow-glow-jungle text-center relative overflow-hidden">
        <div className="absolute -left-8 -bottom-8 size-32 rounded-full bg-gold/10 blur-2xl pointer-events-none" />
        <Crown className="size-8 text-gold mx-auto mb-2" />
        <p className="text-4xl font-extrabold text-white">{d?.daysSince ?? 0}</p>
        <p className="text-sm text-white/70 mt-1">days as Premium member</p>
        {d?.memberSince && (
          <p className="text-[11px] text-gold mt-2">Member since {fmtDate(d.memberSince)}</p>
        )}
      </div>

      {/* Milestone steps */}
      <div className="bg-card rounded-2xl border border-border p-5">
        <SectionLabel>Loyalty Roadmap</SectionLabel>
        <div className="pt-1">
          {(d?.milestones ?? []).map((ms, i) => (
            <MilestoneStep
              key={ms.days}
              {...ms}
              isLast={i === (d?.milestones.length ?? 1) - 1}
            />
          ))}
        </div>
      </div>

      {/* Next milestone call-out */}
      {(d?.milestones ?? []).find(m => !m.achieved) && (() => {
        const next = (d?.milestones ?? []).find(m => !m.achieved)!;
        return (
          <div className="bg-cyan/10 border border-cyan/30 rounded-2xl p-4">
            <div className="flex items-center gap-2 mb-1">
              <Clock className="size-4 text-cyan" />
              <p className="text-sm font-bold text-cyan">Next milestone in {next.daysLeft} days</p>
            </div>
            <p className="text-[11px] text-muted-foreground">{next.label} — {next.benefit}</p>
            <div className="h-2 rounded-full bg-secondary mt-2 overflow-hidden">
              <div className="h-full bg-cyan rounded-full transition-all" style={{ width: `${next.progress}%` }} />
            </div>
            <p className="text-[9px] text-muted-foreground mt-1 text-right">{next.progress}% complete</p>
          </div>
        );
      })()}
    </div>
  );

  // ── Referrals sub-content ─────────────────────────────────────────────────
  const ReferralsSection = () => (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3">
        <MetricTile icon={Award}   label="Total Earned"   value={ngn(d?.referrals.totalEarned ?? 0)}   color="text-gold"        accent="bg-gold/10"        />
        <MetricTile icon={Users}   label="Referral Count" value={(d?.referrals.count ?? 0).toLocaleString()} color="text-cyan"        accent="bg-cyan/10"        />
        <MetricTile icon={Wallet}  label="Pending Payout" value={ngn(d?.referrals.pendingEarned ?? 0)} color="text-emerald-400" accent="bg-emerald-500/10" />
        <MetricTile icon={Star}    label="Premium Boost"  value="Active"                                color="text-gold"        accent="bg-gold/10"        />
      </div>

      <div className="bg-card rounded-2xl border border-border p-4 space-y-3">
        <SectionLabel>Premium Referral Benefits</SectionLabel>
        {[
          { icon: BarChart3, label: "Enhanced Referral Tracking",    desc: "See real-time commission earnings per referral"       },
          { icon: TrendingUp, label: "Referral Performance Insights", desc: "Track your referral quality and trade conversion"     },
          { icon: Trophy,    label: "Referral Leaderboard",          desc: "Compare your position among top referrers"            },
          { icon: Star,      label: "Future Affiliate Program",      desc: "Priority access when the Premium Affiliate launches"  },
        ].map(({ icon: Icon, label, desc }) => (
          <div key={label} className="flex items-start gap-3">
            <div className="size-8 rounded-xl bg-gold/10 grid place-items-center flex-shrink-0">
              <Icon className="size-4 text-gold" />
            </div>
            <div>
              <p className="text-[12px] font-semibold">{label}</p>
              <p className="text-[10px] text-muted-foreground">{desc}</p>
            </div>
          </div>
        ))}
      </div>

      {d?.referrals.count === 0 && (
        <div className="text-center py-8 text-muted-foreground">
          <Users className="size-10 mx-auto opacity-30 mb-3" />
          <p className="text-sm font-semibold">No referrals yet</p>
          <p className="text-[11px] mt-1">Share your referral code and earn when your friends trade.</p>
        </div>
      )}
    </div>
  );

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col min-h-dvh bg-background pb-8">
      <div className="mx-auto w-full max-w-[480px] flex flex-col">

        {/* Header */}
        <header className="px-5 pt-safe-top pb-4 flex items-center gap-4">
          <button onClick={onBack}
            className="size-10 rounded-full bg-card border border-border grid place-items-center">
            <ChevronLeft className="size-5" />
          </button>
          <div className="flex-1">
            <h1 className="text-xl font-extrabold">Premium Analytics</h1>
            <p className="text-xs text-muted-foreground">Your performance & loyalty dashboard</p>
          </div>
          <button onClick={() => refetch()} disabled={isFetching}
            className="size-10 rounded-full bg-card border border-border grid place-items-center disabled:opacity-50">
            <RefreshCw className={`size-4 text-muted-foreground ${isFetching ? "animate-spin" : ""}`} />
          </button>
        </header>

        {/* Sub-tab nav */}
        <div className="flex border-b border-white/5 bg-background sticky top-0 z-10 overflow-x-auto no-scrollbar px-2 gap-0.5">
          {TABS.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              className={`flex-1 flex flex-col items-center gap-1 pt-2.5 pb-2 min-w-[60px] transition-colors ${
                activeTab === key
                  ? "text-gold border-b-2 border-gold"
                  : "text-muted-foreground border-b-2 border-transparent"
              }`}
            >
              <Icon className="size-3.5" />
              <span className="text-[9px] font-bold">{label}</span>
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 pt-5">
          {isLoading ? (
            <div className="flex flex-col items-center justify-center py-24 gap-3">
              <Loader2 className="size-7 animate-spin text-gold" />
              <p className="text-sm text-muted-foreground">Loading your analytics…</p>
            </div>
          ) : error ? (
            <div className="text-center py-16">
              <Activity className="size-8 mx-auto opacity-30 mb-3" />
              <p className="text-sm font-semibold">Failed to load analytics</p>
              <button onClick={() => refetch()} className="mt-3 text-xs text-cyan font-bold">Try again</button>
            </div>
          ) : (
            <>
              {activeTab === "overview"   && <OverviewSection   />}
              {activeTab === "trades"     && <TradesSection     />}
              {activeTab === "trust"      && <TrustSection      />}
              {activeTab === "milestones" && <MilestonesSection />}
              {activeTab === "referrals"  && <ReferralsSection  />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
