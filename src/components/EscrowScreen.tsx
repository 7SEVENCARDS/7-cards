import { useState, useEffect, useRef, useCallback } from "react";
import {
  Shield,
  CheckCircle2,
  Loader2,
  Gift,
  Banknote,
  Eye,
  Zap,
  RotateCcw,
  Lock,
  ArrowRight,
  Sparkles,
  Clock,
} from "lucide-react";
import { getTradeStatus } from "../server-functions/trades";

type EscrowStatus = "holding" | "extended" | "admin_processing" | "admin_paid" | "timeout";

interface EscrowScreenProps {
  tradeId: string | null;
  brand: string;
  amountUsd: number;
  amountNgn: number;
  escrowEndsAt: number;
  extended: boolean;
  onExtend: () => void;
  onProceed: () => void;
}

function useCountdownMs(targetMs: number) {
  const [remaining, setRemaining] = useState(() => Math.max(0, targetMs - Date.now()));
  useEffect(() => {
    setRemaining(Math.max(0, targetMs - Date.now()));
    const id = setInterval(() => setRemaining(Math.max(0, targetMs - Date.now())), 200);
    return () => clearInterval(id);
  }, [targetMs]);
  return remaining;
}

const BRAND_EMOJI: Record<string, string> = {
  Apple: "🍎", Amazon: "📦", Steam: "🎮", "Google Play": "▶️",
  Xbox: "🟢", PlayStation: "🎯", Netflix: "🎬", Spotify: "🎵",
};

interface Step {
  icon: typeof CheckCircle2;
  label: string;
  sub: string;
}

const STEPS: Step[] = [
  { icon: CheckCircle2, label: "Card Verified",       sub: "Reloadly confirmed card is valid"           },
  { icon: Lock,        label: "Funds Reserved",       sub: "Your NGN payout is locked & guaranteed"    },
  { icon: Eye,         label: "Admin Receiving Card", sub: "Operator is processing your card now"      },
  { icon: Gift,        label: "Card Being Redeemed",  sub: "Gift card value being captured"             },
  { icon: Banknote,    label: "NGN Payout Releasing", sub: "Funds being sent to your account"          },
];

