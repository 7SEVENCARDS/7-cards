import { useState, useCallback, useRef } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  XCircle,
  Clock,
  AlertTriangle,
  Users,
  TrendingUp,
  ShieldCheck,
  Eye,
  Loader2,
  RefreshCw,
  Gift,
  CreditCard,
  BarChart3,
  ChevronRight,
  Ban,
  Check,
  Wallet,
  DollarSign,
  Pencil,
  Save,
  X,
  Upload,
} from "lucide-react";
import {
  getAdminStats,
  getKYCQueue,
  approveKYC,
  rejectKYC,
  getManualReviewQueue,
  approveManualTrade,
  rejectManualTrade,
  getAdminTrades,
  adminCreditWallet,
  getAdminRates,
  updateExchangeRate,
  bulkUpdateRates,
} from "../server-functions/admin";

type AdminTab = "stats" | "kyc" | "review" | "trades" | "rates" | "credit";

type Props = {
  adminId: string;
  onBack: () => void;
};

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function formatNgn(n: number) {
  return "₦" + n.toLocaleString();
}

function statusBadge(status: string) {
  switch (status) {
    case "paid": return "bg-cyan/10 text-cyan";
    case "processing": return "bg-gold/10 text-gold";
    case "scanning":
    case "verified": return "bg-gold/10 text-gold";
    case "invalid":
    case "failed": return "bg-red-500/10 text-red-400";
    default: return "bg-secondary text-muted-foreground";
  }
}

// ─── Stats Tab ────────────────────────────────────────────────────────────────
function StatsTab({ adminId }: { adminId: string }) {
  const [stats, setStats] = useState<Awaited<ReturnType<typeof getAdminStats>> | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const s = await getAdminStats({ data: { adminId } });
      setStats(s);
    } catch { /* handled below */ } finally {
      setLoading(false);
    }
  }, [adminId]);

  // Auto-load on mount
  if (!stats && !loading) load();

  if (loading) return <CenterLoader />;
  if (!stats) return (
    <div className="px-5 py-8 text-center">
      <p className="text-sm text-muted-foreground">Failed to load stats.</p>
      <button onClick={load} className="mt-4 text-xs text-cyan underline">Retry</button>
    </div>
  );

  return (
    <div className="px-5 pt-4 pb-10 space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <StatCard icon={Users} label="Total Users" value={stats.totalUsers.toLocaleString()} color="text-cyan" />
        <StatCard icon={TrendingUp} label="Paid Trades" value={stats.totalPaidTrades.toLocaleString()} color="text-gold" />
        <StatCard icon={CreditCard} label="Monthly Volume" value={formatNgn(stats.monthlyVolumeNgn)} color="text-green-400" />
        <StatCard icon={BarChart3} label="Today's Trades" value={stats.todayTradeCount.toLocaleString()} color="text-cyan" />
      </div>

      <div className="bg-gradient-card rounded-2xl border border-white/5 divide-y divide-white/5">
        <ActionRow
          icon={ShieldCheck}
          label="KYC Pending Review"
          value={stats.pendingKycCount}
          color="text-gold"
          urgent={stats.pendingKycCount > 0}
        />
        <ActionRow
          icon={Eye}
          label="Cards Awaiting Review"
          value={stats.manualReviewCount}
          color="text-orange-400"
          urgent={stats.manualReviewCount > 0}
        />
      </div>

      <button
        onClick={load}
        className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-secondary text-xs font-semibold text-muted-foreground"
      >
        <RefreshCw className="size-3.5" /> Refresh
      </button>
    </div>
  );
}

