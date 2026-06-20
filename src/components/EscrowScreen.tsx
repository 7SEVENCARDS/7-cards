import { useState, useEffect, useRef, useCallback } from "react";
import {
  Shield,
  Clock,
  CheckCircle2,
  Loader2,
  Gift,
  Banknote,
  Eye,
  Zap,
  Timer,
  RotateCcw,
  Lock,
  ArrowRight,
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
    const id = setInterval(() => {
      setRemaining(() => Math.max(0, targetMs - Date.now()));
    }, 250);
    return () => clearInterval(id);
  }, [targetMs]);
  return remaining;
}

const BRAND_EMOJI: Record<string, string> = {
  Apple: "🍎", Amazon: "📦", Steam: "🎮", "Google Play": "▶️",
  Xbox: "🟢", PlayStation: "🎯", Netflix: "🎬", Spotify: "🎵",
};

const STEPS = [
  {
    icon: CheckCircle2,
    label: "Card Verified",
    sub: "Reloadly confirmed card is valid",
    done: true,
    active: false,
  },
  {
    icon: Lock,
    label: "Funds Reserved",
    sub: "Your NGN payout is locked & guaranteed",
    done: true,
    active: false,
  },
  {
    icon: Eye,
    label: "Admin Receiving Card",
    sub: "Operator is processing your card now",
    done: false,
    active: true,
  },
  {
    icon: Gift,
    label: "Card Being Redeemed",
    sub: "Gift card value being captured",
    done: false,
    active: false,
  },
  {
    icon: Banknote,
    label: "NGN Payout Releasing",
    sub: "Funds being sent to your account",
    done: false,
    active: false,
  },
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
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [tick, setTick] = useState(0);

  const totalMs = extended ? 8 * 60_000 : 5 * 60_000;
  const progressPct = Math.max(0, Math.min(100, ((totalMs - remaining) / totalMs) * 100));

  const mins = Math.floor(remaining / 60_000);
  const secs = Math.floor((remaining % 60_000) / 1_000);

  const pollTradeStatus = useCallback(async () => {
    if (!tradeId || tradeId.startsWith("demo-")) return;
    try {
      const trade = await getTradeStatus({ data: { tradeId } }) as { status: string };
      if (trade.status === "processing") {
        setEscrowStatus("admin_processing");
        setActiveStep(4);
        if (pollRef.current) clearInterval(pollRef.current);
        setTimeout(() => onProceed(), 1500);
      } else if (trade.status === "paid") {
        setEscrowStatus("admin_paid");
        setActiveStep(5);
        if (pollRef.current) clearInterval(pollRef.current);
        setTimeout(() => onProceed(), 1000);
      }
    } catch { /* non-critical */ }
  }, [tradeId, onProceed]);

  useEffect(() => {
    pollRef.current = setInterval(pollTradeStatus, 5_000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [pollTradeStatus]);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 100);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (isExpired && escrowStatus === "holding") {
      setEscrowStatus(extended ? "timeout" : "extended");
    }
  }, [isExpired, escrowStatus, extended]);

  useEffect(() => {
    if (escrowStatus === "holding" || escrowStatus === "extended") {
      const stepProgress = progressPct / 100;
      if (stepProgress > 0.6) setActiveStep(3);
      else if (stepProgress > 0.3) setActiveStep(2);
      else setActiveStep(2);
    }
  }, [progressPct, escrowStatus]);

  const brandEmoji = BRAND_EMOJI[brand] ?? "🎁";
  const isAdminProcessing = escrowStatus === "admin_processing" || escrowStatus === "admin_paid";

  const ringCircumference = 2 * Math.PI * 54;
  const ringDashOffset = ringCircumference * (1 - progressPct / 100);

  return (
    <div className="flex flex-col min-h-screen bg-background">
      <header className="px-5 pt-12 pb-4 flex items-center gap-3">
        <div className="size-10 rounded-full bg-card border border-border grid place-items-center">
          <Shield className="size-5 text-gold" />
        </div>
        <div>
          <p className="text-[10px] text-muted-foreground font-bold uppercase tracking-wider">Step 3 of 3</p>
          <p className="text-sm font-extrabold">Escrow &amp; Processing</p>
        </div>
        <div className="ml-auto">
          <span className="px-2.5 py-1 rounded-full bg-gold/15 text-gold text-[10px] font-extrabold flex items-center gap-1">
            <span className="size-1.5 rounded-full bg-gold animate-pulse" />
            LIVE
          </span>
        </div>
      </header>

      {/* Main escrow timer */}
      <div className="px-5 mt-2">
        <div
          className="relative rounded-[2rem] overflow-hidden border-2 border-gold/40 p-6"
          style={{
            background: isAdminProcessing
              ? "radial-gradient(circle at 50% 40%, oklch(0.4 0.18 150 / 0.55), oklch(0.18 0.08 160) 70%)"
              : isExpired
              ? "radial-gradient(circle at 50% 40%, oklch(0.35 0.15 50 / 0.45), oklch(0.18 0.08 50) 70%)"
              : "radial-gradient(circle at 50% 40%, oklch(0.35 0.18 85 / 0.5), oklch(0.18 0.05 100) 70%)",
          }}
        >
          {/* Subtle animated background particles */}
          <div className="absolute inset-0 overflow-hidden pointer-events-none">
            {Array.from({ length: 8 }).map((_, i) => (
              <div
                key={i}
                className="absolute size-1.5 rounded-full bg-gold/30"
                style={{
                  left: `${10 + (i * 12) % 80}%`,
                  top: `${10 + (i * 17) % 70}%`,
                  animation: `float-particle ${2 + (i * 0.4)}s ${i * 0.3}s ease-in-out infinite alternate`,
                  transform: `translateY(${Math.sin((tick * 0.05) + i) * 6}px)`,
                  opacity: 0.4 + Math.sin((tick * 0.08) + i * 1.2) * 0.3,
                }}
              />
            ))}
          </div>

          <div className="flex items-center gap-4 relative">
            {/* Circular countdown ring */}
            <div className="relative shrink-0">
              <svg width="128" height="128" viewBox="0 0 128 128" className="-rotate-90">
                {/* Background ring */}
                <circle
                  cx="64" cy="64" r="54"
                  fill="none"
                  stroke="rgba(255,255,255,0.08)"
                  strokeWidth="8"
                />
                {/* Progress ring */}
                <circle
                  cx="64" cy="64" r="54"
                  fill="none"
                  stroke={isAdminProcessing ? "oklch(0.88 0.17 180)" : isExpired ? "oklch(0.72 0.19 42)" : "oklch(0.87 0.17 92)"}
                  strokeWidth="8"
                  strokeLinecap="round"
                  strokeDasharray={ringCircumference}
                  strokeDashoffset={isAdminProcessing ? 0 : ringDashOffset}
                  style={{ transition: "stroke-dashoffset 0.5s ease, stroke 0.5s ease" }}
                />
              </svg>
              {/* Center content */}
              <div className="absolute inset-0 grid place-items-center">
                {isAdminProcessing ? (
                  <div className="text-center">
                    <CheckCircle2 className="size-8 text-cyan mx-auto" />
                    <p className="text-[9px] text-cyan font-bold mt-1">DONE</p>
                  </div>
                ) : isExpired && !extended ? (
                  <div className="text-center">
                    <Timer className="size-7 text-orange mx-auto animate-pulse" />
                    <p className="text-[9px] text-orange font-bold mt-1">EXTEND?</p>
                  </div>
                ) : (
                  <div className="text-center">
                    <p className="text-2xl font-extrabold text-white font-mono leading-none">
                      {mins < 10 ? `0${mins}` : mins}:{secs < 10 ? `0${secs}` : secs}
                    </p>
                    <p className="text-[9px] text-white/60 font-bold mt-0.5">
                      {extended ? "EXTENDED" : "ESCROW"}
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* Status info */}
            <div className="flex-1 min-w-0">
              {isAdminProcessing ? (
                <>
                  <p className="text-base font-extrabold text-cyan">Card Redeemed!</p>
                  <p className="text-xs text-muted-foreground mt-1">Admin processed your card — payout is on its way.</p>
                </>
              ) : isExpired && escrowStatus === "timeout" ? (
                <>
                  <p className="text-base font-extrabold text-orange">Escrow Ended</p>
                  <p className="text-xs text-muted-foreground mt-1">Your trade is queued for manual processing. Payout is guaranteed.</p>
                </>
              ) : (
                <>
                  <p className="text-base font-extrabold text-gold">
                    {isLow ? "Almost done!" : "Card in Escrow"}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Our operator is processing your card in real-time.
                    {isLow && !extended && " Timer running low."}
                  </p>
                  <div className="mt-2 flex items-center gap-1.5">
                    <Zap className="size-3 text-gold" />
                    <p className="text-[11px] text-gold font-semibold">
                      ₦{amountNgn.toLocaleString()} guaranteed · rate locked
                    </p>
                  </div>
                </>
              )}

              {/* Card badge */}
              <div className="mt-2.5 flex items-center gap-2 bg-black/20 rounded-xl px-3 py-1.5 w-fit">
                <span className="text-sm">{brandEmoji}</span>
                <span className="text-xs font-bold text-white">{brand} ${amountUsd}</span>
              </div>
            </div>
          </div>

          {/* Progress bar */}
          {!isAdminProcessing && (
            <div className="mt-4 relative">
              <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{
                    width: `${progressPct}%`,
                    background: isExpired
                      ? "oklch(0.72 0.19 42)"
                      : "linear-gradient(90deg, oklch(0.87 0.17 92), oklch(0.72 0.19 42))",
                  }}
                />
              </div>
              <div className="flex justify-between text-[10px] text-white/50 mt-1 font-medium">
                <span>Start</span>
                <span>{extended ? "8:00 total" : "5:00 total"}</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Transparency panel — what's happening */}
      <div className="px-5 mt-4">
        <div className="bg-card rounded-2xl border border-border/60 p-4">
          <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-1.5">
            <Eye className="size-3" /> What's happening right now
          </p>
          <div className="space-y-0">
            {STEPS.map((step, i) => {
              const isDone = i < activeStep || step.done;
              const isActive = i === activeStep && !isAdminProcessing;
              const isAdminDoneStep = isAdminProcessing && i <= 4;

              return (
                <div key={i} className="flex gap-3">
                  <div className="flex flex-col items-center">
                    <div className={`size-6 rounded-full grid place-items-center shrink-0 transition-all ${
                      isAdminDoneStep && i >= 2 ? "bg-cyan/20 text-cyan"
                      : isDone ? "bg-cyan/20 text-cyan"
                      : isActive ? "bg-gold/20 text-gold"
                      : "bg-secondary text-muted-foreground/40"
                    }`}>
                      {isActive && !isAdminDoneStep
                        ? <Loader2 className="size-3 animate-spin" />
                        : isDone || (isAdminDoneStep && i >= 2)
                        ? <CheckCircle2 className="size-3" />
                        : <Clock className="size-3" />
                      }
                    </div>
                    {i < STEPS.length - 1 && (
                      <div className={`w-px h-6 mt-0.5 mb-0.5 rounded-full transition-colors ${
                        isDone ? "bg-cyan/30" : "bg-border/40"
                      }`} />
                    )}
                  </div>
                  <div className="pb-2 pt-0.5 flex-1">
                    <p className={`text-xs font-bold ${
                      isActive && !isAdminDoneStep ? "text-gold" : isDone ? "text-foreground" : "text-muted-foreground/50"
                    }`}>
                      {step.label}
                    </p>
                    <p className="text-[10px] text-muted-foreground">{step.sub}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Security badge */}
      <div className="px-5 mt-3">
        <div className="flex items-center gap-3 bg-gold/5 border border-gold/20 rounded-2xl px-4 py-3">
          <Shield className="size-5 text-gold shrink-0" />
          <div className="flex-1">
            <p className="text-xs font-bold text-gold">Funds Secured &amp; Guaranteed</p>
            <p className="text-[11px] text-muted-foreground">
              Your ₦{amountNgn.toLocaleString()} is reserved. You will be paid regardless of processing time.
            </p>
          </div>
        </div>
      </div>

      {/* CTA area */}
      <div className="px-5 mt-4 pb-8 space-y-3">
        {/* Extension button — shown when low or expired but not yet extended */}
        {(isLow || isExpired) && !extended && escrowStatus !== "timeout" && !isAdminProcessing && (
          <button
            onClick={onExtend}
            className="w-full flex items-center justify-center gap-2 bg-orange/15 border border-orange/30 text-orange rounded-2xl py-3.5 text-sm font-extrabold"
          >
            <RotateCcw className="size-4" />
            Extend 3 Minutes — Give Admin More Time
          </button>
        )}

        {/* Timeout state — after full escrow including extension */}
        {escrowStatus === "timeout" && (
          <div className="space-y-2">
            <div className="bg-gold/10 border border-gold/30 rounded-2xl p-4">
              <p className="text-sm font-extrabold text-gold">Trade Queued for Payout</p>
              <p className="text-xs text-muted-foreground mt-1">
                Escrow period ended. Your trade is in our priority queue and will be paid within 30 minutes.
                No action needed — we will notify you.
              </p>
            </div>
            <button
              onClick={onProceed}
              className="w-full flex items-center justify-center gap-2 bg-gradient-gold text-jungle-deep rounded-2xl py-3.5 text-sm font-extrabold shadow-glow-gold"
            >
              View Trade Status <ArrowRight className="size-4" />
            </button>
          </div>
        )}

        {/* Admin done — auto proceeding */}
        {isAdminProcessing && (
          <div className="flex items-center justify-center gap-2 text-cyan text-sm font-semibold">
            <Loader2 className="size-4 animate-spin" />
            Admin processed — loading payout…
          </div>
        )}

        {/* While waiting — info */}
        {!isExpired && !isAdminProcessing && !isLow && (
          <p className="text-center text-[11px] text-muted-foreground">
            Please keep this screen open · Closing won't cancel your trade
          </p>
        )}
      </div>

      <style>{`
        @keyframes float-particle {
          0% { transform: translateY(0px) scale(1); }
          100% { transform: translateY(-8px) scale(1.2); }
        }
      `}</style>
    </div>
  );
}
