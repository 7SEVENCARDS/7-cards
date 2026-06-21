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
  WifiOff,
  MessageCircle,
} from "lucide-react";
import { getTradeStatus } from "../server-functions/trades";

// ─── Types ────────────────────────────────────────────────────────────────────

type EscrowStatus = "holding" | "extended" | "processing" | "paid" | "timeout";

interface EscrowScreenProps {
  tradeId: string | null;
  brand: string;
  amountUsd: number;
  amountNgn: number;
  escrowEndsAt: number;
  extended: boolean;
  onExtend: () => void;
  onProceed: () => void;
  onSupport?: () => void;
}

// ─── Hooks ────────────────────────────────────────────────────────────────────

function useCountdownMs(targetMs: number) {
  const [remaining, setRemaining] = useState(() => Math.max(0, targetMs - Date.now()));
  useEffect(() => {
    setRemaining(Math.max(0, targetMs - Date.now()));
    const id = setInterval(() => setRemaining(Math.max(0, targetMs - Date.now())), 500);
    return () => clearInterval(id);
  }, [targetMs]);
  return remaining;
}

function usePageVisible() {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const handle = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", handle);
    return () => document.removeEventListener("visibilitychange", handle);
  }, []);
  return visible;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const BRAND_EMOJI: Record<string, string> = {
  Apple: "🍎", Amazon: "📦", Steam: "🎮", "Google Play": "▶️",
  Xbox: "🟢", PlayStation: "🎯", Netflix: "🎬", Spotify: "🎵",
};

// Steps use user-facing language — no internal operational terms
const STEPS = [
  {
    label: "Card validated",
    sub: "Your gift card has been confirmed as valid and unused",
  },
  {
    label: "Payout secured",
    sub: "Your ₦ payout amount is locked and guaranteed to you",
  },
  {
    label: "Card under review",
    sub: "We're capturing the value on your card right now",
  },
  {
    label: "Value confirmed",
    sub: "Card value has been successfully captured",
  },
  {
    label: "Sending your money",
    sub: "Your payout is on its way to your wallet",
  },
];

// ─── Component ────────────────────────────────────────────────────────────────

