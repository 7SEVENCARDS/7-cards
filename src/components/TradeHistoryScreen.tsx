import { useState, useCallback } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  Clock,
  XCircle,
  AlertCircle,
  Loader2,
  Gift,
  Bitcoin,
  Share2,
  ChevronDown,
  SlidersHorizontal,
  RefreshCw,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import { getTradeHistory } from "../server-functions/trades";

type Trade = {
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
};

type Props = {
  userId: string;
  onBack: () => void;
  onViewStatus?: (tradeId: string) => void;
};

const STATUS_FILTERS = [
  { label: "All", value: "all" },
  { label: "Paid", value: "paid" },
  { label: "Pending", value: "pending" },
  { label: "Processing", value: "processing" },
  { label: "Failed", value: "failed" },
];

const TYPE_FILTERS = [
  { label: "All Types", value: "all" },
  { label: "Gift Cards", value: "gift_card" },
  { label: "Crypto", value: "crypto" },
];

function statusMeta(status: string) {
  switch (status) {
    case "paid":
      return { icon: CheckCircle2, color: "text-cyan", bg: "bg-cyan/10", label: "Paid" };
    case "processing":
      return { icon: Loader2, color: "text-gold", bg: "bg-gold/10", label: "Processing" };
    case "scanning":
    case "verified":
      return { icon: Clock, color: "text-gold", bg: "bg-gold/10", label: "Verifying" };
    case "invalid":
      return { icon: XCircle, color: "text-red-400", bg: "bg-red-500/10", label: "Invalid" };
    case "failed":
      return { icon: XCircle, color: "text-red-400", bg: "bg-red-500/10", label: "Failed" };
    default:
      return { icon: Clock, color: "text-muted-foreground", bg: "bg-secondary", label: "Pending" };
  }
}

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function TradeCard({ trade, onShare }: { trade: Trade; onShare: (t: Trade) => void }) {
  const [expanded, setExpanded] = useState(false);
  const { icon: StatusIcon, color, bg, label } = statusMeta(trade.status);
  const isPaid = trade.status === "paid";
  const isFailed = trade.status === "failed" || trade.status === "invalid";

  return (
    <div className="bg-card rounded-2xl border border-border/60 overflow-hidden">
      <button
        className="w-full flex items-center gap-3 p-4"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="size-11 rounded-xl bg-secondary grid place-items-center shrink-0">
          {trade.type === "crypto" ? (
            <Bitcoin className="size-5 text-gold" />
          ) : (
            <Gift className="size-5 text-cyan" />
          )}
        </div>

        <div className="flex-1 min-w-0 text-left">
          <p className="text-sm font-bold truncate">
            {trade.brand ?? (trade.type === "crypto" ? "Crypto" : "Gift Card")}
            {trade.region ? ` (${trade.region})` : ""}
          </p>
          <p className="text-[11px] text-muted-foreground">{timeAgo(trade.created_at)}</p>
        </div>

        <div className="text-right shrink-0">
          <p className={`text-sm font-bold ${isPaid ? "text-cyan" : isFailed ? "text-red-400" : "text-gold"}`}>
            {trade.amount_ngn ? `+₦${Number(trade.amount_ngn).toLocaleString()}` : trade.amount_usd ? `$${trade.amount_usd}` : "—"}
          </p>
          <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${bg} ${color}`}>
            <StatusIcon className="size-2.5" />
            {label}
          </span>
        </div>

        <ChevronDown className={`size-4 text-muted-foreground ml-1 transition-transform ${expanded ? "rotate-180" : ""}`} />
      </button>

      {expanded && (
        <div className="border-t border-border/60 px-4 pb-4 pt-3 space-y-3">
          <div className="grid grid-cols-2 gap-2 text-xs">
            <Detail label="Trade ID" value={trade.id.slice(0, 8).toUpperCase()} mono />
            <Detail label="Type" value={trade.type === "gift_card" ? "Gift Card" : "Crypto"} />
            {trade.amount_usd && <Detail label="Card Value" value={`$${trade.amount_usd}`} />}
            {trade.amount_ngn && <Detail label="NGN Payout" value={`₦${Number(trade.amount_ngn).toLocaleString()}`} highlight />}
            {trade.exchange_rate && <Detail label="Rate Used" value={`₦${Number(trade.exchange_rate).toLocaleString()}/$`} />}
            {trade.region && <Detail label="Region" value={trade.region} />}
            <Detail label="Submitted" value={fmtDate(trade.created_at)} />
            {trade.settled_at && <Detail label="Settled" value={fmtDate(trade.settled_at)} />}
            {trade.xp_earned > 0 && <Detail label="XP Earned" value={`+${trade.xp_earned} XP ⚡`} highlight />}
          </div>

          {trade.failure_reason && (
            <div className="flex items-start gap-2 bg-red-500/10 rounded-xl p-3">
              <AlertCircle className="size-4 text-red-400 shrink-0 mt-0.5" />
              <p className="text-xs text-red-400">{trade.failure_reason}</p>
            </div>
          )}

          <div className="flex gap-2 pt-1">
            <button
              onClick={() => onShare(trade)}
              className="flex-1 flex items-center justify-center gap-1.5 bg-secondary rounded-xl py-2.5 text-xs font-semibold"
            >
              <Share2 className="size-3.5" />
              Share Receipt
            </button>
            {onViewStatus && (
              <button
                onClick={() => onViewStatus(trade.id)}
                className={`flex items-center gap-1 rounded-xl px-3 py-2.5 text-xs font-semibold ${
                  isPaid
                    ? "bg-cyan/10 text-cyan"
                    : isFailed
                    ? "bg-red-500/10 text-red-400"
                    : "bg-gold/10 text-gold"
                }`}
              >
                {isPaid ? <CheckCircle2 className="size-3.5" /> : <RefreshCw className="size-3.5" />}
                {isPaid ? "Receipt" : "Track"}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Detail({ label, value, mono, highlight }: { label: string; value: string; mono?: boolean; highlight?: boolean }) {
  return (
    <div>
      <p className="text-[10px] text-muted-foreground mb-0.5">{label}</p>
      <p className={`text-xs font-semibold truncate ${highlight ? "text-cyan" : ""} ${mono ? "font-mono" : ""}`}>{value}</p>
    </div>
  );
}

const PAGE_SIZE = 20;

export function TradeHistoryScreen({ userId, onBack, onViewStatus }: Props) {
  const [statusFilter, setStatusFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [page, setPage] = useState(0);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [showFilterSheet, setShowFilterSheet] = useState(false);

  const load = useCallback(async (pg: number, status: string, type: string, append = false) => {
    try {
      const res = await getTradeHistory({
        data: { userId, page: pg, pageSize: PAGE_SIZE, status, type },
      });
      setTotal(res.total);
      setTrades((prev) => append ? [...prev, ...res.trades] : res.trades);
    } catch {
      // demo data
      const demo: Trade[] = Array.from({ length: 5 }, (_, i) => ({
        id: `demo-trade-${i + 1}-abcd`,
        type: i % 2 === 0 ? "gift_card" : "crypto",
        brand: ["Apple", "Amazon", "Google Play", "Steam", "iTunes"][i],
        region: "USA",
        amount_usd: [25, 50, 100, 200, 10][i],
        amount_ngn: [40000, 82500, 164000, 325000, 16000][i],
        exchange_rate: 1600,
        status: ["paid", "paid", "processing", "failed", "paid"][i],
        failure_reason: i === 3 ? "Card already redeemed" : null,
        xp_earned: [50, 100, 0, 0, 20][i],
        settled_at: i === 3 ? null : new Date(Date.now() - i * 86400000 * 2).toISOString(),
        created_at: new Date(Date.now() - i * 86400000 * 2).toISOString(),
      }));
      setTrades(append ? (prev) => [...prev, ...demo] : demo);
      setTotal(5);
    }
    setLoading(false);
    setLoadingMore(false);
  }, [userId]);

  useState(() => { load(0, statusFilter, typeFilter); });

  const applyFilters = (status: string, type: string) => {
    setStatusFilter(status);
    setTypeFilter(type);
    setPage(0);
    setLoading(true);
    setShowFilterSheet(false);
    load(0, status, type);
  };

  const loadMore = () => {
    const next = page + 1;
    setPage(next);
    setLoadingMore(true);
    load(next, statusFilter, typeFilter, true);
  };

  const shareReceipt = (trade: Trade) => {
    const text = `7SEVEN CARDS — Trade Receipt\n━━━━━━━━━━━━━━━━━━\nID: #${trade.id.slice(0, 8).toUpperCase()}\nCard: ${trade.brand ?? "Gift Card"} $${trade.amount_usd ?? "—"}\nPayout: ₦${trade.amount_ngn ? Number(trade.amount_ngn).toLocaleString() : "—"}\nStatus: ${trade.status.toUpperCase()}\nDate: ${fmtDate(trade.created_at)}\n━━━━━━━━━━━━━━━━━━\nTrade with 7SEVEN CARDS`;
    if (navigator.share) {
      navigator.share({ title: "7SEVEN Trade Receipt", text }).catch(() => {});
    } else {
      navigator.clipboard.writeText(text).then(() => toast.success("Receipt copied to clipboard")).catch(() => {});
    }
  };

  const hasMore = trades.length < total;
  const activeFilters = (statusFilter !== "all" ? 1 : 0) + (typeFilter !== "all" ? 1 : 0);

  return (
    <div className="flex flex-col min-h-screen">
      <header className="sticky top-0 z-20 bg-background/90 backdrop-blur border-b border-border/60 px-5 py-4 flex items-center gap-3">
        <button onClick={onBack} className="size-9 rounded-xl bg-secondary grid place-items-center">
          <ArrowLeft className="size-5" />
        </button>
        <div className="flex-1">
          <h1 className="text-lg font-extrabold">Trade History</h1>
          <p className="text-[11px] text-muted-foreground">{total.toLocaleString()} trades total</p>
        </div>
        <button
          onClick={() => setShowFilterSheet(true)}
          className={`relative size-9 rounded-xl grid place-items-center ${activeFilters > 0 ? "bg-gold text-jungle-deep" : "bg-secondary"}`}
        >
          <SlidersHorizontal className="size-4" />
          {activeFilters > 0 && (
            <span className="absolute -top-1 -right-1 size-4 bg-red-500 rounded-full text-[9px] text-white grid place-items-center font-bold">
              {activeFilters}
            </span>
          )}
        </button>
      </header>

      <div className="px-5 py-3 flex gap-2 overflow-x-auto scrollbar-hide">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => applyFilters(f.value, typeFilter)}
            className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors ${
              statusFilter === f.value
                ? "bg-gold text-jungle-deep border-gold"
                : "bg-card text-muted-foreground border-border/60"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="px-5 pb-32 space-y-3">
        {loading ? (
          <div className="flex flex-col items-center py-16 gap-3">
            <Loader2 className="size-7 animate-spin text-gold" />
            <p className="text-sm text-muted-foreground">Loading trades…</p>
          </div>
        ) : trades.length === 0 ? (
          <div className="flex flex-col items-center py-16 gap-3 text-center">
            <div className="size-16 rounded-2xl bg-secondary grid place-items-center">
              <Gift className="size-8 text-muted-foreground" />
            </div>
            <p className="text-base font-bold">No trades yet</p>
            <p className="text-sm text-muted-foreground max-w-[200px]">
              {statusFilter !== "all" || typeFilter !== "all"
                ? "Try clearing the filters"
                : "Sell your first gift card to get started"}
            </p>
            {(statusFilter !== "all" || typeFilter !== "all") && (
              <button
                onClick={() => applyFilters("all", "all")}
                className="flex items-center gap-1.5 text-xs text-gold font-semibold mt-1"
              >
                <RefreshCw className="size-3.5" />
                Clear filters
              </button>
            )}
          </div>
        ) : (
          <>
            {trades.map((trade) => (
              <TradeCard key={trade.id} trade={trade} onShare={shareReceipt} />
            ))}

            {hasMore && (
              <button
                onClick={loadMore}
                disabled={loadingMore}
                className="w-full py-3 bg-card border border-border/60 rounded-2xl text-sm font-semibold text-muted-foreground flex items-center justify-center gap-2"
              >
                {loadingMore ? <Loader2 className="size-4 animate-spin" /> : <ChevronDown className="size-4" />}
                {loadingMore ? "Loading…" : `Load more (${total - trades.length} remaining)`}
              </button>
            )}

            <div className="pt-4 flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
              <Zap className="size-3 text-gold" />
              Showing {trades.length} of {total} trades
            </div>
          </>
        )}
      </div>

      {showFilterSheet && (
        <div className="fixed inset-0 z-50 flex flex-col justify-end">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setShowFilterSheet(false)} />
          <div className="relative bg-card rounded-t-3xl p-6 pb-10 z-10">
            <div className="w-10 h-1 bg-border rounded-full mx-auto mb-6" />
            <h2 className="text-base font-extrabold mb-4">Filter Trades</h2>

            <p className="text-xs font-semibold text-muted-foreground mb-2">STATUS</p>
            <div className="flex flex-wrap gap-2 mb-5">
              {STATUS_FILTERS.map((f) => (
                <button
                  key={f.value}
                  onClick={() => setStatusFilter(f.value)}
                  className={`px-3 py-1.5 rounded-full text-xs font-semibold border ${
                    statusFilter === f.value
                      ? "bg-gold text-jungle-deep border-gold"
                      : "bg-secondary text-muted-foreground border-border/60"
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>

            <p className="text-xs font-semibold text-muted-foreground mb-2">TYPE</p>
            <div className="flex flex-wrap gap-2 mb-6">
              {TYPE_FILTERS.map((f) => (
                <button
                  key={f.value}
                  onClick={() => setTypeFilter(f.value)}
                  className={`px-3 py-1.5 rounded-full text-xs font-semibold border ${
                    typeFilter === f.value
                      ? "bg-gold text-jungle-deep border-gold"
                      : "bg-secondary text-muted-foreground border-border/60"
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => { setStatusFilter("all"); setTypeFilter("all"); }}
                className="flex-1 py-3 rounded-2xl bg-secondary text-sm font-bold"
              >
                Reset
              </button>
              <button
                onClick={() => applyFilters(statusFilter, typeFilter)}
                className="flex-1 py-3 rounded-2xl bg-gold text-jungle-deep text-sm font-bold"
              >
                Apply
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
