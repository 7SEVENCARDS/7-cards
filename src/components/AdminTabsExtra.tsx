// ─────────────────────────────────────────────────────────────────────────────
// Admin Extra Tabs — Phase 14 & 15
//
// New admin dashboard tabs:
//   TrustTab         — Trust Engine scores, breakdown, per-user recompute
//   TreasuryTab      — Treasury Decision Engine decisions + summary
//   ApiKeysTab       — Provider API Key Management
//   ProviderHealthTab — Provider Health Center
//   PremiumAdminTab  — Premium Membership reporting
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ShieldCheck, RefreshCw, Loader2, Activity, Key, Crown,
  TrendingUp, AlertTriangle, CheckCircle2, XCircle, Zap,
  Wallet, BarChart3, Server, Heart, Star, Clock, Lock, Unlock,
  RotateCcw, EyeOff, ChevronDown, ChevronUp,
} from "lucide-react";
import { toast } from "sonner";

// ─── Server function imports ──────────────────────────────────────────────────
import {
  getAdminTrustScores,
  getTrustLevelBreakdown,
  recomputeTrustScore,
} from "../server-functions/admin-trust";
import {
  getTreasuryDecisions,
  getTreasurySummaryData,
} from "../server-functions/admin-treasury";
import {
  listProviderKeys,
  createProviderKey,
  activateProviderKey,
  disableProviderKey,
  rotateProviderKey,
  validateProviderKey,
} from "../server-functions/admin-api-keys";
import {
  getProviderHealth,
} from "../server-functions/admin-provider-health";
import {
  getAdminPremiumSummary,
  listPremiumUsers,
  getPremiumRevenueReport,
  getPremiumChurnReport,
} from "../server-functions/admin-premium";

// ─── Shared helpers ───────────────────────────────────────────────────────────
function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mb-2">
      {children}
    </p>
  );
}

