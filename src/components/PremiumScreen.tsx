import React, { useState } from "react";
import {
  ChevronLeft, Sparkles, CheckCircle2, Zap, ShieldCheck,
  Clock, Crown, Loader2, AlertCircle, Star, TrendingUp,
  Headphones, Wallet, X,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getPremiumStatus,
  createPremiumCheckout,
  activatePremium,
  cancelPremium,
} from "../server-functions/premium";

const BENEFITS = [
  { icon: TrendingUp, label: "+2% better rates on every trade",   sub: "Earn more NGN per dollar traded"         },
  { icon: Zap,        label: "Priority payouts",                  sub: "Funds land in 60s, not 5 minutes"        },
  { icon: Wallet,     label: "10× higher daily payout limit",     sub: "Up to ₦5,000,000/day vs ₦500,000"       },
  { icon: ShieldCheck,label: "Express KYC review",                sub: "Verified in 1 hour, not 24"              },
  { icon: Headphones, label: "24/7 priority support",             sub: "Jump the queue, instant responses"       },
  { icon: Crown,      label: "PRO badge on the leaderboard",      sub: "Stand out among top traders"             },
];

interface PremiumScreenProps {
  userId: string;
  userEmail: string;
  userName: string;
  onBack: () => void;
}

export function PremiumScreen({ userId, userEmail, userName, onBack }: PremiumScreenProps) {
  const qc = useQueryClient();
  const [loading, setLoading]           = useState(false);
  const [error, setError]               = useState("");
  const [showCancel, setShowCancel]     = useState(false);
  const [cancelling, setCancelling]     = useState(false);

  const { data: status, isLoading } = useQuery({
    queryKey: ["premium-status", userId],
    queryFn: () => getPremiumStatus({ data: { userId } }),
    staleTime: 30_000,
  });

  const isPremium = status?.isPremium ?? false;
  const sub       = status?.subscription as null | {
    started_at: string; expires_at: string | null; transaction_ref: string;
  };

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["premium-status", userId] });
    qc.invalidateQueries({ queryKey: ["profile", userId] });
    qc.invalidateQueries({ queryKey: ["notifications", userId] });
  };

  const handleUpgrade = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await createPremiumCheckout({ data: {} });

      if (!(res as { success: boolean }).success) {
        setError((res as { error?: string }).error ?? "Something went wrong");
        return;
      }

      const checkoutUrl = (res as { checkoutUrl?: string | null }).checkoutUrl;
      const isDemo      = (res as { demo?: boolean }).demo;

      if (isDemo || !checkoutUrl) {
        // Demo mode — activate directly without payment
        await activatePremium({
          data: { transactionRef: (res as { transactionRef: string }).transactionRef },
        });
        invalidate();
      } else {
        // Open Squadco checkout in the same tab
        window.location.href = checkoutUrl;
      }
    } catch {
      setError("Could not start checkout. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = async () => {
    setCancelling(true);
    try {
      await cancelPremium({ data: {} });
      invalidate();
      setShowCancel(false);
    } finally {
      setCancelling(false);
    }
  };

  const fmtDate = (iso: string) =>
    new Date(iso).toLocaleDateString("en-NG", { day: "numeric", month: "long", year: "numeric" });

  return (
    <div className="flex flex-col min-h-screen bg-background pb-8">
      <div className="mx-auto w-full max-w-[480px] flex flex-col">

        {/* Header */}
        <header className="px-5 pt-12 pb-4 flex items-center gap-4">
          <button onClick={onBack} className="size-10 rounded-full bg-card border border-border grid place-items-center">
            <ChevronLeft className="size-5" />
          </button>
          <div className="flex-1">
            <h1 className="text-xl font-extrabold">7SEVEN Premium</h1>
            <p className="text-xs text-muted-foreground">Trade smarter, earn more</p>
          </div>
          {isPremium && (
            <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-gold/20 text-gold text-[11px] font-bold">
              <Crown className="size-3" /> PRO Active
            </span>
          )}
        </header>

        <div className="px-5 flex flex-col gap-5">

          {isLoading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="size-7 animate-spin text-muted-foreground" />
            </div>
          ) : isPremium ? (
            /* ── ACTIVE PREMIUM ───────────────────────────────────────────── */
            <>
              {/* Status card */}
              <div className="bg-gradient-hero rounded-3xl p-6 shadow-glow-jungle relative overflow-hidden">
                <div className="absolute -right-8 -top-8 size-40 rounded-full bg-gold/20 blur-2xl" />
                <div className="flex items-center gap-4 relative">
                  <div className="size-16 rounded-2xl bg-gold/20 grid place-items-center shadow-glow-gold">
                    <Crown className="size-8 text-gold" />
                  </div>
                  <div>
                    <p className="text-xs text-white/60 font-medium">Subscription Active</p>
                    <p className="text-xl font-extrabold text-white">7SEVEN PRO</p>
                    {sub?.expires_at && (
                      <p className="text-xs text-gold mt-1">
                        Renews {fmtDate(sub.expires_at)}
                      </p>
                    )}
                  </div>
                </div>

                <div className="mt-5 grid grid-cols-2 gap-3 relative">
                  <div className="bg-white/10 rounded-2xl p-3">
                    <p className="text-[10px] text-white/60">Member since</p>
                    <p className="text-sm font-bold text-white">
                      {sub?.started_at ? fmtDate(sub.started_at) : "—"}
                    </p>
                  </div>
                  <div className="bg-white/10 rounded-2xl p-3">
                    <p className="text-[10px] text-white/60">Monthly cost</p>
                    <p className="text-sm font-bold text-white">₦2,000</p>
                  </div>
                </div>
              </div>

              {/* Active benefits */}
              <div>
                <p className="text-xs text-muted-foreground font-bold uppercase tracking-wider mb-3">Your Benefits</p>
                <div className="space-y-2">
                  {BENEFITS.map(({ icon: Icon, label, sub: s }) => (
                    <div key={label} className="flex items-center gap-3 bg-card rounded-2xl border border-gold/20 p-4">
                      <div className="size-10 rounded-xl bg-gold/15 grid place-items-center flex-shrink-0">
                        <Icon className="size-5 text-gold" />
                      </div>
                      <div className="flex-1">
                        <p className="text-sm font-semibold">{label}</p>
                        <p className="text-[11px] text-muted-foreground">{s}</p>
                      </div>
                      <CheckCircle2 className="size-4 text-cyan flex-shrink-0" />
                    </div>
                  ))}
                </div>
              </div>

              {/* Cancel */}
              <button
                onClick={() => setShowCancel(true)}
                className="text-xs text-muted-foreground font-semibold text-center py-3"
              >
                Cancel subscription
              </button>
            </>
          ) : (
            /* ── UPGRADE FLOW ─────────────────────────────────────────────── */
            <>
              {/* Hero */}
              <div className="bg-gradient-hero rounded-3xl p-6 shadow-glow-jungle relative overflow-hidden text-center">
                <div className="absolute -right-8 -top-8 size-40 rounded-full bg-gold/20 blur-2xl" />
                <div className="absolute -left-8 -bottom-8 size-32 rounded-full bg-pink/10 blur-2xl" />
                <div className="size-20 rounded-3xl bg-gold/20 grid place-items-center mx-auto shadow-glow-gold relative">
                  <Crown className="size-10 text-gold" />
                </div>
                <p className="text-2xl font-extrabold text-white mt-4">Go Premium</p>
                <p className="text-sm text-white/70 mt-2">
                  Unlock everything 7SEVEN has to offer
                </p>
                <div className="mt-4 flex items-end justify-center gap-1">
                  <span className="text-4xl font-extrabold text-white">₦2,000</span>
                  <span className="text-sm text-white/60 pb-1.5">/month</span>
                </div>
                <p className="text-[11px] text-gold mt-1">Cancel anytime · No hidden fees</p>
              </div>

              {/* Benefits list */}
              <div>
                <p className="text-xs text-muted-foreground font-bold uppercase tracking-wider mb-3">What you get</p>
                <div className="space-y-2">
                  {BENEFITS.map(({ icon: Icon, label, sub: s }) => (
                    <div key={label} className="flex items-center gap-3 bg-card rounded-2xl border border-border/60 p-4">
                      <div className="size-10 rounded-xl bg-secondary grid place-items-center flex-shrink-0">
                        <Icon className="size-5 text-muted-foreground" />
                      </div>
                      <div className="flex-1">
                        <p className="text-sm font-semibold">{label}</p>
                        <p className="text-[11px] text-muted-foreground">{s}</p>
                      </div>
                      <Star className="size-4 text-gold flex-shrink-0" />
                    </div>
                  ))}
                </div>
              </div>

              {/* Comparison table */}
              <div className="bg-card rounded-3xl border border-border overflow-hidden">
                <div className="grid grid-cols-3 text-center text-[11px] font-bold">
                  <div className="p-3 border-b border-border text-muted-foreground">Feature</div>
                  <div className="p-3 border-b border-l border-border text-muted-foreground">Free</div>
                  <div className="p-3 border-b border-l border-border bg-gold/10 text-gold">PRO</div>
                </div>
                {[
                  ["Daily limit",    "₦500k",      "₦5M"],
                  ["Rate bonus",     "—",          "+2%"],
                  ["Payout speed",   "~5 min",     "~60s"],
                  ["KYC review",     "24h",        "1h"],
                  ["Support",        "Standard",   "24/7"],
                  ["Leaderboard",    "Normal",     "PRO badge"],
                ].map(([feat, free, pro]) => (
                  <div key={feat} className="grid grid-cols-3 text-center text-xs border-b border-border last:border-0">
                    <div className="p-3 text-left text-muted-foreground font-medium">{feat}</div>
                    <div className="p-3 border-l border-border text-muted-foreground">{free}</div>
                    <div className="p-3 border-l border-border bg-gold/5 font-bold text-gold">{pro}</div>
                  </div>
                ))}
              </div>

              {error && (
                <div className="flex items-start gap-2 bg-pink/10 border border-pink/30 rounded-2xl p-3">
                  <AlertCircle className="size-4 text-pink shrink-0 mt-0.5" />
                  <p className="text-xs font-semibold text-pink">{error}</p>
                </div>
              )}

              {/* CTA */}
              <button
                onClick={handleUpgrade}
                disabled={loading}
                className="w-full bg-gradient-gold text-jungle-deep font-extrabold py-4 rounded-2xl flex items-center justify-center gap-2 shadow-glow-gold disabled:opacity-50 transition"
              >
                {loading
                  ? <><Loader2 className="size-5 animate-spin" /> Processing…</>
                  : <><Crown className="size-5" /> Get Premium · ₦2,000/mo</>}
              </button>

              <div className="flex items-center gap-2 justify-center">
                <ShieldCheck className="size-3.5 text-muted-foreground" />
                <p className="text-[11px] text-muted-foreground text-center">
                  Secured by Squadco · Cancel anytime from your profile
                </p>
              </div>

              {/* Social proof */}
              <div className="flex items-center gap-3 bg-card rounded-2xl border border-border p-4">
                <div className="flex -space-x-2">
                  {["A","B","C"].map((l) => (
                    <div key={l} className="size-7 rounded-full bg-gradient-gold grid place-items-center text-jungle-deep text-[10px] font-extrabold ring-2 ring-card">
                      {l}
                    </div>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground flex-1">
                  <span className="font-bold text-foreground">1,200+ traders</span> already on Premium
                </p>
                <div className="flex">
                  {[1,2,3,4,5].map((s) => <Star key={s} className="size-3 fill-gold text-gold" />)}
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── CANCEL CONFIRM SHEET ───────────────────────────────────────────── */}
      {showCancel && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-end">
          <div className="w-full max-w-[480px] mx-auto bg-card rounded-t-3xl p-6 pb-8 flex flex-col gap-4">
            <div className="w-10 h-1 rounded-full bg-border mx-auto" />
            <div className="flex items-center gap-3">
              <div className="size-12 rounded-2xl bg-pink/15 grid place-items-center">
                <X className="size-6 text-pink" />
              </div>
              <div>
                <p className="text-base font-extrabold">Cancel Premium?</p>
                <p className="text-xs text-muted-foreground">You'll lose all PRO benefits immediately</p>
              </div>
            </div>
            <div className="space-y-2">
              {["Higher payout limits", "+2% rate bonus", "Priority payouts", "PRO badge"].map((b) => (
                <div key={b} className="flex items-center gap-2 text-sm text-muted-foreground">
                  <X className="size-3.5 text-pink shrink-0" /> {b}
                </div>
              ))}
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => setShowCancel(false)}
                className="flex-1 bg-gradient-gold text-jungle-deep font-bold py-3.5 rounded-2xl text-sm"
              >
                Keep Premium
              </button>
              <button
                onClick={handleCancel}
                disabled={cancelling}
                className="flex-1 bg-secondary text-pink font-bold py-3.5 rounded-2xl text-sm flex items-center justify-center gap-2 disabled:opacity-60"
              >
                {cancelling ? <Loader2 className="size-4 animate-spin" /> : null}
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