// ─── KYC Queue Tab ────────────────────────────────────────────────────────────
function KYCTab({ adminId }: { adminId: string }) {
  type KYCEntry = { id: string; full_name: string | null; phone: string | null; kyc_bvn: string | null; kyc_nin: string | null; created_at: string };
  const [queue, setQueue] = useState<KYCEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState<{ id: string; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await getKYCQueue({ data: { adminId } });
      setQueue(rows as KYCEntry[]);
    } catch { setQueue([]); } finally { setLoading(false); }
  }, [adminId]);

  if (!queue && !loading) load();
  if (loading) return <CenterLoader />;

  const handleApprove = async (userId: string) => {
    setActing(userId);
    try {
      await approveKYC({ data: { adminId, userId } });
      setQueue((q) => (q ?? []).filter((r) => r.id !== userId));
    } finally { setActing(null); }
  };

  const handleReject = async () => {
    if (!rejectReason) return;
    setActing(rejectReason.id);
    try {
      await rejectKYC({ data: { adminId, userId: rejectReason.id, reason: rejectReason.text } });
      setQueue((q) => (q ?? []).filter((r) => r.id !== rejectReason.id));
      setRejectReason(null);
    } finally { setActing(null); }
  };

  return (
    <div className="px-5 pt-4 pb-10 space-y-3">
      {rejectReason && (
        <div className="fixed inset-0 bg-black/70 flex items-end z-50 p-4">
          <div className="w-full bg-card rounded-3xl p-6 space-y-4">
            <p className="font-bold text-sm">Reason for rejection</p>
            <textarea
              className="w-full bg-secondary rounded-xl px-4 py-3 text-sm resize-none h-24 outline-none"
              placeholder="e.g. Name mismatch, unreadable document..."
              value={rejectReason.text}
              onChange={(e) => setRejectReason({ ...rejectReason, text: e.target.value })}
            />
            <div className="flex gap-3">
              <button
                onClick={() => setRejectReason(null)}
                className="flex-1 py-3 rounded-xl bg-secondary text-sm font-semibold"
              >
                Cancel
              </button>
              <button
                onClick={handleReject}
                disabled={!rejectReason.text.trim() || !!acting}
                className="flex-1 py-3 rounded-xl bg-red-500 text-white text-sm font-semibold disabled:opacity-50"
              >
                {acting ? <Loader2 className="size-4 animate-spin mx-auto" /> : "Reject"}
              </button>
            </div>
          </div>
        </div>
      )}

      {(!queue || queue.length === 0) ? (
        <EmptyState icon={ShieldCheck} message="No pending KYC submissions" />
      ) : (
        <>
          <p className="text-xs text-muted-foreground font-semibold uppercase tracking-widest">{queue.length} pending</p>
          {queue.map((entry) => (
            <div key={entry.id} className="bg-gradient-card rounded-2xl border border-white/5 p-4 space-y-3">
              <div className="flex items-start justify-between">
                <div>
                  <p className="font-bold text-sm">{entry.full_name ?? "—"}</p>
                  <p className="text-xs text-muted-foreground">{entry.phone ?? "No phone"}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{timeAgo(entry.created_at)}</p>
                </div>
                <span className="px-2 py-0.5 rounded-full bg-gold/10 text-gold text-[10px] font-bold">PENDING</span>
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="bg-secondary rounded-xl p-3">
                  <p className="text-muted-foreground mb-1">BVN</p>
                  <p className="font-mono font-semibold">{entry.kyc_bvn ? `${entry.kyc_bvn.slice(0, 4)}••••••` : "Not provided"}</p>
                </div>
                <div className="bg-secondary rounded-xl p-3">
                  <p className="text-muted-foreground mb-1">NIN</p>
                  <p className="font-mono font-semibold">{entry.kyc_nin ? `${entry.kyc_nin.slice(0, 4)}••••••` : "Not provided"}</p>
                </div>
              </div>

              <div className="flex gap-2">
                <button
                  onClick={() => handleApprove(entry.id)}
                  disabled={!!acting}
                  className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-cyan/15 text-cyan text-xs font-bold disabled:opacity-50"
                >
                  {acting === entry.id ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                  Approve
                </button>
                <button
                  onClick={() => setRejectReason({ id: entry.id, text: "" })}
                  disabled={!!acting}
                  className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-red-500/10 text-red-400 text-xs font-bold disabled:opacity-50"
                >
                  <Ban className="size-3.5" />
                  Reject
                </button>
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

// ─── Manual Review Tab ────────────────────────────────────────────────────────
function ReviewTab({ adminId }: { adminId: string }) {
  type ReviewEntry = {
    id: string; brand: string | null; region: string | null;
    amount_usd: number | null; amount_ngn: number | null; card_code: string | null;
    created_at: string; profiles: { full_name: string | null; phone: string | null } | null;
  };
  const [queue, setQueue] = useState<ReviewEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState<string | null>(null);
  const [rejectModal, setRejectModal] = useState<{ id: string; text: string } | null>(null);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await getManualReviewQueue({ data: { adminId } });
      setQueue(rows as ReviewEntry[]);
    } catch { setQueue([]); } finally { setLoading(false); }
  }, [adminId]);

  if (!queue && !loading) load();
  if (loading) return <CenterLoader />;

  const handleApprove = async (tradeId: string) => {
    setActing(tradeId);
    try {
      await approveManualTrade({ data: { adminId, tradeId } });
      setQueue((q) => (q ?? []).filter((r) => r.id !== tradeId));
    } finally { setActing(null); }
  };

  const handleReject = async () => {
    if (!rejectModal) return;
    setActing(rejectModal.id);
    try {
      await rejectManualTrade({ data: { adminId, tradeId: rejectModal.id, reason: rejectModal.text } });
      setQueue((q) => (q ?? []).filter((r) => r.id !== rejectModal.id));
      setRejectModal(null);
    } finally { setActing(null); }
  };

  return (
    <div className="px-5 pt-4 pb-10 space-y-3">
      {rejectModal && (
        <div className="fixed inset-0 bg-black/70 flex items-end z-50 p-4">
          <div className="w-full bg-card rounded-3xl p-6 space-y-4">
            <p className="font-bold text-sm">Why is this card rejected?</p>
            <textarea
              className="w-full bg-secondary rounded-xl px-4 py-3 text-sm resize-none h-24 outline-none"
              placeholder="e.g. Invalid code, already redeemed..."
              value={rejectModal.text}
              onChange={(e) => setRejectModal({ ...rejectModal, text: e.target.value })}
            />
            <div className="flex gap-3">
              <button onClick={() => setRejectModal(null)} className="flex-1 py-3 rounded-xl bg-secondary text-sm font-semibold">Cancel</button>
              <button
                onClick={handleReject}
                disabled={!rejectModal.text.trim() || !!acting}
                className="flex-1 py-3 rounded-xl bg-red-500 text-white text-sm font-semibold disabled:opacity-50"
              >
                {acting ? <Loader2 className="size-4 animate-spin mx-auto" /> : "Reject"}
              </button>
            </div>
          </div>
        </div>
      )}

      {(!queue || queue.length === 0) ? (
        <EmptyState icon={Gift} message="No cards awaiting review" />
      ) : (
        <>
          <p className="text-xs text-muted-foreground font-semibold uppercase tracking-widest">{queue.length} awaiting review</p>
          {queue.map((entry) => (
            <div key={entry.id} className="bg-gradient-card rounded-2xl border border-white/5 p-4 space-y-3">
              <div className="flex items-start justify-between">
                <div>
                  <p className="font-bold text-sm">{entry.brand ?? "Gift Card"} <span className="text-muted-foreground text-xs">({entry.region ?? "USA"})</span></p>
                  <p className="text-xs text-muted-foreground">{entry.profiles?.full_name ?? "—"} · {entry.profiles?.phone ?? ""}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{timeAgo(entry.created_at)}</p>
                </div>
                <div className="text-right">
                  <p className="font-bold text-sm text-cyan">{entry.amount_usd != null ? `$${entry.amount_usd}` : "—"}</p>
                  <p className="text-xs text-muted-foreground">{entry.amount_ngn != null ? formatNgn(entry.amount_ngn) : ""}</p>
                </div>
              </div>

              <div className="bg-secondary rounded-xl px-4 py-3 flex items-center justify-between">
                <div>
                  <p className="text-xs text-muted-foreground mb-0.5">Card Code</p>
                  <p className="font-mono text-xs font-semibold">
                    {revealed.has(entry.id)
                      ? (entry.card_code ?? "—")
                      : `${(entry.card_code ?? "").slice(0, 4)}••••••••`}
                  </p>
                </div>
                <button
                  onClick={() => setRevealed((s) => { const n = new Set(s); s.has(entry.id) ? n.delete(entry.id) : n.add(entry.id); return n; })}
                  className="text-xs text-cyan underline"
                >
                  {revealed.has(entry.id) ? "Hide" : "Reveal"}
                </button>
              </div>

              <div className="flex gap-2">
                <button
                  onClick={() => handleApprove(entry.id)}
                  disabled={!!acting}
                  className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-cyan/15 text-cyan text-xs font-bold disabled:opacity-50"
                >
                  {acting === entry.id ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                  Approve
                </button>
                <button
                  onClick={() => setRejectModal({ id: entry.id, text: "" })}
                  disabled={!!acting}
                  className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-red-500/10 text-red-400 text-xs font-bold disabled:opacity-50"
                >
                  <Ban className="size-3.5" />
                  Reject
                </button>
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

// ─── All Trades Tab ───────────────────────────────────────────────────────────
function TradesTab({ adminId }: { adminId: string }) {
  const [trades, setTrades] = useState<{ trades: unknown[]; total: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(0);
  const [status, setStatus] = useState("all");
  const PAGE_SIZE = 20;

  const load = useCallback(async (p = 0, s = status) => {
    setLoading(true);
    try {
      const res = await getAdminTrades({ data: { adminId, page: p, pageSize: PAGE_SIZE, status: s } });
      setTrades(res as { trades: unknown[]; total: number });
      setPage(p);
    } catch { /* ignore */ } finally { setLoading(false); }
  }, [adminId, status]);

  if (!trades && !loading) load(0, status);

  type TradeRow = {
    id: string; type: string; brand: string | null; amount_usd: number | null;
    amount_ngn: number | null; status: string; requires_manual_review: boolean;
    settled_at: string | null; created_at: string;
    profiles: { full_name: string | null; phone: string | null } | null;
  };

  const STATUS_OPTS = ["all", "paid", "pending", "scanning", "verified", "processing", "invalid", "failed"];

  return (
    <div className="pb-10">
      <div className="px-5 pt-4 flex gap-2 overflow-x-auto pb-3 no-scrollbar">
        {STATUS_OPTS.map((s) => (
          <button
            key={s}
            onClick={() => { setStatus(s); load(0, s); }}
            className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ${
              status === s ? "bg-cyan text-jungle-deep" : "bg-secondary text-muted-foreground"
            }`}
          >
            {s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>

      {loading ? <CenterLoader /> : (
        <div className="px-5 space-y-2">
          {!trades || (trades.trades as TradeRow[]).length === 0 ? (
            <EmptyState icon={TrendingUp} message="No trades found" />
          ) : (
            <>
              <p className="text-xs text-muted-foreground font-semibold uppercase tracking-widest">
                {trades.total.toLocaleString()} total · page {page + 1}
              </p>
              {(trades.trades as TradeRow[]).map((t) => (
                <div key={t.id} className="bg-gradient-card rounded-2xl border border-white/5 p-4">
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="font-bold text-xs truncate">{t.profiles?.full_name ?? "—"}</p>
                        {t.requires_manual_review && (
                          <span className="shrink-0 px-1.5 py-0.5 rounded-full bg-orange-500/20 text-orange-400 text-[9px] font-bold">REVIEW</span>
                        )}
                      </div>
                      <p className="text-[10px] text-muted-foreground">{t.brand ?? t.type} · {timeAgo(t.created_at)}</p>
                    </div>
                    <div className="text-right shrink-0 ml-2">
                      <p className="font-bold text-xs text-cyan">{t.amount_ngn != null ? formatNgn(t.amount_ngn) : "—"}</p>
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${statusBadge(t.status)}`}>
                        {t.status}
                      </span>
                    </div>
                  </div>
                </div>
              ))}

              <div className="flex gap-3 pt-2">
                <button
                  disabled={page === 0 || loading}
                  onClick={() => load(page - 1, status)}
                  className="flex-1 py-2.5 rounded-xl bg-secondary text-xs font-semibold disabled:opacity-40"
                >
                  ← Prev
                </button>
                <button
                  disabled={(page + 1) * PAGE_SIZE >= trades.total || loading}
                  onClick={() => load(page + 1, status)}
                  className="flex-1 py-2.5 rounded-xl bg-secondary text-xs font-semibold disabled:opacity-40"
                >
                  Next →
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Rates Tab ───────────────────────────────────────────────────────────────
const BRAND_EMOJI: Record<string, string> = {
  Apple: "🍎", Amazon: "📦", Steam: "🎮", "Google Play": "▶️",
  Xbox: "🟢", PlayStation: "🎯", Netflix: "🎬", Spotify: "🎵",
};

function RatesTab({ adminId }: { adminId: string }) {
  type Rate = { id: string; brand: string; region: string; rate_per_dollar: number; trend: string; updated_at: string };
  const [rates, setRates] = useState<Rate[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<{ brand: string; region: string; value: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ brand: string; ok: boolean; msg: string } | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [newBrand, setNewBrand] = useState({ name: "", region: "USA", rate: "" });
  const [addingNew, setAddingNew] = useState(false);

  // CSV import state
  type CsvRow = { brand: string; region: string; ratePerDollar: number; error?: string };
  const [csvRows, setCsvRows] = useState<CsvRow[] | null>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ imported: number; failed: number } | null>(null);
  const csvInputRef = useRef<HTMLInputElement>(null);

  const parseCsv = (text: string): CsvRow[] => {
    const lines = text.trim().split(/\r?\n/);
    const rows: CsvRow[] = [];
    for (const line of lines) {
      if (!line.trim() || /^brand\s*,/i.test(line)) continue; // skip header
      const parts = line.split(",").map(p => p.trim());
      const brand = parts[0] ?? "";
      const region = parts[1] ?? "USA";
      const rate = parseFloat(parts[2] ?? "");
      if (!brand) continue;
      if (isNaN(rate) || rate < 100 || rate > 10_000) {
        rows.push({ brand, region, ratePerDollar: rate, error: "Rate out of range (₦100–₦10,000)" });
      } else {
        rows.push({ brand, region, ratePerDollar: rate });
      }
    }
    return rows;
  };

  const handleCsvFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportResult(null);
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      setCsvRows(parseCsv(text));
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const handleCsvImport = async () => {
    if (!csvRows) return;
    const validRows = csvRows.filter(r => !r.error);
    if (!validRows.length) return;
    setImporting(true);
    try {
      const res = await bulkUpdateRates({ data: { adminId, rows: validRows } });
      setImportResult({ imported: res.imported, failed: res.failed });
      if (res.imported > 0) {
        await load();
        setCsvRows(null);
      }
    } catch {
      setImportResult({ imported: 0, failed: validRows.length });
    } finally {
      setImporting(false);
    }
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await getAdminRates({ data: { adminId } });
      setRates(rows as Rate[]);
    } catch { setRates([]); } finally { setLoading(false); }
  }, [adminId]);

  if (!rates && !loading) load();
  if (loading) return <CenterLoader />;

  const startEdit = (r: Rate) =>
    setEditing({ brand: r.brand, region: r.region, value: String(r.rate_per_dollar) });

  const save = async () => {
    if (!editing) return;
    const parsed = parseInt(editing.value.replace(/[^\d]/g, ""), 10);
    if (!parsed || parsed < 100) {
      setFeedback({ brand: editing.brand, ok: false, msg: "Enter a valid rate (min ₦100)" });
      return;
    }
    setSaving(true);
    try {
      const res = await updateExchangeRate({
        data: { adminId, brand: editing.brand, region: editing.region, ratePerDollar: parsed },
      });
      if (res.success) {
        setRates((prev) =>
          (prev ?? []).map((r) =>
            r.brand === editing.brand && r.region === editing.region
              ? { ...r, rate_per_dollar: parsed, trend: res.trend ?? r.trend, updated_at: new Date().toISOString() }
              : r
          )
        );
        setFeedback({ brand: editing.brand, ok: true, msg: `Saved ₦${parsed.toLocaleString()}/$ ${res.trend}` });
        setEditing(null);
      } else {
        setFeedback({ brand: editing.brand, ok: false, msg: res.error ?? "Save failed" });
      }
    } catch (e: unknown) {
      setFeedback({ brand: editing.brand, ok: false, msg: e instanceof Error ? e.message : "Error" });
    } finally { setSaving(false); }
  };

  return (
    <div className="px-5 pt-4 pb-10 space-y-3">
      {/* New Brand modal */}
      {showNew && (
        <div className="fixed inset-0 bg-black/70 flex items-end z-50 p-4">
          <div className="w-full bg-card rounded-3xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <p className="font-bold text-sm">Add New Brand</p>
              <button onClick={() => { setShowNew(false); setNewBrand({ name: "", region: "USA", rate: "" }); }}>
                <X className="size-4 text-muted-foreground" />
              </button>
            </div>

            <div className="space-y-3">
              <label className="block">
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">Brand Name</span>
                <input
                  autoFocus
                  className="mt-1.5 w-full bg-secondary rounded-xl px-4 py-3 text-sm outline-none"
                  placeholder="e.g. eBay, Razer Gold, iTunes"
                  value={newBrand.name}
                  onChange={(e) => setNewBrand((b) => ({ ...b, name: e.target.value }))}
                />
              </label>

              <label className="block">
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">Region</span>
                <select
                  className="mt-1.5 w-full bg-secondary rounded-xl px-4 py-3 text-sm outline-none"
                  value={newBrand.region}
                  onChange={(e) => setNewBrand((b) => ({ ...b, region: e.target.value }))}
                >
                  {["USA", "UK", "Canada", "Australia", "Europe"].map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
              </label>

              <label className="block">
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">Rate (₦ per $1)</span>
                <input
                  type="number"
                  className="mt-1.5 w-full bg-secondary rounded-xl px-4 py-3 text-sm outline-none"
                  placeholder="e.g. 1450"
                  value={newBrand.rate}
                  onChange={(e) => setNewBrand((b) => ({ ...b, rate: e.target.value }))}
                />
              </label>
            </div>

            {feedback?.brand === "__new__" && (
              <p className={`text-xs font-semibold ${feedback.ok ? "text-cyan" : "text-red-400"}`}>
                {feedback.ok ? "✓ " : "✗ "}{feedback.msg}
              </p>
            )}

            <div className="flex gap-3">
              <button
                onClick={() => { setShowNew(false); setNewBrand({ name: "", region: "USA", rate: "" }); }}
                className="flex-1 py-3 rounded-xl bg-secondary text-sm font-semibold"
              >
                Cancel
              </button>
              <button
                disabled={addingNew || !newBrand.name.trim() || !newBrand.rate}
                onClick={async () => {
                  const parsed = parseInt(newBrand.rate.replace(/[^\d]/g, ""), 10);
                  if (!parsed || parsed < 100) {
                    setFeedback({ brand: "__new__", ok: false, msg: "Rate must be at least ₦100" });
                    return;
                  }
                  setAddingNew(true);
                  try {
                    const res = await updateExchangeRate({
                      data: { adminId, brand: newBrand.name.trim(), region: newBrand.region, ratePerDollar: parsed },
                    });
                    if (res.success) {
                      setRates((prev) => [
                        ...(prev ?? []),
                        { id: Date.now().toString(), brand: newBrand.name.trim(), region: newBrand.region, rate_per_dollar: parsed, trend: res.trend ?? "+0.0%", updated_at: new Date().toISOString() },
                      ].sort((a, b) => a.brand.localeCompare(b.brand)));
                      setShowNew(false);
                      setNewBrand({ name: "", region: "USA", rate: "" });
                      setFeedback({ brand: newBrand.name.trim(), ok: true, msg: `Added ₦${parsed.toLocaleString()}/$` });
                    } else {
                      setFeedback({ brand: "__new__", ok: false, msg: res.error ?? "Failed to add brand" });
                    }
                  } catch (e: unknown) {
                    setFeedback({ brand: "__new__", ok: false, msg: e instanceof Error ? e.message : "Error" });
                  } finally { setAddingNew(false); }
                }}
                className="flex-1 py-3 rounded-xl bg-cyan text-jungle-deep text-sm font-extrabold disabled:opacity-40"
              >
                {addingNew ? <Loader2 className="size-4 animate-spin mx-auto" /> : "Add Brand"}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground font-semibold uppercase tracking-widest">
          Gift Card Rates (₦ per $1)
        </p>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          <button onClick={load} className="text-xs text-muted-foreground flex items-center gap-1">
            <RefreshCw className="size-3" /> Refresh
          </button>
          <button
            onClick={() => csvInputRef.current?.click()}
            className="text-xs font-bold text-muted-foreground flex items-center gap-1 bg-secondary px-3 py-1.5 rounded-full"
          >
            <Upload className="size-3" /> CSV
          </button>
          <button
            onClick={() => setShowNew(true)}
            className="text-xs font-bold text-cyan flex items-center gap-1 bg-cyan/10 px-3 py-1.5 rounded-full"
          >
            + New Brand
          </button>
        </div>
      </div>

      {/* Hidden CSV file input */}
      <input
        ref={csvInputRef}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={handleCsvFile}
      />

      {/* CSV preview panel */}
      {csvRows && (
        <div className="bg-card rounded-2xl border border-white/10 overflow-hidden">
          <div className="px-4 py-3 border-b border-white/5 flex items-center justify-between">
            <p className="text-xs font-bold">
              CSV Preview — {csvRows.filter(r => !r.error).length} valid
              {csvRows.some(r => r.error) && <span className="text-red-400"> · {csvRows.filter(r => r.error).length} errors</span>}
            </p>
            <button onClick={() => { setCsvRows(null); setImportResult(null); }} className="text-xs text-muted-foreground">
              Dismiss
            </button>
          </div>
          <div className="divide-y divide-white/5 max-h-52 overflow-y-auto">
            {csvRows.map((r, i) => (
              <div key={i} className={`flex items-center justify-between px-4 py-2.5 text-xs ${r.error ? "opacity-50" : ""}`}>
                <div className="flex items-center gap-2">
                  <span>{BRAND_EMOJI[r.brand] ?? "🎁"}</span>
                  <span className="font-semibold">{r.brand}</span>
                  <span className="text-muted-foreground">{r.region}</span>
                </div>
                {r.error
                  ? <span className="text-red-400 text-[10px]">{r.error}</span>
                  : <span className="text-cyan font-bold">₦{r.ratePerDollar.toLocaleString()}/$</span>
                }
              </div>
            ))}
          </div>
          <div className="px-4 py-3 border-t border-white/5">
            {importResult ? (
              <p className={`text-xs font-bold text-center ${importResult.failed > 0 ? "text-yellow-400" : "text-cyan"}`}>
                ✓ {importResult.imported} imported{importResult.failed > 0 ? ` · ${importResult.failed} failed` : ""}
              </p>
            ) : (
              <button
                disabled={importing || !csvRows.some(r => !r.error)}
                onClick={handleCsvImport}
                className="w-full py-2.5 rounded-xl bg-cyan text-jungle-deep font-extrabold text-xs disabled:opacity-40"
              >
                {importing
                  ? <Loader2 className="size-3.5 animate-spin mx-auto" />
                  : `Import ${csvRows.filter(r => !r.error).length} Rates`
                }
              </button>
            )}
          </div>
        </div>
      )}

      <div className="bg-secondary/50 border border-white/5 rounded-2xl px-4 py-3 text-xs text-muted-foreground">
        Tap ✏️ to edit. Use <span className="font-bold text-foreground">+ New Brand</span> to add one, or <span className="font-bold text-foreground">CSV</span> to bulk import.
        <br /><span className="opacity-70">CSV format: <code>brand,region,rate</code> — e.g. <code>Amazon,USA,1500</code></span>
      </div>

      {(!rates || rates.length === 0) ? (
        <EmptyState icon={DollarSign} message="No rates found — run migration 003 first" />
      ) : (
        rates.map((r) => {
          const isEditing = editing?.brand === r.brand && editing?.region === r.region;
          const thisFeedback = feedback?.brand === r.brand ? feedback : null;
          const trendUp = r.trend?.startsWith("+") && r.trend !== "+0.0%";
          const trendDown = r.trend?.startsWith("-");

          return (
            <div key={r.id} className="bg-gradient-card rounded-2xl border border-white/5 p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-2xl shrink-0">{BRAND_EMOJI[r.brand] ?? "🎁"}</span>
                  <div className="min-w-0">
                    <p className="font-bold text-sm truncate">{r.brand}</p>
                    <p className="text-[10px] text-muted-foreground">
                      Updated {new Date(r.updated_at).toLocaleDateString("en-NG", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {!isEditing && (
                    <>
                      <div className="text-right">
                        <p className="font-extrabold text-sm text-cyan">
                          ₦{Number(r.rate_per_dollar).toLocaleString()}
                        </p>
                        <p className={`text-[10px] font-semibold ${trendUp ? "text-green-400" : trendDown ? "text-red-400" : "text-muted-foreground"}`}>
                          {r.trend ?? "+0.0%"}
                        </p>
                      </div>
                      <button
                        onClick={() => startEdit(r)}
                        className="size-8 rounded-xl bg-secondary flex items-center justify-center"
                      >
                        <Pencil className="size-3.5 text-muted-foreground" />
                      </button>
                    </>
                  )}

                  {isEditing && (
                    <div className="flex items-center gap-2">
                      <div className="flex items-center bg-secondary rounded-xl px-3 py-2 gap-1">
                        <span className="text-xs text-muted-foreground">₦</span>
                        <input
                          autoFocus
                          type="number"
                          className="w-20 bg-transparent text-sm font-bold outline-none text-right"
                          value={editing.value}
                          onChange={(e) => setEditing({ ...editing, value: e.target.value })}
                          onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") setEditing(null); }}
                        />
                      </div>
                      <button
                        onClick={save}
                        disabled={saving}
                        className="size-8 rounded-xl bg-cyan/20 flex items-center justify-center"
                      >
                        {saving ? <Loader2 className="size-3.5 text-cyan animate-spin" /> : <Save className="size-3.5 text-cyan" />}
                      </button>
                      <button
                        onClick={() => { setEditing(null); setFeedback(null); }}
                        className="size-8 rounded-xl bg-secondary flex items-center justify-center"
                      >
                        <X className="size-3.5 text-muted-foreground" />
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {thisFeedback && (
                <p className={`text-xs mt-2 font-semibold ${thisFeedback.ok ? "text-cyan" : "text-red-400"}`}>
                  {thisFeedback.ok ? "✓ " : "✗ "}{thisFeedback.msg}
                </p>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}

// ─── Credit Wallet Tab ────────────────────────────────────────────────────────
function CreditTab({ adminId }: { adminId: string }) {
  const [userId, setUserId] = useState("");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const handleSubmit = async () => {
    const amountNum = parseInt(amount.replace(/[^\d]/g, ""), 10);
    if (!userId.trim() || !amountNum || !reason.trim()) return;

    setLoading(true);
    setResult(null);
    try {
      const res = await adminCreditWallet({ data: { adminId, userId: userId.trim(), amountNgn: amountNum, reason } });
      if (res.success) {
        setResult({ ok: true, msg: `₦${amountNum.toLocaleString()} credited successfully.` });
        setUserId(""); setAmount(""); setReason("");
      } else {
        setResult({ ok: false, msg: res.error ?? "Failed to credit wallet." });
      }
    } catch (e: unknown) {
      setResult({ ok: false, msg: e instanceof Error ? e.message : "Error occurred." });
    } finally { setLoading(false); }
  };

  return (
    <div className="px-5 pt-6 pb-10 space-y-5">
      <div className="bg-orange-500/10 border border-orange-500/30 rounded-2xl p-4">
        <div className="flex items-center gap-2 text-orange-400 text-xs font-bold">
          <AlertTriangle className="size-3.5" /> Emergency use only
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          Use this to resolve disputes or payout failures. Every action is logged.
        </p>
      </div>

      <div className="space-y-3">
        <label className="block">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">User UUID</span>
          <input
            className="mt-1.5 w-full bg-secondary rounded-xl px-4 py-3 text-sm font-mono outline-none"
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">Amount (₦)</span>
          <input
            className="mt-1.5 w-full bg-secondary rounded-xl px-4 py-3 text-sm outline-none"
            placeholder="5000"
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">Reason</span>
          <textarea
            className="mt-1.5 w-full bg-secondary rounded-xl px-4 py-3 text-sm resize-none h-20 outline-none"
            placeholder="e.g. Payout failed on trade #abc, manually crediting..."
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
      </div>

      {result && (
        <div className={`rounded-2xl p-4 text-sm font-semibold flex items-center gap-2 ${
          result.ok ? "bg-cyan/10 text-cyan" : "bg-red-500/10 text-red-400"
        }`}>
          {result.ok ? <CheckCircle2 className="size-4 shrink-0" /> : <XCircle className="size-4 shrink-0" />}
          {result.msg}
        </div>
      )}

      <button
        onClick={handleSubmit}
        disabled={loading || !userId.trim() || !amount || !reason.trim()}
        className="w-full py-4 rounded-2xl bg-gradient-gold text-jungle-deep font-extrabold text-sm disabled:opacity-40"
      >
        {loading ? <Loader2 className="size-4 animate-spin mx-auto" /> : "Credit Wallet"}
      </button>
    </div>
  );
}

// ─── Main Admin Screen ────────────────────────────────────────────────────────
export function AdminScreen({ adminId, onBack }: Props) {
  const [tab, setTab] = useState<AdminTab>("stats");

  const TABS: { key: AdminTab; label: string; icon: typeof BarChart3 }[] = [
    { key: "stats",  label: "Stats",  icon: BarChart3 },
    { key: "kyc",    label: "KYC",    icon: ShieldCheck },
    { key: "review", label: "Review", icon: Eye },
    { key: "trades", label: "Trades", icon: TrendingUp },
    { key: "rates",  label: "Rates",  icon: DollarSign },
    { key: "credit", label: "Credit", icon: Wallet },
  ];

  return (
    <div className="flex flex-col min-h-screen">
      <header className="px-5 pt-12 pb-5 bg-gradient-hero rounded-b-[2rem] shadow-glow-jungle relative overflow-hidden">
        <div className="absolute -right-8 -top-8 size-40 rounded-full bg-cyan/10 blur-2xl" />
        <button onClick={onBack} className="flex items-center gap-2 text-white/70 text-sm mb-4">
          <ArrowLeft className="size-4" /> Back
        </button>
        <div className="flex items-center gap-3">
          <div className="size-10 rounded-2xl bg-red-500/20 grid place-items-center">
            <ShieldCheck className="size-5 text-red-400" />
          </div>
          <div>
            <h1 className="text-xl font-extrabold text-white">Admin Panel</h1>
            <p className="text-xs text-white/60">7SEVEN CARDS — Operator Dashboard</p>
          </div>
        </div>
      </header>

      <div className="flex border-b border-white/5 bg-background sticky top-0 z-10 overflow-x-auto no-scrollbar">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`flex-1 flex flex-col items-center gap-1 pt-3 pb-2.5 min-w-[60px] transition-colors ${
              tab === key
                ? "text-cyan border-b-2 border-cyan"
                : "text-muted-foreground border-b-2 border-transparent"
            }`}
          >
            <Icon className="size-4" />
            <span className="text-[10px] font-semibold">{label}</span>
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === "stats"  && <StatsTab  adminId={adminId} />}
        {tab === "kyc"    && <KYCTab    adminId={adminId} />}
        {tab === "review" && <ReviewTab adminId={adminId} />}
        {tab === "trades" && <TradesTab adminId={adminId} />}
        {tab === "rates"  && <RatesTab  adminId={adminId} />}
        {tab === "credit" && <CreditTab adminId={adminId} />}
      </div>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function CenterLoader() {
  return (
    <div className="flex justify-center items-center py-16">
      <Loader2 className="size-6 animate-spin text-cyan" />
    </div>
  );
}

function EmptyState({ icon: Icon, message }: { icon: typeof CheckCircle2; message: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 gap-3 text-muted-foreground">
      <Icon className="size-10 opacity-30" />
      <p className="text-sm">{message}</p>
    </div>
  );
}

function StatCard({ icon: Icon, label, value, color }: { icon: typeof BarChart3; label: string; value: string; color: string }) {
  return (
    <div className="bg-gradient-card rounded-2xl border border-white/5 p-4">
      <Icon className={`size-5 ${color} mb-2`} />
      <p className="text-lg font-extrabold">{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

function ActionRow({ icon: Icon, label, value, color, urgent }: {
  icon: typeof ShieldCheck; label: string; value: number; color: string; urgent?: boolean;
}) {
  return (
    <div className="flex items-center justify-between px-4 py-3">
      <div className="flex items-center gap-3">
        <Icon className={`size-4 ${color}`} />
        <span className="text-sm font-semibold">{label}</span>
      </div>
      <div className="flex items-center gap-2">
        <span className={`text-sm font-bold ${urgent ? color : "text-muted-foreground"}`}>{value}</span>
        <ChevronRight className="size-3.5 text-muted-foreground" />
      </div>
    </div>
  );
}
