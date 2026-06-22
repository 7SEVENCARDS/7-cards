import React, { useState } from "react";
import {
  ChevronLeft, Copy, Share2, CheckCircle2, Clock,
  Gift, Users, Loader2, Wallet, ChevronRight, Zap, Sparkles,
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

export function ReferralScreen({ userId, onBack }: ReferralScreenProps) {
  const qc = useQueryClient();
  const [copied, setCopied]       = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [codeInput, setCodeInput] = useState("");
  const [applying, setApplying]   = useState(false);
  const [applyMsg, setApplyMsg]   = useState<{ ok: boolean; text: string } | null>(null);

  const { data: stats, isLoading } = useQuery<ReferralStats>({
    queryKey: ["referral-stats", userId],
    queryFn: () => getReferralStats({ data: { userId } }),
    staleTime: 30_000,
  });

  const referralLink = stats?.referralCode
    ? `https://7evencards.xyz/join?ref=${stats.referralCode}`
    : "";

  const shareText = `Trade gift cards for instant Naira on 7SEVEN CARDS! 🚀\n\nUse my invite link and we BOTH earn ₦500 bonus + 100 XP when you complete your first trade.\n\n${referralLink}`;

  const handleCopyCode = async () => {
    await navigator.clipboard.writeText(stats?.referralCode ?? "");
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleCopyLink = async () => {
    await navigator.clipboard.writeText(referralLink);
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 2000);
  };

  const handleShare = async () => {
    if (navigator.share) {
      await navigator.share({
        title: "Join 7SEVEN CARDS — We both earn ₦500!",
        text: shareText,
        url: referralLink,
      }).catch(() => {});
    } else {
      handleCopyLink();
    }
  };

  const handleApplyCode = async () => {
    if (!codeInput.trim()) return;
    setApplying(true);
    setApplyMsg(null);
    try {
      const res = await applyReferralCode({ data: { code: codeInput.trim() } });
      if ((res as { success: boolean }).success) {
        setApplyMsg({ ok: true, text: "Code applied! Complete your first trade and you both earn ₦500 + 100 XP." });
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
            <h1 className="text-xl font-extrabold">Invite Friends</h1>
            <p className="text-xs text-muted-foreground">You both earn ₦500 + 100 XP on first trade</p>
          </div>
        </header>

        <div className="px-5 flex flex-col gap-5">

          {/* Bonus Reward Banner */}
          <div className="relative rounded-3xl overflow-hidden border border-gold/30"
            style={{ background: "radial-gradient(circle at 30% 50%, oklch(0.35 0.09 158 / 0.5), oklch(0.18 0.02 260) 70%)" }}>
            <div className="absolute -right-8 -top-8 size-40 rounded-full bg-gold/15 blur-2xl pointer-events-none" />
            <div className="absolute -left-6 -bottom-6 size-32 rounded-full bg-pink/10 blur-2xl pointer-events-none" />
            <div className="relative p-5">
              <div className="flex items-center gap-2 mb-3">
                <div className="size-8 rounded-xl bg-gold/20 grid place-items-center">
                  <Sparkles className="size-4 text-gold" />
                </div>
                <p className="text-xs font-extrabold text-gold uppercase tracking-wider">Dual Bonus Reward</p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-white/5 rounded-2xl p-4 border border-white/10">
                  <p className="text-[10px] text-white/50 font-semibold uppercase mb-1">You Earn</p>
                  <p className="text-2xl font-extrabold text-gold">₦500</p>
                  <p className="text-[11px] text-gold/70 font-semibold">+ 100 XP</p>
                  <p className="text-[10px] text-white/40 mt-1">per friend's first trade</p>
                </div>
                <div className="bg-white/5 rounded-2xl p-4 border border-white/10">
                  <p className="text-[10px] text-white/50 font-semibold uppercase mb-1">Friend Earns</p>
                  <p className="text-2xl font-extrabold text-cyan">₦500</p>
                  <p className="text-[11px] text-cyan/70 font-semibold">+ 100 XP</p>
                  <p className="text-[10px] text-white/40 mt-1">on their first trade</p>
                </div>
              </div>
              <p className="text-[11px] text-white/40 mt-3 text-center">
                Plus you earn 5% of every trade they complete — forever.
              </p>
            </div>
          </div>

          {/* Total Earned stats */}
          <div className="bg-card rounded-3xl border border-border p-5">
            <p className="text-xs text-muted-foreground font-bold uppercase tracking-wider mb-4">Your Referral Stats</p>
            <div className="grid grid-cols-3 gap-3 text-center">
              {[
                { label: "Invited",  value: isLoading ? "—" : String(stats?.totalReferred ?? 0), color: "text-foreground" },
                { label: "Traded",   value: isLoading ? "—" : String(stats?.earnedCount   ?? 0), color: "text-cyan"      },
                { label: "Earned",   value: isLoading ? "—" : `₦${(stats?.totalEarnedNgn ?? 0).toLocaleString()}`, color: "text-gold" },
              ].map(({ label, value, color }) => (
                <div key={label} className="bg-secondary rounded-2xl py-3">
                  {isLoading
                    ? <div className="h-7 w-12 mx-auto bg-secondary rounded-lg animate-pulse" />
                    : <p className={`text-lg font-extrabold ${color}`}>{value}</p>
                  }
                  <p className="text-[10px] text-muted-foreground mt-0.5">{label}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Referral code + share */}
          <div className="bg-card rounded-3xl border border-border p-5">
            <p className="text-xs text-muted-foreground font-bold uppercase tracking-wider mb-3">Your Invite Code</p>
            {isLoading
              ? <div className="h-16 bg-secondary rounded-2xl animate-pulse" />
              : (
                <div className="bg-secondary rounded-2xl p-4 flex items-center justify-between mb-3">
                  <p className="text-3xl font-extrabold tracking-[0.2em] text-foreground">
                    {stats?.referralCode ?? "——"}
                  </p>
                  <button
                    onClick={handleCopyCode}
                    className={`size-10 rounded-xl grid place-items-center transition ${copied ? "bg-cyan/20 text-cyan" : "bg-card border border-border text-muted-foreground hover:text-foreground"}`}
                  >
                    {copied ? <CheckCircle2 className="size-4" /> : <Copy className="size-4" />}
                  </button>
                </div>
              )}

            {/* Shareable invite link */}
            {referralLink && (
              <div className="bg-secondary/50 rounded-2xl px-4 py-3 flex items-center gap-2 mb-3 border border-border/50">
                <p className="flex-1 text-[11px] text-muted-foreground truncate font-mono">{referralLink}</p>
                <button
                  onClick={handleCopyLink}
                  className={`shrink-0 flex items-center gap-1 text-[11px] font-bold px-2.5 py-1.5 rounded-lg transition ${linkCopied ? "bg-cyan/20 text-cyan" : "bg-card border border-border text-muted-foreground"}`}
                >
                  {linkCopied ? <><CheckCircle2 className="size-3" /> Copied!</> : <><Copy className="size-3" /> Copy link</>}
                </button>
              </div>
            )}

            <button
              onClick={handleShare}
              className="w-full bg-gradient-gold text-jungle-deep font-extrabold py-3.5 rounded-2xl flex items-center justify-center gap-2 shadow-glow-gold"
            >
              <Share2 className="size-4" /> Share Invite Link
            </button>
          </div>

          {/* How it works */}
          <div>
            <p className="text-xs text-muted-foreground font-bold uppercase tracking-wider mb-3">How It Works</p>
            <div className="space-y-2">
              {[
                { step: "1", icon: Share2,        text: "Share your invite link with a friend" },
                { step: "2", icon: Users,         text: "Friend signs up using your code" },
                { step: "3", icon: Gift,          text: "They sell their first gift card" },
                { step: "4", icon: Sparkles,      text: "You BOTH instantly earn ₦500 credit + 100 XP" },
                { step: "5", icon: Zap,           text: "You keep earning 5% of every trade they complete — forever" },
              ].map(({ step, icon: Icon, text }) => (
                <div key={step} className="flex items-center gap-3 bg-card rounded-2xl border border-border/60 p-4">
                  <div className={`size-8 rounded-xl text-xs font-extrabold grid place-items-center flex-shrink-0 ${step === "4" ? "bg-gold/20 text-gold ring-1 ring-gold/30" : "bg-secondary text-muted-foreground"}`}>
                    {step}
                  </div>
                  <Icon className={`size-4 flex-shrink-0 ${step === "4" ? "text-gold" : "text-muted-foreground"}`} />
                  <p className={`text-sm flex-1 ${step === "4" ? "text-gold font-bold" : "text-muted-foreground"}`}>{text}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Apply someone else's code */}
          <div className="bg-card rounded-3xl border border-border p-5">
            <p className="text-xs text-muted-foreground font-bold uppercase tracking-wider mb-1">
              Have a friend's code?
            </p>
            <p className="text-[11px] text-muted-foreground mb-3">
              Enter it to link your account — you'll both earn ₦500 + 100 XP on your first trade.
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
                  : <Sparkles className="size-4 text-pink shrink-0 mt-0.5" />}
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
                {stats!.friends.map((f: ReferredUser, idx: number) => (
                  <div key={idx} className="bg-card rounded-2xl border border-border/60 p-4 flex items-center gap-3">
                    <div className={`size-10 rounded-xl grid place-items-center flex-shrink-0 ${f.has_traded ? "bg-cyan/15" : "bg-secondary"}`}>
                      <span className={`text-sm font-extrabold ${f.has_traded ? "text-cyan" : "text-muted-foreground"}`}>
                        {(f.display_name ?? "?")[0]?.toUpperCase()}
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-bold">{f.display_name ?? "Anonymous"}</p>
                      <p className="text-[11px] text-muted-foreground">{timeAgo(f.joined_at)}</p>
                    </div>
                    {f.has_traded ? (
                      <div className="flex flex-col items-end gap-1">
                        <div className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-cyan/15 text-cyan text-[10px] font-bold">
                          <CheckCircle2 className="size-3" /> Traded
                        </div>
                        {f.total_commission_ngn > 0 && (
                          <span className="text-[10px] text-gold font-bold">
                            +₦{f.total_commission_ngn.toLocaleString()} earned
                          </span>
                        )}
                      </div>
                    ) : (
                      <div className="flex flex-col items-end gap-1">
                        <div className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-gold/15 text-gold text-[10px] font-bold">
                          <Clock className="size-3" /> Pending
                        </div>
                        <span className="text-[10px] text-muted-foreground">₦500 bonus waiting</span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Empty state */}
          {!isLoading && (stats?.friends?.length ?? 0) === 0 && (
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <div className="size-16 rounded-3xl bg-card border border-border grid place-items-center">
                <Users className="size-8 text-muted-foreground" />
              </div>
              <div>
                <p className="text-sm font-bold">No referrals yet</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Invite a friend — you both earn ₦500 + 100 XP on their first trade
                </p>
              </div>
              <button
                onClick={handleShare}
                className="bg-gradient-gold text-jungle-deep font-extrabold text-xs px-5 py-2.5 rounded-xl shadow-glow-gold flex items-center gap-1.5"
              >
                <Share2 className="size-3.5" /> Send First Invite
              </button>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
