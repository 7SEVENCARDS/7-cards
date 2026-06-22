import React, { useState } from "react";
import {
  ChevronLeft, Copy, Share2, CheckCircle2, Clock,
  Gift, Users, Loader2, Wallet, ChevronRight, Zap,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getReferralStats, applyReferralCode } from "../server-functions/referrals";
import type { ReferralStats, ReferredUser } from "../server-functions/referrals";

interface ReferralScreenProps {
  userId: string;
  onBack: () => void;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const d = Math.floor(diff / 86_400_000);
  if (d === 0) return "Today";
  if (d === 1) return "Yesterday";
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString("en-NG", { day: "numeric", month: "short" });
}

function maskName(name: string | null): string {
  if (!name) return "Anonymous";
  const parts = name.trim().split(" ");
  return parts.map((p, i) => i === 0 ? p : p[0] + "*".repeat(p.length - 1)).join(" ");
}

export function ReferralScreen({ userId, onBack }: ReferralScreenProps) {
  const qc = useQueryClient();
  const [copied, setCopied]     = useState(false);
  const [codeInput, setCodeInput] = useState("");
  const [applying, setApplying] = useState(false);
  const [applyMsg, setApplyMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const { data: stats, isLoading } = useQuery<ReferralStats>({
    queryKey: ["referral-stats", userId],
    queryFn: () => getReferralStats({ data: { userId } }),
    staleTime: 30_000,
  });

  const referralLink = stats?.referralCode
    ? `https://7evencards.xyz/join?ref=${stats.referralCode}`
    : "";

  const handleCopy = async () => {
    await navigator.clipboard.writeText(referralLink || stats?.referralCode || "");
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleShare = async () => {
    if (navigator.share) {
      await navigator.share({
        title: "Join 7SEVEN CARDS",
        text: `Trade gift cards for instant NGN payouts on 7SEVEN CARDS. Use my code ${stats?.referralCode} and we both earn! 🚀`,
        url: referralLink,
      }).catch(() => {});
    } else {
      handleCopy();
    }
  };

  const handleApplyCode = async () => {
    if (!codeInput.trim()) return;
    setApplying(true);
    setApplyMsg(null);
    try {
      const res = await applyReferralCode({ data: { code: codeInput.trim() } });
      if ((res as { success: boolean }).success) {
        setApplyMsg({ ok: true, text: "Code applied! You'll both earn when you complete your first trade." });
        qc.invalidateQueries({ queryKey: ["profile", userId] });
        setCodeInput("");
      } else {
        setApplyMsg({ ok: false, text: (res as { error?: string }).error ?? "Could not apply code." });
      }
    } catch {
      setApplyMsg({ ok: false, text: "Network error — please try again." });
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="flex flex-col min-h-dvh bg-background pb-8">
      <div className="mx-auto w-full max-w-[480px] flex flex-col">

        {/* Header */}
        <header className="px-5 pt-safe-top pb-4 flex items-center gap-4">
          <button onClick={onBack} className="size-10 rounded-full bg-card border border-border grid place-items-center">
            <ChevronLeft className="size-5" />
          </button>
          <div className="flex-1">
            <h1 className="text-xl font-extrabold">Referral Programme</h1>
            <p className="text-xs text-muted-foreground">Earn 5% of every trade your friends make</p>
          </div>
        </header>

        <div className="px-5 flex flex-col gap-5">

          {/* Hero earnings card */}
          <div className="bg-gradient-hero rounded-3xl p-5 shadow-glow-jungle relative overflow-hidden">
            <div className="absolute -right-10 -top-10 size-40 rounded-full bg-gold/10 blur-2xl" />
            <div className="absolute -left-6 -bottom-6 size-32 rounded-full bg-pink/10 blur-2xl" />

            <div className="flex items-start justify-between relative">
              <div>
                <p className="text-xs text-white/60 font-medium uppercase tracking-wider">Total Earned</p>
                {isLoading
                  ? <div className="h-10 w-32 bg-white/10 rounded-xl animate-pulse mt-1" />
                  : <p className="text-4xl font-extrabold text-white mt-1">
                      ₦{(stats?.totalEarnedNgn ?? 0).toLocaleString()}
                    </p>
                }
                <p className="text-xs text-gold mt-2 font-semibold">
                  {stats?.earnedCount ?? 0} friend{(stats?.earnedCount ?? 0) !== 1 ? "s" : ""} traded · 5% each
                </p>
              </div>
              <div className="size-14 rounded-2xl bg-white/10 grid place-items-center">
                <Gift className="size-7 text-gold" />
              </div>
            </div>

            {/* Quick stats row */}
            <div className="flex gap-3 mt-5">
              {[
                { icon: Users,        label: "Referred",  value: stats?.totalReferred ?? 0, color: "text-white"  },
                { icon: CheckCircle2, label: "Traded",    value: stats?.earnedCount   ?? 0, color: "text-cyan"   },
                { icon: Clock,        label: "Pending",   value: stats?.pendingCount  ?? 0, color: "text-gold"   },
              ].map(({ icon: Icon, label, value, color }) => (
                <div key={label} className="flex-1 bg-white/10 rounded-2xl p-3 text-center">
                  <Icon className={`size-4 ${color} mx-auto`} />
                  <p className="text-lg font-extrabold text-white mt-1">{value}</p>
                  <p className="text-[10px] text-white/60">{label}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Referral code card */}
          <div className="bg-card rounded-3xl border border-border p-5">
            <p className="text-xs text-muted-foreground font-bold uppercase tracking-wider mb-3">Your Referral Code</p>
            {isLoading
              ? <div className="h-16 bg-secondary rounded-2xl animate-pulse" />
              : (
                <div className="bg-secondary rounded-2xl p-4 flex items-center justify-between">
                  <p className="text-3xl font-extrabold tracking-[0.2em] text-foreground">
                    {stats?.referralCode ?? "——"}
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={handleCopy}
                      className={`size-10 rounded-xl grid place-items-center transition ${copied ? "bg-cyan/20 text-cyan" : "bg-card border border-border text-muted-foreground hover:text-foreground"}`}
                    >
                      {copied ? <CheckCircle2 className="size-4" /> : <Copy className="size-4" />}
                    </button>
                    <button
                      onClick={handleShare}
                      className="size-10 rounded-xl bg-gold/15 text-gold grid place-items-center hover:bg-gold/25 transition"
                    >
                      <Share2 className="size-4" />
                    </button>
                  </div>
                </div>
              )}
            <p className="text-[11px] text-muted-foreground mt-3 text-center">
              Share your code. You earn 5% of every trade your friend completes — forever.
            </p>
            <button
              onClick={handleShare}
              className="mt-3 w-full bg-gradient-gold text-jungle-deep font-extrabold py-3.5 rounded-2xl flex items-center justify-center gap-2 shadow-glow-gold"
            >
              <Share2 className="size-4" /> Share My Code
            </button>
          </div>

          {/* How it works */}
          <div>
            <p className="text-xs text-muted-foreground font-bold uppercase tracking-wider mb-3">How it works</p>
            <div className="space-y-2">
              {[
                { step: "1", icon: Share2,       text: "Share your code with friends"                         },
                { step: "2", icon: Users,        text: "Friend signs up using your code"                      },
                { step: "3", icon: Zap,          text: "They complete their first card trade"                  },
                { step: "4", icon: Wallet,       text: "5% of their trade value lands in your wallet instantly" },
              ].map(({ step, icon: Icon, text }) => (
                <div key={step} className="flex items-center gap-3 bg-card rounded-2xl border border-border/60 p-4">
                  <div className="size-8 rounded-xl bg-gold/15 text-gold text-xs font-extrabold grid place-items-center flex-shrink-0">
                    {step}
                  </div>
                  <Icon className="size-4 text-muted-foreground flex-shrink-0" />
                  <p className="text-sm text-muted-foreground flex-1">{text}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Apply someone else's code */}
          <div className="bg-card rounded-3xl border border-border p-5">
            <p className="text-xs text-muted-foreground font-bold uppercase tracking-wider mb-3">
              Have a friend's code?
            </p>
            <div className="flex gap-2">
              <input
                value={codeInput}
                onChange={(e) => setCodeInput(e.target.value.toUpperCase().slice(0, 8))}
                placeholder="E.g. A3F9B2C1"
                className="flex-1 bg-secondary rounded-xl px-4 py-3 text-sm font-mono font-bold tracking-widest outline-none border border-border focus:border-gold/50 transition"
              />
              <button
                onClick={handleApplyCode}
                disabled={applying || !codeInput.trim()}
                className="px-4 py-3 bg-gold/15 text-gold font-bold rounded-xl text-sm flex items-center gap-1.5 disabled:opacity-50 hover:bg-gold/25 transition"
              >
                {applying ? <Loader2 className="size-4 animate-spin" /> : <ChevronRight className="size-4" />}
                Apply
              </button>
            </div>
            {applyMsg && (
              <div className={`mt-3 flex items-start gap-2 rounded-xl p-3 ${applyMsg.ok ? "bg-cyan/10 border border-cyan/30" : "bg-pink/10 border border-pink/30"}`}>
                {applyMsg.ok
                  ? <CheckCircle2 className="size-4 text-cyan shrink-0 mt-0.5" />
                  : <Loader2 className="size-4 text-pink shrink-0 mt-0.5" />}
                <p className={`text-xs font-semibold ${applyMsg.ok ? "text-cyan" : "text-pink"}`}>{applyMsg.text}</p>
              </div>
            )}
          </div>

          {/* Friends list */}
          {(stats?.friends?.length ?? 0) > 0 && (
            <div>
              <p className="text-xs text-muted-foreground font-bold uppercase tracking-wider mb-3">
                Your Referrals ({stats!.friends.length})
              </p>
              <div className="space-y-2">
                {stats!.friends.map((f: ReferredUser) => (
                  <div key={f.id} className="bg-card rounded-2xl border border-border/60 p-4 flex items-center gap-3">
                    <div className={`size-10 rounded-xl grid place-items-center flex-shrink-0 ${f.has_traded ? "bg-cyan/15" : "bg-secondary"}`}>
                      <span className={`text-sm font-extrabold ${f.has_traded ? "text-cyan" : "text-muted-foreground"}`}>
                        {(f.full_name ?? "?")[0]?.toUpperCase()}
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-bold">{maskName(f.full_name)}</p>
                      <p className="text-[11px] text-muted-foreground">{timeAgo(f.created_at)}</p>
                    </div>
                    {f.has_traded ? (
                      <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-cyan/15 text-cyan text-[11px] font-bold">
                        <CheckCircle2 className="size-3" /> ₦{(f.total_commission_ngn ?? 0).toLocaleString()} earned
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-gold/15 text-gold text-[11px] font-bold">
                        <Clock className="size-3" /> Pending
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Empty friends state */}
          {!isLoading && (stats?.friends?.length ?? 0) === 0 && (
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <div className="size-16 rounded-3xl bg-card border border-border grid place-items-center">
                <Users className="size-8 text-muted-foreground" />
              </div>
              <div>
                <p className="text-sm font-bold">No referrals yet</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Share your code and start earning 5% per friend's trade
                </p>
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