export function EscrowScreen({
  tradeId,
  brand,
  amountUsd,
  amountNgn,
  escrowEndsAt,
  extended,
  onExtend,
  onProceed,
}: EscrowScreenProps) {
  const remaining = useCountdownMs(escrowEndsAt);
  const isExpired = remaining <= 0;
  const isLow = remaining < 60_000 && remaining > 0;
  const [escrowStatus, setEscrowStatus] = useState<EscrowStatus>("holding");
  const [activeStep, setActiveStep] = useState(2);
  const [tick, setTick] = useState(0);
  const [celebrated, setCelebrated] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const totalMs = extended ? 8 * 60_000 : 5 * 60_000;
  const progressPct = Math.max(0, Math.min(100, ((totalMs - remaining) / totalMs) * 100));

  const mins = Math.floor(remaining / 60_000);
  const secs = Math.floor((remaining % 60_000) / 1_000);

  const isAdminProcessing = escrowStatus === "admin_processing" || escrowStatus === "admin_paid";

  const ringCircumference = 2 * Math.PI * 54;
  const ringStroke = isAdminProcessing
    ? "oklch(0.88 0.17 180)"
    : isExpired
    ? "oklch(0.72 0.19 42)"
    : isLow
    ? "oklch(0.82 0.19 55)"
    : "oklch(0.87 0.17 92)";

  const pollTradeStatus = useCallback(async () => {
    if (!tradeId || tradeId.startsWith("demo-")) return;
    try {
      const trade = await getTradeStatus({ data: { tradeId } }) as { status: string };
      if (trade.status === "processing") {
        setEscrowStatus("admin_processing");
        setActiveStep(4);
        if (pollRef.current) clearInterval(pollRef.current);
        setTimeout(() => onProceed(), 2000);
      } else if (trade.status === "paid") {
        setEscrowStatus("admin_paid");
        setActiveStep(5);
        if (pollRef.current) clearInterval(pollRef.current);
        setTimeout(() => onProceed(), 1200);
      }
    } catch { /* non-critical */ }
  }, [tradeId, onProceed]);

  useEffect(() => {
    pollRef.current = setInterval(pollTradeStatus, 5_000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [pollTradeStatus]);

  // Tick for particle animations
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 80);
    return () => clearInterval(id);
  }, []);

  // Escrow expiry state machine
  useEffect(() => {
    if (isExpired && escrowStatus === "holding") {
      setEscrowStatus(extended ? "timeout" : "extended");
    }
  }, [isExpired, escrowStatus, extended]);

  // Step progress during active escrow
  useEffect(() => {
    if (escrowStatus === "holding" || escrowStatus === "extended") {
      if (progressPct > 55) setActiveStep(3);
      else setActiveStep(2);
    }
  }, [progressPct, escrowStatus]);

  // Celebration bounce for admin processing
  useEffect(() => {
    if (isAdminProcessing && !celebrated) {
      setCelebrated(true);
    }
  }, [isAdminProcessing, celebrated]);

  const brandEmoji = BRAND_EMOJI[brand] ?? "🎁";

  return (
    <div className="flex flex-col min-h-screen bg-background">
      {/* Header */}
      <header className="px-5 pt-12 pb-4">
        <div className="flex items-center gap-3">
          <div className={`size-10 rounded-full border grid place-items-center transition-all duration-500 ${
            isAdminProcessing
              ? "bg-cyan/20 border-cyan/40"
              : "bg-card border-border"
          }`}>
            <Shield className={`size-5 transition-colors duration-500 ${isAdminProcessing ? "text-cyan" : "text-gold"}`} />
          </div>
          <div className="flex-1">
            <p className="text-[10px] text-muted-foreground font-bold uppercase tracking-wider">
              Step 3 of 3 · Escrow &amp; Processing
            </p>
            <p className="text-sm font-extrabold text-white">
              {isAdminProcessing
                ? "Card Redeemed — Paying Out!"
                : escrowStatus === "timeout"
                ? "Escrow Ended · Trade Queued"
                : "Waiting for Admin"}
            </p>
          </div>
          <span className={`px-2.5 py-1 rounded-full text-[10px] font-extrabold flex items-center gap-1 transition-all duration-500 ${
            isAdminProcessing
              ? "bg-cyan/15 text-cyan"
              : escrowStatus === "timeout"
              ? "bg-muted/60 text-muted-foreground"
              : "bg-gold/15 text-gold"
          }`}>
            <span className={`size-1.5 rounded-full animate-pulse ${
              isAdminProcessing ? "bg-cyan" : escrowStatus === "timeout" ? "bg-muted-foreground" : "bg-gold"
            }`} />
            {isAdminProcessing ? "DONE" : escrowStatus === "timeout" ? "QUEUED" : "LIVE"}
          </span>
        </div>
      </header>

      {/* Main escrow timer card */}
      <div className="px-5 mt-1">
        <div
          className="relative rounded-[2rem] overflow-hidden border-2 p-6 transition-all duration-700"
          style={{
            borderColor: isAdminProcessing
              ? "oklch(0.88 0.17 180 / 0.5)"
              : isExpired
              ? "oklch(0.72 0.19 42 / 0.4)"
              : "oklch(0.87 0.17 92 / 0.35)",
            background: isAdminProcessing
              ? "radial-gradient(circle at 50% 35%, oklch(0.35 0.20 165 / 0.6), oklch(0.15 0.06 180) 75%)"
              : isExpired
              ? "radial-gradient(circle at 50% 35%, oklch(0.32 0.14 45 / 0.5), oklch(0.15 0.05 45) 75%)"
              : "radial-gradient(circle at 50% 35%, oklch(0.32 0.16 85 / 0.55), oklch(0.15 0.04 100) 75%)",
          }}
        >
          {/* Animated particles */}
          <div className="absolute inset-0 overflow-hidden pointer-events-none">
            {Array.from({ length: 10 }).map((_, i) => {
              const x = 8 + (i * 9.3) % 84;
              const y = 8 + (i * 13.7) % 78;
              const phase = (tick * 0.06) + i * 0.68;
              const opacity = isAdminProcessing
                ? 0.5 + Math.sin(phase) * 0.35
                : 0.2 + Math.sin(phase) * 0.18;
              return (
                <div
                  key={i}
                  className={`absolute rounded-full transition-colors duration-500 ${
                    isAdminProcessing ? "bg-cyan/60" : isExpired ? "bg-orange-400/40" : "bg-gold/40"
                  }`}
                  style={{
                    width: 4 + (i % 3) * 2,
                    height: 4 + (i % 3) * 2,
                    left: `${x}%`,
                    top: `${y}%`,
                    transform: `translateY(${Math.sin(phase) * 7}px) scale(${0.8 + Math.abs(Math.sin(phase)) * 0.5})`,
                    opacity,
                  }}
                />
              );
            })}
          </div>

          <div className="flex items-center gap-5 relative">
            {/* Circular countdown ring */}
            <div className="relative shrink-0">
              <svg width="120" height="120" viewBox="0 0 128 128" className="-rotate-90">
                <circle cx="64" cy="64" r="54" fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="9" />
                <circle
                  cx="64" cy="64" r="54"
                  fill="none"
                  stroke={ringStroke}
                  strokeWidth="9"
                  strokeLinecap="round"
                  strokeDasharray={ringCircumference}
                  strokeDashoffset={isAdminProcessing ? 0 : ringCircumference * (1 - progressPct / 100)}
                  style={{ transition: "stroke-dashoffset 0.6s ease, stroke 0.6s ease" }}
                />
              </svg>
              <div className="absolute inset-0 grid place-items-center">
                {isAdminProcessing ? (
                  <div className="text-center">
                    <Sparkles className="size-7 text-cyan mx-auto" />
                    <p className="text-[9px] text-cyan font-extrabold mt-1 tracking-wider">DONE</p>
                  </div>
                ) : isExpired && !extended ? (
                  <div className="text-center">
                    <Clock className="size-6 text-orange-400 mx-auto animate-pulse" />
                    <p className="text-[9px] text-orange-400 font-extrabold mt-1">EXTEND?</p>
                  </div>
                ) : escrowStatus === "timeout" ? (
                  <div className="text-center">
                    <Shield className="size-6 text-gold mx-auto" />
                    <p className="text-[9px] text-gold font-extrabold mt-1">QUEUED</p>
                  </div>
                ) : (
                  <div className="text-center">
                    <p className="text-[22px] font-extrabold text-white font-mono leading-none tabular-nums">
                      {mins < 10 ? `0${mins}` : `${mins}`}:{secs < 10 ? `0${secs}` : `${secs}`}
                    </p>
                    <p className="text-[9px] text-white/50 font-bold mt-0.5 tracking-wider">
                      {extended ? "EXTENDED" : "ESCROW"}
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* Status text */}
            <div className="flex-1 min-w-0">
              {isAdminProcessing ? (
                <>
                  <p className="text-base font-extrabold text-cyan">Card Redeemed! 🎉</p>
                  <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                    Admin processed your card successfully. Your payout is on its way.
                  </p>
                  <div className="mt-2.5 flex items-center gap-1.5">
                    <Loader2 className="size-3.5 text-cyan animate-spin" />
                    <p className="text-[11px] text-cyan font-semibold">Crediting your wallet…</p>
                  </div>
                </>
              ) : escrowStatus === "timeout" ? (
                <>
                  <p className="text-base font-extrabold text-gold">Trade Queued ✓</p>
                  <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                    Escrow window closed. Your trade is in our priority queue — payout is guaranteed.
                  </p>
                </>
              ) : (
                <>
                  <p className={`text-base font-extrabold transition-colors duration-300 ${
                    isLow ? "text-orange-400" : "text-gold"
                  }`}>
                    {isLow ? "Almost done!" : "Card in Escrow"}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                    Our operator is processing your card in real-time.
                    {isLow && !extended && " Timer running low — extend if needed."}
                  </p>
                  <div className="mt-2.5 flex items-center gap-1.5 bg-black/20 rounded-xl px-3 py-1.5 w-fit">
                    <Zap className="size-3 text-gold" />
                    <p className="text-[11px] text-gold font-bold">₦{amountNgn.toLocaleString()} · rate locked</p>
                  </div>
                </>
              )}

              {/* Card badge */}
              <div className="mt-2.5 flex items-center gap-2 bg-white/6 rounded-full px-3 py-1 w-fit">
                <span className="text-sm">{brandEmoji}</span>
                <span className="text-xs font-bold text-white">{brand} ${amountUsd}</span>
              </div>
            </div>
          </div>

          {/* Linear progress bar */}
          {!isAdminProcessing && escrowStatus !== "timeout" && (
            <div className="mt-4">
              <div className="h-1 rounded-full bg-white/8 overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-700"
                  style={{
                    width: `${progressPct}%`,
                    background: isExpired
                      ? "oklch(0.72 0.19 42)"
                      : isLow
                      ? "linear-gradient(90deg, oklch(0.87 0.17 92), oklch(0.82 0.19 55))"
                      : "linear-gradient(90deg, oklch(0.87 0.17 92), oklch(0.82 0.19 65))",
                  }}
                />
              </div>
              <div className="flex justify-between text-[9px] text-white/35 mt-1.5 font-medium">
                <span>START</span>
                <span>{extended ? "8:00 TOTAL" : "5:00 TOTAL"}</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Transparency panel */}
      <div className="px-5 mt-4">
        <div className="bg-card rounded-2xl border border-border/50 p-4">
          <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mb-3 flex items-center gap-1.5">
            <Eye className="size-3" /> What's happening right now
          </p>
          <div className="space-y-0">
            {STEPS.map((step, i) => {
              const isDone = i < activeStep || (i <= 1);
              const isActive = i === activeStep && !isAdminProcessing && escrowStatus !== "timeout";
              const isAdminDone = isAdminProcessing && i <= activeStep;

              return (
                <div key={i} className="flex gap-3">
                  <div className="flex flex-col items-center">
                    <div className={`size-6 rounded-full grid place-items-center shrink-0 transition-all duration-400 ${
                      isAdminDone ? "bg-cyan/20 text-cyan"
                      : isDone ? "bg-cyan/15 text-cyan"
                      : isActive ? "bg-gold/20 text-gold"
                      : "bg-secondary/80 text-muted-foreground/30"
                    }`}>
                      {isActive
                        ? <Loader2 className="size-3 animate-spin" />
                        : isDone || isAdminDone
                        ? <CheckCircle2 className="size-3" />
                        : <step.icon className="size-3" />
                      }
                    </div>
                    {i < STEPS.length - 1 && (
                      <div className={`w-px h-6 mt-0.5 mb-0.5 rounded-full transition-colors duration-400 ${
                        (isDone || isAdminDone) ? "bg-cyan/25" : "bg-border/30"
                      }`} />
                    )}
                  </div>
                  <div className="pb-2 pt-0.5 flex-1 min-w-0">
                    <p className={`text-xs font-bold transition-colors duration-300 ${
                      isActive ? "text-gold"
                      : isDone || isAdminDone ? "text-foreground"
                      : "text-muted-foreground/40"
                    }`}>
                      {step.label}
                    </p>
                    <p className="text-[10px] text-muted-foreground/70 leading-snug">{step.sub}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Security guarantee badge */}
      <div className="px-5 mt-3">
        <div className="flex items-center gap-3 bg-gold/5 border border-gold/15 rounded-2xl px-4 py-3">
          <Shield className="size-4 text-gold shrink-0" />
          <div>
            <p className="text-xs font-bold text-gold">₦{amountNgn.toLocaleString()} Guaranteed</p>
            <p className="text-[11px] text-muted-foreground/80 leading-snug">
              Your payout is secured regardless of processing time. You will always be paid.
            </p>
          </div>
        </div>
      </div>

      {/* CTA area */}
      <div className="px-5 mt-4 pb-10 space-y-3">
        {/* Extension button */}
        {(isLow || (isExpired && escrowStatus === "extended")) && !extended && !isAdminProcessing && (
          <button
            onClick={onExtend}
            className="w-full flex items-center justify-center gap-2 bg-orange-500/12 border border-orange-500/25 text-orange-400 rounded-2xl py-3.5 text-sm font-extrabold active:scale-[0.98] transition-transform"
          >
            <RotateCcw className="size-4" />
            Extend 3 Minutes — Give Admin More Time
          </button>
        )}

        {/* Timeout CTA */}
        {escrowStatus === "timeout" && (
          <div className="space-y-2.5">
            <div className="bg-gold/8 border border-gold/20 rounded-2xl p-4">
              <p className="text-sm font-extrabold text-gold">Trade Queued for Priority Payout</p>
              <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
                The escrow window closed but your trade is in our priority queue. We'll process it within 30 minutes and notify you immediately.
              </p>
            </div>
            <button
              onClick={onProceed}
              className="w-full flex items-center justify-center gap-2 bg-gradient-gold text-jungle-deep rounded-2xl py-3.5 text-sm font-extrabold shadow-glow-gold active:scale-[0.98] transition-transform"
            >
              View Trade Status <ArrowRight className="size-4" />
            </button>
          </div>
        )}

        {/* Admin processing auto-advance */}
        {isAdminProcessing && (
          <div className="flex items-center justify-center gap-2 text-cyan text-xs font-semibold py-2">
            <Loader2 className="size-3.5 animate-spin" />
            Admin processed — loading your wallet…
          </div>
        )}

        {/* Waiting state hint */}
        {!isExpired && !isAdminProcessing && !isLow && (
          <p className="text-center text-[11px] text-muted-foreground/60 leading-relaxed">
            Keep this screen open · Closing won't cancel your trade
          </p>
        )}
      </div>

      <style>{`
        @keyframes pulse-ring {
          0%, 100% { transform: scale(1); opacity: 0.6; }
          50% { transform: scale(1.08); opacity: 1; }
        }
      `}</style>
    </div>
  );
}
