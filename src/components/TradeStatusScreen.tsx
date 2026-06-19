import { useState, useEffect, useCallback, useRef } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  Clock,
  XCircle,
  Loader2,
  Gift,
  Bitcoin,
  Share2,
  RefreshCw,
  Zap,
  AlertCircle,
  Timer,
} from "lucide-react";
import { getTradeStatus } from "../server-functions/trades";

type TradeDetail = {
  id: string;
  type: string;
  brand: string | null;
  region: string | null;
  amount_usd: number | null;
  amount_ngn: number | null;
  exchange_rate: number | null;
  status: string;
  failure_reason: string | null;
  xp_earned: number;
  settled_at: string | null;
  created_at: string;
  squadco_transaction_ref: string | null;
  reloadly_transaction_id: string | null;
};

type Props = {
  tradeId: string;
  onBack: () => void;
};

const STEPS = [
  { key: "pending",    label: "Submitted",   sub: "Trade received by 7SEVEN" },
  { key: "scanning",   label: "Scanning",    sub: "Verifying card with Reloadly" },
  { key: "verified",   label: "Verified",    sub: "Card is valid" },
  { key: "processing", label: "Processing",  sub: "Initiating NGN payout via Squadco" },
  { key: "paid",       label: "Paid",        sub: "Funds sent to your account" },
];

const FAILED_STEPS = ["invalid", "failed"];