export function EscrowScreen({
  tradeId,
  brand,
  amountUsd,
  amountNgn,
  escrowEndsAt,
  extended,
  onExtend,
  onProceed,
  onSupport,
}: EscrowScreenProps) {
  const remaining = useCountdownMs(escrowEndsAt);
  const pageVisible = usePageVisible();
  const isExpired = remaining <= 0;
  const isLow = remaining < 60_000 && remaining > 0;

  const [status, setStatus] = useState<EscrowStatus>("holding");
  const [activeStep, setActiveStep] = useState(2);
  const [completedSteps, setCompletedSteps] = useState<Set<number>>(new Set([0, 1]));
  const [pollFailures, setPollFailures] = useState(0);
  const [statusAnnouncement, setStatusAnnouncement] = useState("Your card is in escrow. Securing your payout.");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const totalMs = extended ? 8 * 60_000 : 5 * 60_000;
  const progressPct = Math.max(0, Math.min(100, ((totalMs - remaining) / totalMs) * 100));

  const mins = Math.floor(remaining / 60_000);
  const secs = Math.floor((remaining % 60_000) / 1_000);

  const isDone = status === "processing" || status === "paid";
  const isTimeout = status === "timeout";
  const pollStale = pollFailures >= 3;

  // ── Poll trade status ──────────────────────────────────────────────────────

  const pollTradeStatus = useCallback(async () => {
    if (!tradeId || tradeId.startsWith("demo-")) return;
    try {
      const trade = await getTradeStatus({ data: { tradeId } }) as { status: string };
      setPollFailures(0); // reset on success

      if (trade.status === "processing") {
        setStatus("processing");
        setActiveStep(4);
        setCompletedSteps(new Set([0, 1, 2, 3]));
        setStatusAnnouncement("Your card has been verified. Your payout is now being sent.");
        if (pollRef.current) clearInterval(pollRef.current);
        setTimeout(() => onProceed(), 2000);
      } else if (trade.status === "paid") {
        setStatus("paid");
        setActiveStep(5);
        setCompletedSteps(new Set([0, 1, 2, 3, 4]));
        setStatusAnnouncement("Payout complete. Your money has been sent to your wallet.");
        if (pollRef.current) clearInterval(pollRef.current);
        setTimeout(() => onProceed(), 1200);
      }
    } catch {
      setPollFailures(f => f + 1);
    }
  }, [tradeId, onProceed]);

  // Only poll when tab is visible — saves battery and avoids phantom updates
  useEffect(() => {
    if (!pageVisible) {
      if (pollRef.current) clearInterval(pollRef.current);
      return;
    }
    pollRef.current = setInterval(pollTradeStatus, 5_000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [pollTradeStatus, pageVisible]);

  // ── State machine ──────────────────────────────────────────────────────────

  useEffect(() => {
    if (isExpired && (status === "holding" || status === "extended")) {
      const next = extended ? "timeout" : "extended";
      setStatus(next);
      if (next === "timeout") {
        setStatusAnnouncement("The escrow window has closed. Your trade is queued for payout.");
      } else {
        setStatusAnnouncement("Time extended by 3 minutes. Continuing to process your card.");
      }
    }
  }, [isExpired, status, extended]);

  // Advance step indicator while holding
  useEffect(() => {
    if (status === "holding" || status === "extended") {
      const newStep = progressPct > 55 ? 3 : 2;
      if (newStep !== activeStep) {
        setActiveStep(newStep);
        setCompletedSteps(prev => {
          const next = new Set(prev);
          for (let i = 0; i < newStep; i++) next.add(i);
          return next;
        });
      }
    }
  }, [progressPct, status, activeStep]);

  const brandEmoji = BRAND_EMOJI[brand] ?? "🎁";

  // ── Ring color ─────────────────────────────────────────────────────────────
  const ringColor = isDone
    ? "oklch(0.88 0.17 180)"
    : isTimeout
    ? "oklch(0.87 0.17 92)"
    : isExpired
    ? "oklch(0.72 0.19 42)"
    : isLow
    ? "oklch(0.82 0.19 55)"
    : "oklch(0.87 0.17 92)";

  const ringCircumference = 2 * Math.PI * 54;

  return (
    <div className="flex flex-col min-h-screen bg-background">
      {/* Screen-reader live region — announces status changes */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {statusAnnouncement}
      </div>

      {/* Header */}
      <header className="px-5 pt-12 pb-4">
        <div className="flex items-center gap-3">
          <div className={`size-10 rounded-full border grid place-items-center transition-all duration-500 ${
            isDone ? "bg-cyan/20 border-cyan/40" : "bg-card border-border"
          }`}>
            <Shield className={`size-5 transition-colors duration-500 ${isDone ? "text-cyan" : "text-gold"}`} />
          </div>
          <div className="flex-1">
            <p className="text-[10px] text-muted-foreground font-bold uppercase tracking-wider">
              Step 3 of 3 · Escrow &amp; Processing
            </p>
            <p className="text-sm font-extrabold text-white">
              {isDone
                ? "Payout on its way!"
                : isTimeout
                ? "Your trade is queued"
                : "Securing your payout"}
            </p>
          </div>
          <span className={`px-2.5 py-1 rounded-full text-[10px] font-extrabold flex items-center gap-1 transition-all duration-500 ${
            isDone
              ? "bg-cyan/15 text-cyan"
              : isTimeout
              ? "bg-gold/15 text-gold"
              : "bg-gold/15 text-gold"
          }`}>
            <span className={`size-1.5 rounded-full ${
              isDone ? "bg-cyan animate-pulse" : isTimeout ? "bg-gold" : "bg-gold animate-pulse"
            }`} />
            {isDone ? "DONE" : isTimeout ? "QUEUED" : "LIVE"}
          </span>
        </div>
      </header>

      {/* Main escrow card */}
      <div className="px-5 mt-1">
        <div
          className="relative rounded-[2rem] overflow-hidden border-2 p-6 transition-all duration-700"
          style={{
            borderColor: isDone
              ? "oklch(0.88 0.17 180 / 0.5)"
              : isExpired
              ? "oklch(0.72 0.19 42 / 0.4)"
              : "oklch(0.87 0.17 92 / 0.35)",
            background: isDone
              ? "radial-gradient(circle at 50% 35%, oklch(0.35 0.20 165 / 0.6), oklch(0.15 0.06 180) 75%)"
              : isExpired
              ? "radial-gradient(circle at 50% 35%, oklch(0.32 0.14 45 / 0.5), oklch(0.15 0.05 45) 75%)"
              : "radial-gradient(circle at 50% 35%, oklch(0.32 0.16 85 / 0.55), oklch(0.15 0.04 100) 75%)",
          }}
        >
          {/* CSS-animated ambient particles — paused when reduced-motion */}
          <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden="true">
            {Array.from({ length: 8 }).map((_, i) => (
              <div
                key={i}
                className={`absolute rounded-full escrow-particle ${
                  isDone ? "bg-cyan/50" : isExpired ? "bg-orange-400/35" : "bg-gold/35"
                }`}
                style={{
                  width: 4 + (i % 3) * 2,
                  height: 4 + (i % 3) * 2,
                  left: `${10 + (i * 11.3) % 80}%`,
                  top: `${10 + (i * 14.7) % 75}%`,
                  animationDelay: `${i * 0.55}s`,
                  animationDuration: `${3.5 + (i % 3) * 0.8}s`,
                }}
              />
            ))}
          </div>

          <div className="flex items-center gap-5 relative">
            {/* Breathing countdown ring */}
            <div
              className="relative shrink-0 escrow-breathe"
              aria-hidden="true"
            >
              <svg width="120" height="120" viewBox="0 0 128 128" className="-rotate-90">
                <circle cx="64" cy="64" r="54" fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="9" />
                <circle
                  cx="64" cy="64" r="54"
                  fill="none"
                  stroke={ringColor}
                  strokeWidth="9"
                  strokeLinecap="round"
                  strokeDasharray={ringCircumference}
                  strokeDashoffset={isDone ? 0 : ringCircumference * (1 - progressPct / 100)}
                  style={{ transition: "stroke-dashoffset 0.8s ease, stroke 0.8s ease" }}
                />
              </svg>

              {/* Ring centre */}
              <div className="absolute inset-0 grid place-items-center">
                {isDone ? (
                  <div className="text-center escrow-milestone-pop">
                    <Sparkles className="size-7 text-cyan mx-auto" />
                    <p className="text-[9px] text-cyan font-extrabold mt-1 tracking-wider">DONE</p>
                  </div>
                ) : isTimeout ? (
                  <div className="text-center">
                    <Shield className="size-6 text-gold mx-auto" />
                    <p className="text-[9px] text-gold font-extrabold mt-1">QUEUED</p>
                  </div>
                ) : isExpired && !extended ? (
                  <div className="text-center">
                    <RotateCcw className="size-6 text-orange-400 mx-auto" />
                    <p className="text-[9px] text-orange-400 font-extrabold mt-1">EXTEND?</p>
                  </div>
                ) : (
                  <div className="text-center" aria-label={`${mins} minutes ${secs} seconds remaining`}>
                    <p className="text-[22px] font-extrabold text-white font-mono leading-none tabular-nums">
                      {String(mins).padStart(2, "0")}:{String(secs).padStart(2, "0")}
                    </p>
                    <p className="text-[9px] text-white/50 font-bold mt-0.5 tracking-wider">
                      {extended ? "EXTENDED" : "ESCROW"}
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* Status copy */}
            <div className="flex-1 min-w-0">
              {isDone ? (
                <>
                  <p className="text-base font-extrabold text-cyan">Card verified! 🎉</p>
                  <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                    Your card value was confirmed. Your payout is being sent to your wallet now.
                  </p>
                  <div className="mt-2.5 flex items-center gap-1.5">
                    <Loader2 className="size-3.5 text-cyan animate-spin" />
                    <p className="text-[11px] text-cyan font-semibold">Crediting your wallet…</p>
                  </div>
                </>
              ) : isTimeout ? (
                <>
                  <p className="text-base font-extrabold text-gold">Trade queued ✓</p>
                  <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                    The window closed, but your trade is in our priority queue. You will be paid — this takes up to 30 minutes.
                  </p>
                </>
              ) : (
                <>
                  <p className={`text-base font-extrabold transition-colors duration-300 ${isLow ? "text-orange-400" : "text-gold"}`}>
                    {isLow ? "Almost there!" : "Your card is safe"}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                    We're processing your {brand} card right now.
                    {isLow && !extended && " Running low on time — extend if you need more."}
                  </p>
                  <div className="mt-2.5 flex items-center gap-1.5 bg-black/20 rounded-xl px-3 py-1.5 w-fit">
                    <Zap className="size-3 text-gold" />
                    <p className="text-[11px] text-gold font-bold">₦{amountNgn.toLocaleString()} · rate locked</p>
                  </div>
                </>
              )}

              {/* Brand badge */}
              <div className="mt-2.5 flex items-center gap-2 bg-white/6 rounded-full px-3 py-1 w-fit">
                <span className="text-sm" aria-hidden="true">{brandEmoji}</span>
                <span className="text-xs font-bold text-white">{brand} ${amountUsd}</span>
              </div>
            </div>
          </div>

          {/* Progress bar */}
          {!isDone && !isTimeout && (
            <div className="mt-4" aria-hidden="true">
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

      {/* Poll-failure notice — shown after 3 consecutive failed polls */}
      {pollStale && !isDone && (
        <div className="px-5 mt-3">
          <div className="flex items-center gap-2.5 bg-muted/40 border border-border/60 rounded-2xl px-4 py-3">
            <WifiOff className="size-4 text-muted-foreground shrink-0" />
            <p className="text-xs text-muted-foreground leading-snug">
              Having trouble checking your status — retrying in the background. Your trade is still active.
            </p>
          </div>
        </div>
      )}

      {/* What's happening panel */}
      <div className="px-5 mt-4">
        <div className="bg-card rounded-2xl border border-border/50 p-4">
          <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mb-3 flex items-center gap-1.5">
            <Eye className="size-3" aria-hidden="true" /> What's happening right now
          </p>
          <div className="space-y-0" role="list">
            {STEPS.map((step, i) => {
              const isDoneStep = completedSteps.has(i);
              const isActiveStep = i === activeStep && !isDone && !isTimeout;
              const isAdminDoneStep = isDone && i <= activeStep;

              return (
                <div key={i} className="flex gap-3" role="listitem">
                  <div className="flex flex-col items-center">
                    <div className={`size-6 rounded-full grid place-items-center shrink-0 transition-all duration-400 ${
                      isAdminDoneStep ? "bg-cyan/20 text-cyan"
                      : isDoneStep ? "bg-cyan/15 text-cyan"
                      : isActiveStep ? "bg-gold/20 text-gold"
                      : "bg-secondary/80 text-muted-foreground/30"
                    } ${(isDoneStep || isAdminDoneStep) ? "escrow-step-complete" : ""}`}
                      aria-hidden="true"
                    >
                      {isActiveStep
                        ? <Loader2 className="size-3 animate-spin" />
                        : (isDoneStep || isAdminDoneStep)
                        ? <CheckCircle2 className="size-3" />
                        : <span className="text-[9px] font-bold">{i + 1}</span>
                      }
                    </div>
                    {i < STEPS.length - 1 && (
                      <div className={`w-px h-6 mt-0.5 mb-0.5 rounded-full transition-colors duration-400 ${
                        (isDoneStep || isAdminDoneStep) ? "bg-cyan/25" : "bg-border/30"
                      }`} />
                    )}
                  </div>
                  <div className="pb-2 pt-0.5 flex-1 min-w-0">
                    <p className={`text-xs font-bold transition-colors duration-300 ${
                      isActiveStep ? "text-gold"
                      : (isDoneStep || isAdminDoneStep) ? "text-foreground"
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

      {/* Trust anchor — always visible in every state */}
      <div className="px-5 mt-3">
        <div className={`flex items-center gap-3 rounded-2xl px-4 py-3 border transition-colors duration-500 ${
          isDone
            ? "bg-cyan/5 border-cyan/15"
            : "bg-gold/5 border-gold/15"
        }`}>
          <Shield className={`size-4 shrink-0 ${isDone ? "text-cyan" : "text-gold"}`} aria-hidden="true" />
          <div>
            <p className={`text-xs font-bold ${isDone ? "text-cyan" : "text-gold"}`}>
              ₦{amountNgn.toLocaleString()} guaranteed
            </p>
            <p className="text-[11px] text-muted-foreground/80 leading-snug">
              {isDone
                ? "Payment confirmed — money is on its way to your wallet."
                : isTimeout
                ? "Your payout is locked and will be sent within 30 minutes."
                : "Your payout is secured and will always be paid, no matter how long processing takes."}
            </p>
          </div>
        </div>
      </div>

      {/* CTA area */}
      <div className="px-5 mt-4 pb-10 space-y-3">
        {/* Extend button — low time or first expiry, not yet extended */}
        {(isLow || (isExpired && status === "extended")) && !extended && !isDone && (
          <button
            onClick={onExtend}
            className="w-full flex items-center justify-center gap-2 bg-orange-500/12 border border-orange-500/25 text-orange-400 rounded-2xl py-3.5 text-sm font-extrabold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400/60 active:scale-[0.98] transition-transform"
          >
            <RotateCcw className="size-4" aria-hidden="true" />
            Extend 3 minutes
          </button>
        )}

        {/* Timeout state */}
        {isTimeout && (
          <div className="space-y-2.5">
            <div className="bg-gold/8 border border-gold/20 rounded-2xl p-4">
              <p className="text-sm font-extrabold text-gold">Your trade is in our priority queue</p>
              <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
                The escrow window closed but your money is safe. We process queued trades within 30 minutes and will notify you the moment it's done.
              </p>
            </div>
            <button
              onClick={onProceed}
              className="w-full flex items-center justify-center gap-2 bg-gradient-gold text-jungle-deep rounded-2xl py-3.5 text-sm font-extrabold shadow-glow-gold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 active:scale-[0.98] transition-transform"
            >
              View trade status <ArrowRight className="size-4" aria-hidden="true" />
            </button>
            {onSupport && (
              <button
                onClick={onSupport}
                className="w-full flex items-center justify-center gap-2 bg-secondary border border-border/60 rounded-2xl py-3 text-sm font-semibold text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border active:scale-[0.98] transition-transform"
              >
                <MessageCircle className="size-4" aria-hidden="true" />
                Talk to support about this trade
              </button>
            )}
          </div>
        )}

        {/* Done — auto-advancing */}
        {isDone && (
          <div className="flex items-center justify-center gap-2 text-cyan text-xs font-semibold py-2">
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            Payout confirmed — loading your wallet…
          </div>
        )}

        {/* Waiting hint */}
        {!isExpired && !isDone && !isLow && (
          <p className="text-center text-[11px] text-muted-foreground/60 leading-relaxed">
            Keep this screen open · Closing it won't cancel your trade
          </p>
        )}

        {/* Support link — available in every state */}
        {onSupport && !isTimeout && (
          <button
            onClick={onSupport}
            className="w-full text-center text-[11px] text-muted-foreground/50 underline underline-offset-2 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border rounded"
          >
            Need help? Contact support
          </button>
        )}
      </div>

      {/* Global keyframe styles */}
      <style>{`
        /* Breathing ring — 4 s slow inhale/exhale cadence */
        .escrow-breathe {
          animation: escrow-breathe 4s ease-in-out infinite;
        }
        @keyframes escrow-breathe {
          0%, 100% { transform: scale(1);    opacity: 1;    }
          50%       { transform: scale(1.03); opacity: 0.92; }
        }

        /* Floating ambient particles */
        .escrow-particle {
          animation: escrow-float var(--dur, 3.5s) ease-in-out infinite;
        }
        @keyframes escrow-float {
          0%, 100% { transform: translateY(0)   scale(1);   opacity: 0.25; }
          50%       { transform: translateY(-8px) scale(1.3); opacity: 0.55; }
        }

        /* Milestone pop — plays once when a step completes */
        .escrow-step-complete {
          animation: escrow-pop 0.35s cubic-bezier(0.34, 1.56, 0.64, 1) both;
        }
        @keyframes escrow-pop {
          from { transform: scale(0.7); opacity: 0.4; }
          to   { transform: scale(1);   opacity: 1;   }
        }

        /* Sparkle pop on DONE state */
        .escrow-milestone-pop {
          animation: escrow-milestone-pop 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) both;
        }
        @keyframes escrow-milestone-pop {
          from { transform: scale(0.5); opacity: 0; }
          to   { transform: scale(1);   opacity: 1; }
        }

        /* Respect prefers-reduced-motion — keep layout, kill motion */
        @media (prefers-reduced-motion: reduce) {
          .escrow-breathe,
          .escrow-particle,
          .escrow-step-complete,
          .escrow-milestone-pop {
            animation: none !important;
          }
        }
      `}</style>
    </div>
  );
}
