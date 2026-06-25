// ─────────────────────────────────────────────────────────────────────────────
// Kill Switch Panel — Production Safety Layer
//
// Super-admin only: toggle kill switches for treasury, withdrawals, providers.
// Each switch shows its current state, last changed time, and who changed it.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import {
  Shield, ShieldAlert, RefreshCw, Loader2,
  AlertTriangle, CheckCircle2, Lock, Unlock, Zap,
} from "lucide-react";
import { getKillSwitchStatus, toggleKillSwitch } from "../server-functions/kill-switch";

type KS = Awaited<ReturnType<typeof getKillSwitchStatus>>[number];

function timeAgo(iso: string | null) {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  const m    = Math.floor(diff / 60_000);
  if (m < 1)  return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const CATEGORY_ORDER = [
  { label: "💰 Financial Operations", keys: ["kill_switch_treasury", "kill_switch_withdrawals", "kill_switch_new_trades"] },
  { label: "🔌 Provider Gateways",    keys: ["kill_switch_provider_squad", "kill_switch_provider_reloadly", "kill_switch_provider_busha"] },
];

export function KillSwitchPanel() {
  const [switches,   setSwitches]   = useState<KS[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [toggling,   setToggling]   = useState<string | null>(null);
  const [confirmed,  setConfirmed]  = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getKillSwitchStatus({ data: {} });
      setSwitches(data);
    } catch (e) {
      toast.error("Failed to load kill switch status");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const requestToggle = (ks: KS) => {
    setConfirmed(ks.key);
  };

  const confirmToggle = async (ks: KS) => {
    setConfirmed(null);
    setToggling(ks.key);
    try {
      await toggleKillSwitch({ data: { key: ks.key, frozen: !ks.frozen } });
      toast.success(ks.frozen ? `${ks.label} kill switch RELEASED` : `${ks.label} kill switch ENGAGED`);
      await load();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Toggle failed");
    } finally {
      setToggling(null);
    }
  };

  const byKey = new Map(switches.map(s => [s.key, s]));
  const frozenCount = switches.filter(s => s.frozen).length;

  return (
    <div className="p-5 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={`size-10 rounded-2xl grid place-items-center ${frozenCount > 0 ? "bg-red-500/20" : "bg-green-500/20"}`}>
            {frozenCount > 0
              ? <ShieldAlert className="size-5 text-red-400" />
              : <Shield className="size-5 text-green-400" />
            }
          </div>
          <div>
            <h2 className="font-bold text-white">Kill Switches</h2>
            <p className="text-[11px] text-muted-foreground">
              {frozenCount === 0
                ? "All systems operational"
                : `${frozenCount} system${frozenCount > 1 ? "s" : ""} frozen`}
            </p>
          </div>
        </div>
        <button onClick={load} disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-secondary rounded-full text-[11px] font-bold text-muted-foreground disabled:opacity-50">
          <RefreshCw className={`size-3 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {/* Aggregate status */}
      {frozenCount > 0 && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-2xl p-4 flex items-center gap-3">
          <AlertTriangle className="size-5 text-red-400 flex-shrink-0" />
          <div>
            <p className="text-sm font-bold text-red-300">
              {frozenCount} Kill Switch{frozenCount > 1 ? "es" : ""} Active
            </p>
            <p className="text-[11px] text-red-400/80 mt-0.5">
              Affected operations are blocked for all users until released.
            </p>
          </div>
        </div>
      )}

      {loading && switches.length === 0 && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      )}

      {/* Categories */}
      {CATEGORY_ORDER.map(cat => (
        <div key={cat.label}>
          <h3 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">
            {cat.label}
          </h3>
          <div className="bg-gradient-card rounded-2xl border border-white/5 divide-y divide-white/5">
            {cat.keys.map(key => {
              const ks = byKey.get(key);
              if (!ks) return null;
              const isToggling = toggling === key;
              const needsConfirm = confirmed === key;

              return (
                <div key={key} className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <div className={`size-2 rounded-full flex-shrink-0 ${ks.frozen ? "bg-red-400" : "bg-green-400"}`} />
                        <span className="text-sm font-bold text-white">{ks.label}</span>
                        {ks.frozen && (
                          <span className="text-[10px] font-bold bg-red-500/20 text-red-300 px-2 py-0.5 rounded-full">
                            FROZEN
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-muted-foreground mt-1">{ks.description}</p>
                      <p className="text-[10px] text-muted-foreground/60 mt-0.5">
                        Changed {timeAgo(ks.updatedAt)}
                      </p>
                    </div>

                    {/* Toggle button or confirm */}
                    {needsConfirm ? (
                      <div className="flex flex-col items-end gap-1.5">
                        <p className="text-[10px] text-amber-400 font-bold">Confirm?</p>
                        <div className="flex gap-1.5">
                          <button
                            onClick={() => setConfirmed(null)}
                            className="px-2.5 py-1 bg-secondary rounded-lg text-[10px] font-bold text-muted-foreground"
                          >
                            Cancel
                          </button>
                          <button
                            onClick={() => confirmToggle(ks)}
                            className={`px-2.5 py-1 rounded-lg text-[10px] font-bold text-white
                              ${ks.frozen ? "bg-green-600" : "bg-red-600"}`}
                          >
                            {ks.frozen ? "Release" : "Freeze"}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        onClick={() => requestToggle(ks)}
                        disabled={isToggling}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[11px] font-bold transition-colors disabled:opacity-50
                          ${ks.frozen
                            ? "bg-green-500/15 text-green-400 border border-green-500/30"
                            : "bg-red-500/15 text-red-400 border border-red-500/30"
                          }`}
                      >
                        {isToggling
                          ? <Loader2 className="size-3 animate-spin" />
                          : ks.frozen
                            ? <Unlock className="size-3" />
                            : <Lock className="size-3" />
                        }
                        {ks.frozen ? "Release" : "Freeze"}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {/* Warning notice */}
      <div className="bg-amber-500/10 border border-amber-500/20 rounded-2xl p-4 flex items-start gap-3">
        <Zap className="size-4 text-amber-400 flex-shrink-0 mt-0.5" />
        <p className="text-[11px] text-amber-300/80 leading-relaxed">
          Kill switches propagate within 30 seconds (one cache TTL). Every toggle is logged to the audit trail and fires an admin Telegram alert. Only <strong>super_admin</strong> accounts can change these.
        </p>
      </div>

      {/* All clear */}
      {frozenCount === 0 && !loading && (
        <div className="flex items-center gap-2 justify-center py-2">
          <CheckCircle2 className="size-4 text-green-400" />
          <span className="text-[12px] text-green-400 font-semibold">All systems fully operational</span>
        </div>
      )}
    </div>
  );
}