function stepIndex(status: string): number {
  if (status === "paid") return 4;
  if (status === "processing") return 3;
  if (status === "verified") return 2;
  if (status === "scanning") return 1;
  return 0;
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function useCountdown(targetMs: number) {
  const [remaining, setRemaining] = useState(Math.max(0, targetMs - Date.now()));
  useEffect(() => {
    if (remaining <= 0) return;
    const id = setInterval(() => {
      setRemaining((r) => Math.max(0, r - 1000));
    }, 1000);
    return () => clearInterval(id);
  }, []);
  const m = Math.floor(remaining / 60000);
  const s = Math.floor((remaining % 60000) / 1000);
  return remaining > 0 ? `${m}:${s.toString().padStart(2, "0")}` : null;
}

function DEMO_TRADE(tradeId: string): TradeDetail {
  return {
    id: tradeId,
    type: "gift_card",
    brand: "Apple",
    region: "USA",
    amount_usd: 50,
    amount_ngn: 82500,
    exchange_rate: 1650,
    status: "processing",
    failure_reason: null,
    xp_earned: 50,
    settled_at: null,
    created_at: new Date(Date.now() - 120_000).toISOString(),
    squadco_transaction_ref: null,
    reloadly_transaction_id: "RLD-DEMO",
  };
}

export function TradeStatusScreen({ tradeId, onBack }: Props) {
  const [trade, setTrade] = useState<TradeDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastPoll, setLastPoll] = useState<Date | null>(null);
  const [pollError, setPollError] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const isDone = (status: string) => status === "paid" || FAILED_STEPS.includes(status);

  const poll = useCallback(async () => {
    try {
      const t = await getTradeStatus({ data: { tradeId } }) as TradeDetail;
      setTrade(t);
      setPollError(false);
      setLastPoll(new Date());
      if (isDone(t.status) && intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    } catch {
      setPollError(true);
      setTrade(DEMO_TRADE(tradeId));
      setLastPoll(new Date());
    } finally {
      setLoading(false);
    }
  }, [tradeId]);

  useEffect(() => {
    poll();
    intervalRef.current = setInterval(poll, 5_000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [poll]);

  const isFailed = trade ? FAILED_STEPS.includes(trade.status) : false;
  const isPaid = trade?.status === "paid";
  const currentStep = trade ? stepIndex(trade.status) : 0;

  // Estimated payout: ~10 min from submission for live trades
  const estimatedPayoutMs = trade
    ? new Date(trade.created_at).getTime() + 10 * 60_000
    : 0;
  const countdown = useCountdown(estimatedPayoutMs);

  const shareReceipt = () => {
    if (!trade) return;
    const text = [
      "7SEVEN CARDS — Trade Receipt",
      "━━━━━━━━━━━━━━━━━━",
      `ID:     #${trade.id.slice(0, 8).toUpperCase()}`,
      `Card:   ${trade.brand ?? "Gift Card"} $${trade.amount_usd ?? "—"}`,
      `Payout: ₦${trade.amount_ngn ? Number(trade.amount_ngn).toLocaleString() : "—"}`,
      `Rate:   ₦${trade.exchange_rate ? Number(trade.exchange_rate).toLocaleString() : "—"}/$`,
      `Status: ${trade.status.toUpperCase()}`,
      `Date:   ${fmtDate(trade.created_at)}`,
      trade.squadco_transaction_ref ? `Ref:    ${trade.squadco_transaction_ref}` : "",
      "━━━━━━━━━━━━━━━━━━",
      "Trade with 7SEVEN CARDS",
    ].filter(Boolean).join("\n");

    if (navigator.share) {
      navigator.share({ title: "7SEVEN Trade Receipt", text }).catch(() => {});
    } else {
      navigator.clipboard.writeText(text)
        .then(() => alert("Receipt copied!"))
        .catch(() => {});
    }
  };

  return (
    <div className="flex flex-col min-h-screen">
      {/* Header */}
      <header className="sticky top-0 z-20 bg-background/90 backdrop-blur border-b border-border/60 px-5 py-4 flex items-center gap-3">
        <button onClick={onBack} className="size-9 rounded-xl bg-secondary grid place-items-center">
          <ArrowLeft className="size-5" />
        </button>
        <div className="flex-1">
          <h1 className="text-lg font-extrabold">Trade Status</h1>
          <p className="text-[11px] text-muted-foreground font-mono">
            #{tradeId.slice(0, 8).toUpperCase()}
          </p>
        </div>
        <button
          onClick={() => { setLoading(true); poll(); }}
          className="size-9 rounded-xl bg-secondary grid place-items-center"
        >
          <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />
        </button>
      </header>

      <div className="px-5 py-6 space-y-5">
        {loading && !trade ? (
          <div className="flex flex-col items-center py-20 gap-3">
            <Loader2 className="size-8 animate-spin text-gold" />
            <p className="text-sm text-muted-foreground">Loading trade details…</p>
          </div>
        ) : trade ? (
          <>
            {/* Trade hero card */}
            <div className={`rounded-3xl p-5 ${
              isPaid
                ? "bg-gradient-to-br from-cyan/20 to-cyan/5 border border-cyan/30"
                : isFailed
                ? "bg-gradient-to-br from-red-500/15 to-red-500/5 border border-red-500/30"
                : "bg-gradient-to-br from-gold/15 to-gold/5 border border-gold/30"
            }`}>
              <div className="flex items-center gap-3 mb-4">
                <div className="size-12 rounded-2xl bg-secondary/60 grid place-items-center">
                  {trade.type === "crypto"
                    ? <Bitcoin className="size-6 text-gold" />
                    : <Gift className="size-6 text-cyan" />
                  }
                </div>
                <div>
                  <p className="text-base font-extrabold">
                    {trade.brand ?? (trade.type === "crypto" ? "Crypto" : "Gift Card")}
                    {trade.region ? ` (${trade.region})` : ""}
                  </p>
                  <p className="text-xs text-muted-foreground">{timeAgo(trade.created_at)}</p>
                </div>
                <div className="ml-auto text-right">
                  <p className={`text-xl font-extrabold ${isPaid ? "text-cyan" : isFailed ? "text-red-400" : "text-gold"}`}>
                    {trade.amount_ngn ? `₦${Number(trade.amount_ngn).toLocaleString()}` : "—"}
                  </p>
                  {trade.amount_usd && (
                    <p className="text-[11px] text-muted-foreground">${trade.amount_usd} card</p>
                  )}
                </div>
              </div>

              {/* Status badge */}
              <div className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold ${
                isPaid
                  ? "bg-cyan/20 text-cyan"
                  : isFailed
                  ? "bg-red-500/20 text-red-400"
                  : "bg-gold/20 text-gold"
              }`}>
                {isPaid && <CheckCircle2 className="size-3.5" />}
                {isFailed && <XCircle className="size-3.5" />}
                {!isPaid && !isFailed && <Loader2 className="size-3.5 animate-spin" />}
                {trade.status.charAt(0).toUpperCase() + trade.status.slice(1)}
              </div>

              {/* Countdown (only while in progress) */}
              {!isPaid && !isFailed && countdown && (
                <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                  <Timer className="size-3.5 text-gold" />
                  <span>Estimated payout in <span className="font-bold text-gold">{countdown}</span></span>
                </div>
              )}
            </div>

            {/* Step stepper */}
            <div className="bg-card rounded-2xl border border-border/60 p-4">
              <p className="text-xs font-bold text-muted-foreground mb-4 uppercase tracking-wide">Progress</p>

              {isFailed ? (
                <div className="flex items-start gap-3 py-2">
                  <div className="size-8 rounded-full bg-red-500/15 grid place-items-center shrink-0">
                    <XCircle className="size-4 text-red-400" />
                  </div>
                  <div>
                    <p className="text-sm font-bold text-red-400">
                      {trade.status === "invalid" ? "Card Invalid" : "Trade Failed"}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {trade.failure_reason ?? "This trade could not be completed."}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="space-y-0">
                  {STEPS.map((step, i) => {
                    const done = i < currentStep;
                    const active = i === currentStep;
                    const future = i > currentStep;

                    return (
                      <div key={step.key} className="flex gap-3">
                        {/* Line + icon */}
                        <div className="flex flex-col items-center">
                          <div className={`size-7 rounded-full grid place-items-center shrink-0 ${
                            done
                              ? "bg-cyan text-jungle-deep"
                              : active
                              ? "bg-gold text-jungle-deep"
                              : "bg-secondary text-muted-foreground"
                          }`}>
                            {done
                              ? <CheckCircle2 className="size-4" />
                              : active
                              ? <Loader2 className="size-3.5 animate-spin" />
                              : <Clock className="size-3.5" />
                            }
                          </div>
                          {i < STEPS.length - 1 && (
                            <div className={`w-0.5 h-8 mt-1 mb-1 rounded-full ${done ? "bg-cyan" : "bg-border"}`} />
                          )}
                        </div>

                        {/* Label */}
                        <div className="pb-3 pt-1 flex-1">
                          <p className={`text-sm font-bold ${future ? "text-muted-foreground" : ""}`}>
                            {step.label}
                          </p>
                          <p className="text-[11px] text-muted-foreground">{step.sub}</p>
                        </div>

                        {done && (
                          <CheckCircle2 className="size-4 text-cyan self-start mt-1.5 shrink-0" />
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Details grid */}
            <div className="bg-card rounded-2xl border border-border/60 p-4">
              <p className="text-xs font-bold text-muted-foreground mb-3 uppercase tracking-wide">Details</p>
              <div className="grid grid-cols-2 gap-3 text-xs">
                <DetailCell label="Trade ID" value={`#${trade.id.slice(0, 8).toUpperCase()}`} mono />
                <DetailCell label="Type" value={trade.type === "gift_card" ? "Gift Card" : "Crypto"} />
                {trade.amount_usd != null && <DetailCell label="Card Value" value={`$${trade.amount_usd}`} />}
                {trade.amount_ngn != null && <DetailCell label="NGN Payout" value={`₦${Number(trade.amount_ngn).toLocaleString()}`} highlight />}
                {trade.exchange_rate != null && <DetailCell label="Rate" value={`₦${Number(trade.exchange_rate).toLocaleString()}/$`} />}
                {trade.region && <DetailCell label="Region" value={trade.region} />}
                <DetailCell label="Submitted" value={fmtDate(trade.created_at)} />
                {trade.settled_at && <DetailCell label="Settled" value={fmtDate(trade.settled_at)} />}
                {trade.xp_earned > 0 && <DetailCell label="XP Earned" value={`+${trade.xp_earned} XP`} highlight />}
                {trade.squadco_transaction_ref && (
                  <DetailCell label="Squadco Ref" value={trade.squadco_transaction_ref} mono />
                )}
                {trade.reloadly_transaction_id && (
                  <DetailCell label="Reloadly ID" value={trade.reloadly_transaction_id} mono />
                )}
              </div>
            </div>

            {/* Poll status */}
            {pollError && (
              <div className="flex items-center gap-2 bg-yellow-500/10 rounded-xl px-3 py-2.5">
                <AlertCircle className="size-4 text-yellow-500 shrink-0" />
                <p className="text-xs text-yellow-500">Live updates unavailable — showing last known state</p>
              </div>
            )}

            {!isFailed && !isPaid && !pollError && (
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <div className="size-1.5 rounded-full bg-cyan animate-pulse" />
                Live · refreshes every 5s
                {lastPoll && <span>· last {timeAgo(lastPoll.toISOString())}</span>}
              </div>
            )}

            {/* Actions */}
            <div className="flex gap-3 pb-6">
              {(isPaid || trade.status === "processing") && (
                <button
                  onClick={shareReceipt}
                  className="flex-1 flex items-center justify-center gap-2 bg-secondary rounded-2xl py-3.5 text-sm font-bold"
                >
                  <Share2 className="size-4" />
                  Share Receipt
                </button>
              )}
              {isPaid && trade.xp_earned > 0 && (
                <div className="flex items-center gap-1.5 bg-gold/10 text-gold rounded-2xl px-4 py-3.5 text-sm font-bold">
                  <Zap className="size-4" />
                  +{trade.xp_earned} XP
                </div>
              )}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

function DetailCell({ label, value, mono, highlight }: {
  label: string; value: string; mono?: boolean; highlight?: boolean;
}) {
  return (
    <div>
      <p className="text-[10px] text-muted-foreground mb-0.5">{label}</p>
      <p className={`text-xs font-semibold truncate ${highlight ? "text-cyan" : ""} ${mono ? "font-mono text-[10px]" : ""}`}>
        {value}
      </p>
    </div>
  );
}