function MetricCard({ icon: Icon, label, value, color = "text-cyan", sub }: {
  icon: typeof BarChart3; label: string; value: string | number; color?: string; sub?: string;
}) {
  return (
    <div className="bg-card rounded-2xl border border-border p-4">
      <Icon className={`size-4 ${color} mb-2`} />
      <p className="text-lg font-extrabold">{value}</p>
      <p className="text-[11px] text-muted-foreground">{label}</p>
      {sub && <p className={`text-[10px] font-semibold mt-0.5 ${color}`}>{sub}</p>}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    healthy: "bg-emerald-500/15 text-emerald-400",
    degraded: "bg-gold/15 text-gold",
    down: "bg-pink/15 text-pink",
    unknown: "bg-white/10 text-white/50",
    active: "bg-emerald-500/15 text-emerald-400",
    inactive: "bg-white/10 text-white/50",
    archived: "bg-white/5 text-white/30",
    Elite: "bg-gold/15 text-gold",
    Trusted: "bg-cyan/15 text-cyan",
    Verified: "bg-emerald-500/15 text-emerald-400",
    New: "bg-white/10 text-white/50",
    TREASURY_BUY: "bg-emerald-500/15 text-emerald-400",
    VENDOR_ROUTE: "bg-gold/15 text-gold",
    HYBRID_ROUTE: "bg-cyan/15 text-cyan",
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold ${map[status] ?? "bg-white/10 text-white/50"}`}>
      {status}
    </span>
  );
}

function CenterLoader() {
  return <div className="flex justify-center py-12"><Loader2 className="size-6 animate-spin text-cyan" /></div>;
}

const ngn = (n: number) => `₦${n.toLocaleString("en-NG")}`;
const pct = (n: number) => `${n}%`;

// ═══════════════════════════════════════════════════════════════════
// TRUST TAB
// ═══════════════════════════════════════════════════════════════════
export function TrustTab() {
  const [page, setPage] = useState(0);
  const [levelFilter, setLevelFilter] = useState("");
  const [recomputingId, setRecomputingId] = useState<string | null>(null);

  const { data: breakdown, isLoading: breakdownLoading } = useQuery({
    queryKey: ["trust-breakdown"],
    queryFn: () => getTrustLevelBreakdown({ data: {} }),
    staleTime: 60_000,
  });

  const { data: scores, isLoading: scoresLoading, refetch } = useQuery({
    queryKey: ["trust-scores", page, levelFilter],
    queryFn: () => getAdminTrustScores({ data: { page, pageSize: 20, level: levelFilter || undefined } }),
    staleTime: 30_000,
  });

  const handleRecompute = async (userId: string) => {
    setRecomputingId(userId);
    try {
      await recomputeTrustScore({ data: { userId } });
      toast.success("Trust score recomputed");
      refetch();
    } catch {
      toast.error("Recompute failed");
    } finally {
      setRecomputingId(null);
    }
  };

  const LEVEL_COLORS: Record<string, string> = {
    New: "text-white/50", Verified: "text-emerald-400", Trusted: "text-cyan", Elite: "text-gold",
  };

  return (
    <div className="p-5 space-y-5">
      {/* Summary cards */}
      {breakdownLoading ? <CenterLoader /> : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <MetricCard icon={ShieldCheck} label="Avg Trust Score"  value={breakdown?.avgScore ?? 0}            color="text-cyan"         />
            <MetricCard icon={Crown}       label="Treasury Eligible" value={breakdown?.treasuryEligible ?? 0}   color="text-gold"         />
          </div>
          <div className="grid grid-cols-4 gap-2">
            {(breakdown?.breakdown ?? []).map(({ level, count }) => (
              <button
                key={level}
                onClick={() => { setLevelFilter(levelFilter === level ? "" : level); setPage(0); }}
                className={`rounded-2xl border p-3 text-center transition ${levelFilter === level ? "border-cyan bg-cyan/10" : "border-border bg-card"}`}
              >
                <p className={`text-base font-extrabold ${LEVEL_COLORS[level]}`}>{count}</p>
                <p className="text-[10px] text-muted-foreground font-semibold">{level}</p>
              </button>
            ))}
          </div>
        </>
      )}

      <SectionHeader>
        {levelFilter ? `${levelFilter} Users` : "All Trust Scores"} — Page {page + 1}
      </SectionHeader>

      {scoresLoading ? <CenterLoader /> : (
        <div className="space-y-2">
          {(scores?.rows ?? []).map((row: Record<string, unknown>) => {
            const profile = row.profiles as Record<string, unknown>;
            const userId  = row.user_id as string;
            return (
              <div key={userId} className="bg-card rounded-2xl border border-border p-4 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-bold truncate">{(profile?.full_name as string) ?? "Unknown"}</p>
                    <StatusPill status={row.trust_level as string} />
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-0.5 truncate">
                    Score: <span className={`font-bold ${LEVEL_COLORS[row.trust_level as string]}`}>{row.trust_score as number}/100</span>
                    {" · "}{(row.trust_reason as string)?.slice(0, 50)}
                  </p>
                </div>
                <button
                  onClick={() => handleRecompute(userId)}
                  disabled={recomputingId === userId}
                  className="size-8 rounded-xl bg-secondary grid place-items-center flex-shrink-0 disabled:opacity-50"
                >
                  {recomputingId === userId
                    ? <Loader2 className="size-3.5 animate-spin text-cyan" />
                    : <RefreshCw className="size-3.5 text-cyan" />}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Pagination */}
      <div className="flex gap-2">
        <button disabled={page === 0} onClick={() => setPage(p => p - 1)}
          className="flex-1 py-2 rounded-xl bg-secondary text-xs font-bold disabled:opacity-40">← Prev</button>
        <button disabled={(scores?.rows ?? []).length < 20} onClick={() => setPage(p => p + 1)}
          className="flex-1 py-2 rounded-xl bg-secondary text-xs font-bold disabled:opacity-40">Next →</button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// TREASURY TAB
// ═══════════════════════════════════════════════════════════════════
export function TreasuryTab() {
  const [page, setPage] = useState(0);
  const [decisionFilter, setDecisionFilter] = useState("");

  const { data: summary, isLoading: summaryLoading } = useQuery({
    queryKey: ["treasury-summary"],
    queryFn: () => getTreasurySummaryData({ data: {} }),
    staleTime: 30_000,
  });

  const { data: decisions, isLoading: decisionsLoading } = useQuery({
    queryKey: ["treasury-decisions", page, decisionFilter],
    queryFn: () => getTreasuryDecisions({ data: { page, pageSize: 20, decision: decisionFilter || undefined } }),
    staleTime: 30_000,
  });

  const DECISION_COLORS: Record<string, string> = {
    TREASURY_BUY: "text-emerald-400", VENDOR_ROUTE: "text-gold", HYBRID_ROUTE: "text-cyan",
  };

  return (
    <div className="p-5 space-y-5">
      {summaryLoading ? <CenterLoader /> : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <MetricCard icon={BarChart3}  label="Total Decisions"   value={(summary?.totalDecisions ?? 0).toLocaleString()} />
            <MetricCard icon={TrendingUp} label="Last 24h"          value={summary?.last24hDecisions ?? 0} color="text-gold" />
            <MetricCard icon={CheckCircle2} label="Treasury Buy"    value={summary?.treasuryBuyCount ?? 0} color="text-emerald-400" />
            <MetricCard icon={Zap}        label="Avg Confidence"    value={`${summary?.avgConfidence ?? 0}%`} color="text-cyan" />
          </div>

          {/* Decision filter pills */}
          <div className="flex gap-2 flex-wrap">
            {["", "TREASURY_BUY", "VENDOR_ROUTE", "HYBRID_ROUTE"].map(d => (
              <button key={d} onClick={() => { setDecisionFilter(d); setPage(0); }}
                className={`px-3 py-1.5 rounded-full text-[11px] font-bold transition ${decisionFilter === d ? "bg-cyan text-background" : "bg-secondary text-muted-foreground"}`}>
                {d || "All"}
              </button>
            ))}
          </div>
        </>
      )}

      <SectionHeader>Decision Log — Page {page + 1}</SectionHeader>

      {decisionsLoading ? <CenterLoader /> : (
        <div className="space-y-2">
          {(decisions?.rows ?? []).map((row: Record<string, unknown>) => {
            const profile = row.profiles as Record<string, string>;
            return (
              <div key={row.id as string} className="bg-card rounded-2xl border border-border p-4">
                <div className="flex items-center gap-2 mb-1">
                  <span className={`text-xs font-extrabold ${DECISION_COLORS[row.decision as string]}`}>
                    {row.decision as string}
                  </span>
                  <span className="text-[10px] text-muted-foreground">
                    {(row.confidence as number)}% confidence
                  </span>
                  <span className="ml-auto text-[10px] text-muted-foreground">
                    ${(row.amount_usd as number)?.toFixed(2)}
                  </span>
                </div>
                <p className="text-[11px] text-muted-foreground truncate">{row.reason as string}</p>
                <div className="flex gap-3 mt-1.5 text-[10px] text-muted-foreground">
                  <span>{profile?.full_name ?? "—"}</span>
                  <span>·</span>
                  <span>{row.brand as string}</span>
                  <span>·</span>
                  <span>Trust {row.trust_score as number} / Fraud {row.fraud_score as number}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex gap-2">
        <button disabled={page === 0} onClick={() => setPage(p => p - 1)}
          className="flex-1 py-2 rounded-xl bg-secondary text-xs font-bold disabled:opacity-40">← Prev</button>
        <button disabled={(decisions?.rows ?? []).length < 20} onClick={() => setPage(p => p + 1)}
          className="flex-1 py-2 rounded-xl bg-secondary text-xs font-bold disabled:opacity-40">Next →</button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// API KEYS TAB
// ═══════════════════════════════════════════════════════════════════
export function ApiKeysTab() {
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [addProvider, setAddProvider] = useState("squad");
  const [addKeyName, setAddKeyName] = useState("");
  const [addKeyValue, setAddKeyValue] = useState("");
  const [rotateId, setRotateId] = useState<string | null>(null);
  const [rotateValue, setRotateValue] = useState("");
  const [validating, setValidating] = useState<string | null>(null);

  const { data: keys, isLoading, refetch } = useQuery({
    queryKey: ["provider-keys"],
    queryFn: () => listProviderKeys({ data: {} }),
    staleTime: 30_000,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["provider-keys"] });
    refetch();
  };

  const handleCreate = async () => {
    if (!addKeyName || !addKeyValue) return toast.error("Provider, key name, and value are required");
    try {
      const res = await createProviderKey({ data: { provider: addProvider as Parameters<typeof createProviderKey>[0]["data"]["provider"], keyName: addKeyName, keyValue: addKeyValue } });
      if ((res as Record<string, unknown>).success) {
        toast.success(`Key created (masked: ${(res as Record<string, string>).maskedValue})`);
        setShowAdd(false); setAddKeyValue(""); setAddKeyName("");
        invalidate();
      } else {
        toast.error((res as Record<string, string>).error ?? "Failed");
      }
    } catch { toast.error("Network error"); }
  };

  const handleActivate = async (id: string) => {
    try {
      await activateProviderKey({ data: { keyId: id } });
      toast.success("Key activated"); invalidate();
    } catch { toast.error("Activate failed"); }
  };

  const handleDisable = async (id: string) => {
    try {
      await disableProviderKey({ data: { keyId: id } });
      toast.success("Key disabled"); invalidate();
    } catch { toast.error("Disable failed"); }
  };

  const handleRotate = async (id: string) => {
    if (!rotateValue) return toast.error("New key value required");
    try {
      await rotateProviderKey({ data: { keyId: id, newValue: rotateValue } });
      toast.success("Key rotated — activate the new key when ready");
      setRotateId(null); setRotateValue(""); invalidate();
    } catch { toast.error("Rotate failed"); }
  };

  const handleValidate = async (id: string) => {
    setValidating(id);
    try {
      const res = await validateProviderKey({ data: { keyId: id } });
      const r = res as Record<string, unknown>;
      if (r.healthy) toast.success(r.message as string ?? "Healthy");
      else toast.error(r.message as string ?? "Unhealthy");
      invalidate();
    } catch { toast.error("Validation failed"); }
    setValidating(null);
  };

  const PROVIDERS = ["squad", "paystack", "flutterwave", "mono", "dojah", "reloadly", "busha", "ivoryPay", "resend", "oneSignal", "telegram", "adminTelegram", "supabase"];

  const healthColor = (s: string) =>
    s === "healthy" ? "text-emerald-400" : s === "degraded" ? "text-gold" : s === "unhealthy" ? "text-pink" : "text-white/40";

  return (
    <div className="p-5 space-y-4">
      <div className="flex items-center justify-between">
        <SectionHeader>Provider API Keys</SectionHeader>
        <button onClick={() => setShowAdd(v => !v)}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-cyan/20 text-cyan rounded-full text-[11px] font-bold">
          <Key className="size-3" /> Add Key
        </button>
      </div>

      {/* Add key form */}
      {showAdd && (
        <div className="bg-card rounded-2xl border border-cyan/30 p-4 space-y-3">
          <SectionHeader>New Key</SectionHeader>
          <select value={addProvider} onChange={e => setAddProvider(e.target.value)}
            className="w-full bg-background border border-border rounded-xl px-3 py-2 text-sm">
            {PROVIDERS.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
          <input value={addKeyName} onChange={e => setAddKeyName(e.target.value)} placeholder="Key name (e.g. SQUADCO_SECRET_KEY)"
            className="w-full bg-background border border-border rounded-xl px-3 py-2 text-sm" />
          <input type="password" value={addKeyValue} onChange={e => setAddKeyValue(e.target.value)} placeholder="Key value"
            className="w-full bg-background border border-border rounded-xl px-3 py-2 text-sm" />
          <div className="flex gap-2">
            <button onClick={handleCreate} className="flex-1 bg-cyan text-background font-bold py-2 rounded-xl text-sm">Save</button>
            <button onClick={() => setShowAdd(false)} className="flex-1 bg-secondary text-muted-foreground font-bold py-2 rounded-xl text-sm">Cancel</button>
          </div>
          <p className="text-[10px] text-muted-foreground">Key is stored encrypted. Only a masked version is shown in the UI. Activate after creating.</p>
        </div>
      )}

      {isLoading ? <CenterLoader /> : (
        <div className="space-y-2">
          {(keys ?? []).map((k: Record<string, unknown>) => (
            <div key={k.id as string} className="bg-card rounded-2xl border border-border p-4">
              <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-bold">{k.provider as string}</span>
                    <span className="text-[10px] text-muted-foreground">{k.keyName as string}</span>
                    <StatusPill status={k.status as string} />
                    <span className={`text-[10px] font-semibold ${healthColor(k.healthStatus as string)}`}>
                      {k.healthStatus as string}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 mt-1">
                    <EyeOff className="size-3 text-muted-foreground" />
                    <span className="text-[11px] text-muted-foreground font-mono">{k.maskedValue as string}</span>
                    <span className="text-[10px] text-muted-foreground ml-2">v{k.version as number}</span>
                  </div>
                </div>
              </div>

              {/* Rotate form */}
              {rotateId === k.id && (
                <div className="mt-3 space-y-2">
                  <input type="password" value={rotateValue} onChange={e => setRotateValue(e.target.value)}
                    placeholder="New key value"
                    className="w-full bg-background border border-border rounded-xl px-3 py-2 text-sm" />
                  <div className="flex gap-2">
                    <button onClick={() => handleRotate(k.id as string)} className="flex-1 bg-gold text-background font-bold py-1.5 rounded-xl text-xs">Rotate</button>
                    <button onClick={() => { setRotateId(null); setRotateValue(""); }} className="flex-1 bg-secondary text-muted-foreground font-bold py-1.5 rounded-xl text-xs">Cancel</button>
                  </div>
                </div>
              )}

              {/* Actions */}
              <div className="flex gap-1.5 mt-3 flex-wrap">
                {k.status === "inactive" && (
                  <button onClick={() => handleActivate(k.id as string)}
                    className="flex items-center gap-1 px-2.5 py-1 bg-emerald-500/15 text-emerald-400 rounded-lg text-[10px] font-bold">
                    <Unlock className="size-3" /> Activate
                  </button>
                )}
                {k.status === "active" && (
                  <button onClick={() => handleDisable(k.id as string)}
                    className="flex items-center gap-1 px-2.5 py-1 bg-pink/10 text-pink rounded-lg text-[10px] font-bold">
                    <Lock className="size-3" /> Disable
                  </button>
                )}
                <button onClick={() => { setRotateId(k.id as string); setRotateValue(""); }}
                  className="flex items-center gap-1 px-2.5 py-1 bg-gold/10 text-gold rounded-lg text-[10px] font-bold">
                  <RotateCcw className="size-3" /> Rotate
                </button>
                <button onClick={() => handleValidate(k.id as string)} disabled={validating === k.id}
                  className="flex items-center gap-1 px-2.5 py-1 bg-cyan/10 text-cyan rounded-lg text-[10px] font-bold disabled:opacity-50">
                  {validating === k.id ? <Loader2 className="size-3 animate-spin" /> : <Activity className="size-3" />} Validate
                </button>
              </div>
            </div>
          ))}
          {(keys ?? []).length === 0 && (
            <div className="text-center py-12 text-muted-foreground">
              <Key className="size-8 mx-auto opacity-30 mb-2" />
              <p className="text-sm">No provider keys configured yet.</p>
              <p className="text-xs mt-1">Add a key above to get started.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// PROVIDER HEALTH TAB
// ═══════════════════════════════════════════════════════════════════
export function ProviderHealthTab() {
  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["provider-health"],
    queryFn: () => getProviderHealth({ data: {} }),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const metrics = data?.metrics ?? [];
  const gateways = [...new Set(metrics.map(m => m.gateway))].sort();

  const statusIcon = (s: string) =>
    s === "healthy" ? <CheckCircle2 className="size-4 text-emerald-400" />
    : s === "degraded" ? <AlertTriangle className="size-4 text-gold" />
    : s === "down" ? <XCircle className="size-4 text-pink" />
    : <Activity className="size-4 text-white/30" />;

  return (
    <div className="p-5 space-y-5">
      <div className="flex items-center justify-between">
        <SectionHeader>Provider Health</SectionHeader>
        <button onClick={() => refetch()} disabled={isFetching}
          className="flex items-center gap-1 px-3 py-1.5 bg-secondary rounded-full text-[11px] font-bold text-muted-foreground disabled:opacity-50">
          <RefreshCw className={`size-3 ${isFetching ? "animate-spin" : ""}`} /> Refresh
        </button>
      </div>

      {/* Summary pills */}
      {!isLoading && (
        <div className="grid grid-cols-3 gap-2">
          {["healthy", "degraded", "down"].map(s => {
            const count = metrics.filter(m => m.status === s).length;
            const colors: Record<string, string> = { healthy: "text-emerald-400 bg-emerald-500/10", degraded: "text-gold bg-gold/10", down: "text-pink bg-pink/10" };
            return (
              <div key={s} className={`rounded-2xl p-3 text-center ${colors[s]}`}>
                <p className="text-xl font-extrabold">{count}</p>
                <p className="text-[10px] font-semibold capitalize">{s}</p>
              </div>
            );
          })}
        </div>
      )}

      {isLoading ? <CenterLoader /> : (
        gateways.map(gateway => (
          <div key={gateway}>
            <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mb-2 capitalize">{gateway} Gateway</p>
            <div className="space-y-2">
              {metrics.filter(m => m.gateway === gateway).map(m => (
                <div key={m.provider} className="bg-card rounded-2xl border border-border p-4">
                  <div className="flex items-center gap-3">
                    {statusIcon(m.status)}
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-bold capitalize">{m.provider}</p>
                        <StatusPill status={m.status} />
                        {m.isFailover && (
                          <span className="text-[10px] text-gold font-semibold">FAILOVER</span>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-3 mt-1 text-[10px] text-muted-foreground">
                        <span>Success: <b className="text-foreground">{m.successRate}%</b></span>
                        <span>Calls: <b className="text-foreground">{m.totalCalls}</b></span>
                        <span>p50: <b className="text-foreground">{m.latencyP50Ms}ms</b></span>
                        <span>p95: <b className="text-foreground">{m.latencyP95Ms}ms</b></span>
                        {m.failoverCount > 0 && <span>Failovers: <b className="text-gold">{m.failoverCount}</b></span>}
                      </div>
                      {m.lastError && (
                        <p className="text-[10px] text-pink mt-1 truncate">⚠ {m.lastError}</p>
                      )}
                      {m.activeKeyMasked && (
                        <div className="flex items-center gap-1 mt-1 text-[10px] text-muted-foreground">
                          <EyeOff className="size-2.5" />
                          <span className="font-mono">{m.activeKeyMasked}</span>
                          {m.keyExpiresAt && (
                            <span className="ml-1 text-gold">expires {new Date(m.keyExpiresAt).toLocaleDateString()}</span>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="text-right">
                      <p className={`text-lg font-extrabold ${m.healthScore >= 80 ? "text-emerald-400" : m.healthScore >= 60 ? "text-gold" : "text-pink"}`}>
                        {m.healthScore}
                      </p>
                      <p className="text-[10px] text-muted-foreground">score</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))
      )}

      {data?.generatedAt && (
        <p className="text-[10px] text-muted-foreground text-center">
          Updated {new Date(data.generatedAt).toLocaleTimeString()}
        </p>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// PREMIUM ADMIN TAB
// ═══════════════════════════════════════════════════════════════════
export function PremiumAdminTab() {
  const [revDays, setRevDays] = useState(30);

  const { data: summary, isLoading: summaryLoading } = useQuery({
    queryKey: ["admin-premium-summary"],
    queryFn: () => getAdminPremiumSummary({ data: {} }),
    staleTime: 60_000,
  });

  const { data: revenue, isLoading: revLoading } = useQuery({
    queryKey: ["admin-premium-revenue", revDays],
    queryFn: () => getPremiumRevenueReport({ data: { days: revDays } }),
    staleTime: 60_000,
  });

  const { data: churn, isLoading: churnLoading } = useQuery({
    queryKey: ["admin-premium-churn"],
    queryFn: () => getPremiumChurnReport({ data: {} }),
    staleTime: 60_000,
  });

  const { data: users, isLoading: usersLoading } = useQuery({
    queryKey: ["premium-users"],
    queryFn: () => listPremiumUsers({ data: { page: 0, pageSize: 20 } }),
    staleTime: 60_000,
  });

  const s = summary as Record<string, unknown> | undefined;

  return (
    <div className="p-5 space-y-5">
      {/* KPI Cards */}
      {summaryLoading ? <CenterLoader /> : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <MetricCard icon={Crown}      label="Total Premium Users" value={(s?.totalPremium as number) ?? 0}                      color="text-gold"         />
            <MetricCard icon={TrendingUp} label="Conversion Rate"      value={`${s?.conversionRate as number ?? 0}%`}               color="text-cyan"         />
            <MetricCard icon={Heart}      label="Retention Rate"       value={`${s?.retentionRate as number ?? 0}%`}                color="text-emerald-400"  />
            <MetricCard icon={BarChart3}  label="New This Month"       value={(s?.newThisMonth as number) ?? 0}                     color="text-cyan"         />
          </div>

          {/* Revenue allocation breakdown */}
          <div className="bg-card rounded-2xl border border-border p-4">
            <SectionHeader>Monthly Revenue Allocation</SectionHeader>
            <p className="text-2xl font-extrabold text-gold">{ngn((s?.monthlyRevenue as number) ?? 0)}</p>
            <p className="text-[11px] text-muted-foreground mb-3">this month</p>
            {[
              { label: "Treasury Growth (40%)",    value: s?.treasuryAllocation as number,  color: "bg-emerald-500" },
              { label: "Fraud Reserve (20%)",      value: s?.fraudReserveAlloc as number,   color: "bg-pink"        },
              { label: "Operations (20%)",         value: s?.operationsAlloc as number,     color: "bg-cyan"        },
              { label: "Infrastructure (10%)",     value: s?.infrastructureAlloc as number, color: "bg-gold"        },
              { label: "Growth & Expansion (10%)", value: s?.growthAlloc as number,         color: "bg-purple-400"  },
            ].map(({ label, value, color }) => (
              <div key={label} className="flex items-center justify-between py-1.5">
                <div className="flex items-center gap-2">
                  <div className={`size-2 rounded-full ${color}`} />
                  <p className="text-[11px] text-muted-foreground">{label}</p>
                </div>
                <p className="text-[11px] font-bold">{ngn(value ?? 0)}</p>
              </div>
            ))}
          </div>

          {/* Liquidity Pool */}
          {(s?.liquidity as Record<string, unknown>) && (
            <div className="bg-gold/10 border border-gold/30 rounded-2xl p-4">
              <div className="flex items-center gap-2 mb-2">
                <Wallet className="size-4 text-gold" />
                <p className="text-xs font-bold text-gold">Premium Liquidity Pool</p>
              </div>
              <p className="text-xl font-extrabold">{ngn((s?.liquidity as Record<string, number>).totalAllocated ?? 0)}</p>
              <p className="text-[11px] text-muted-foreground">Total treasury allocated from premium revenue</p>
            </div>
          )}
        </>
      )}

      {/* Revenue period chart */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <SectionHeader>Revenue History</SectionHeader>
          <div className="flex gap-1">
            {[7, 30, 90].map(d => (
              <button key={d} onClick={() => setRevDays(d)}
                className={`px-2.5 py-1 rounded-full text-[10px] font-bold transition ${revDays === d ? "bg-gold text-background" : "bg-secondary text-muted-foreground"}`}>
                {d}d
              </button>
            ))}
          </div>
        </div>
        {revLoading ? <CenterLoader /> : (
          <div className="space-y-1.5">
            {((revenue as Record<string, unknown>)?.daily as Array<{ date: string; revenue: number }> ?? []).slice(-10).map(({ date, revenue: rev }) => (
              <div key={date} className="flex items-center gap-3 bg-card rounded-xl border border-border px-3 py-2">
                <p className="text-[11px] text-muted-foreground w-24 shrink-0">{date}</p>
                <div className="flex-1 h-1.5 bg-secondary rounded-full overflow-hidden">
                  <div className="h-full bg-gold rounded-full"
                    style={{ width: `${Math.min(100, (rev / PREMIUM_PRICE_NGN) * 100)}%` }} />
                </div>
                <p className="text-[11px] font-bold w-24 text-right">{ngn(rev)}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Churn / Retention */}
      {churnLoading ? null : (
        <div className="bg-card rounded-2xl border border-border p-4">
          <SectionHeader>Retention & Churn (30d)</SectionHeader>
          <div className="grid grid-cols-3 gap-3">
            <div className="text-center">
              <p className="text-xl font-extrabold text-emerald-400">{(churn as Record<string, number>)?.newLast30 ?? 0}</p>
              <p className="text-[10px] text-muted-foreground">New</p>
            </div>
            <div className="text-center">
              <p className="text-xl font-extrabold text-pink">{(churn as Record<string, number>)?.churnedLast30 ?? 0}</p>
              <p className="text-[10px] text-muted-foreground">Churned</p>
            </div>
            <div className="text-center">
              <p className="text-xl font-extrabold text-gold">{pct((churn as Record<string, number>)?.churnRate30 ?? 0)}</p>
              <p className="text-[10px] text-muted-foreground">Churn Rate</p>
            </div>
          </div>
        </div>
      )}

      {/* Premium users list */}
      <SectionHeader>Premium Members</SectionHeader>
      {usersLoading ? <CenterLoader /> : (
        <div className="space-y-2">
          {((users as Record<string, unknown>)?.users as Array<Record<string, unknown>> ?? []).map((u) => {
            const sub = (u.subscriptions as Array<Record<string, unknown>>)?.[0];
            const ts  = (u.trust_scores as Array<Record<string, unknown>>)?.[0];
            return (
              <div key={u.id as string} className="bg-card rounded-2xl border border-gold/20 p-4 flex items-center gap-3">
                <div className="size-9 rounded-xl bg-gold/20 grid place-items-center">
                  <Crown className="size-4 text-gold" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold truncate">{u.full_name as string ?? "—"}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {u.phone as string ?? "—"}
                    {ts && <> · Trust <span className="font-bold text-cyan">{ts.trust_score as number}</span> ({ts.trust_level as string})</>}
                  </p>
                </div>
                {sub && (
                  <div className="text-right shrink-0">
                    <p className="text-[11px] font-bold text-emerald-400">{ngn(sub.amount_ngn as number ?? 2000)}/mo</p>
                    <p className="text-[10px] text-muted-foreground">
                      since {new Date(sub.started_at as string).toLocaleDateString("en-NG", { month: "short", year: "numeric" })}
                    </p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// constant re-used in revenue history bar width calculation
const PREMIUM_PRICE_NGN = 2_000;
