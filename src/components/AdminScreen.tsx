import { useState, useCallback, useRef, useEffect } from "react";
import { toast } from "sonner";
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
  Timer,
  Zap,
  ArrowRight,
  Building2,
  MessageCircle,
  Send,
  UserCheck,
  UserX,
  Star,
  Activity,
  UserCog,
  Shield,
  Search,
  ChevronLeft,
  Crown,
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
  getEscrowQueue,
  processEscrowTrade,
  adminListUsers,
  adminSetRole,
} from "../server-functions/admin";
import { checkSuperAdminAccess } from "../server-functions/admin-auth";
import {
  generateAdminTelegramLinkCode,
  getAdminTelegramStatus,
  unlinkAdminTelegram,
} from "../server-functions/admin-telegram";
import { AuditLogViewer } from "./AuditLogViewer";
import { VendorRatePanel } from "./VendorRatePanel";
import { MissionControlTab } from "./MissionControlTab";
import { TrustTab, TreasuryTab, ApiKeysTab, ProviderHealthTab, PremiumAdminTab } from "./AdminTabsExtra";
import { KillSwitchPanel } from "./KillSwitchPanel";
import { FounderDashboard } from "./FounderDashboard";
import {
  adminGetVendors,
  adminUpdateVendorStatus,
  adminAssignCard,
  adminSendTelegramNotification,
  adminGetWithdrawalRequests,
  adminApproveWithdrawal,
  adminRejectWithdrawal,
  adminGetVendorLeaderboard,
  adminPromoteVendorTier,
  adminRegisterVendor,
} from "../server-functions/vendors";

type AdminTab = "stats" | "kyc" | "escrow" | "review" | "trades" | "rates" | "credit" | "vendors" | "audit" | "system" | "roles" | "mission" | "trust" | "treasury" | "keys" | "health" | "premium" | "safety" | "founder";

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
      const s = await getAdminStats({ data: {} });
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

      <AdminTelegramCard />
    </div>
  );
}

// ─── Admin Telegram Connect Card ──────────────────────────────────────────────
function AdminTelegramCard() {
  const [status, setStatus] = useState<{ linked: boolean; telegramUsername: string | null; linkedAt: string | null } | null>(null);
  const [loading, setLoading] = useState(false);
  const [linkInfo, setLinkInfo] = useState<{ code: string; deepLink: string; instructions: string; expiresAt: string } | null>(null);
  const [unlinking, setUnlinking] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      const s = await getAdminTelegramStatus({ data: {} });
      setStatus(s);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  const handleGenerate = async () => {
    setLoading(true);
    try {
      const result = await generateAdminTelegramLinkCode({ data: {} });
      if (result.success) {
        setLinkInfo({ code: result.code!, deepLink: result.deepLink!, instructions: result.instructions!, expiresAt: result.expiresAt! });
      }
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  };

  const handleUnlink = async () => {
    setUnlinking(true);
    try {
      await unlinkAdminTelegram({ data: {} });
      setStatus({ linked: false, telegramUsername: null, linkedAt: null });
      setLinkInfo(null);
    } catch { /* ignore */ } finally {
      setUnlinking(false);
    }
  };

  return (
    <div className="bg-card border border-border/60 rounded-2xl p-4 space-y-3">
      <div className="flex items-center gap-2.5">
        <div className="size-9 rounded-xl bg-cyan/10 grid place-items-center shrink-0">
          <Send className="size-4 text-cyan" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold">Admin Telegram Bot</p>
          <p className="text-[11px] text-muted-foreground">
            {status?.linked
              ? `Linked as @${status.telegramUsername ?? "unknown"}`
              : "Get real-time alerts and inline approve/reject buttons"}
          </p>
        </div>
        {status?.linked && (
          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-cyan/10 text-cyan border border-cyan/20">LIVE</span>
        )}
      </div>

      {status?.linked ? (
        <div className="space-y-2">
          <p className="text-[11px] text-muted-foreground">
            You receive push notifications for manual reviews, withdrawals, KYC, and vendor rates — with inline ✅/❌ buttons.
          </p>
          <button
            onClick={handleUnlink}
            disabled={unlinking}
            className="w-full py-2.5 rounded-xl border border-border/60 text-xs font-semibold text-muted-foreground flex items-center justify-center gap-1.5"
          >
            {unlinking ? <Loader2 className="size-3.5 animate-spin" /> : <X className="size-3.5" />}
            Unlink Telegram
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {linkInfo ? (
            <div className="space-y-2">
              <div className="bg-secondary/60 rounded-xl p-3">
                <p className="text-[10px] text-muted-foreground font-bold uppercase tracking-widest mb-1">Your link code</p>
                <p className="font-mono text-sm font-bold text-cyan tracking-widest">{linkInfo.code}</p>
                <p className="text-[10px] text-muted-foreground mt-1">Expires {new Date(linkInfo.expiresAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</p>
              </div>
              <p className="text-[11px] text-muted-foreground">{linkInfo.instructions}</p>
              <a
                href={linkInfo.deepLink}
                target="_blank"
                rel="noopener noreferrer"
                className="w-full flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-cyan/10 border border-cyan/20 text-xs font-bold text-cyan"
              >
                <Send className="size-3.5" /> Open Telegram Bot
              </a>
              <button
                onClick={() => { setLinkInfo(null); loadStatus(); }}
                className="w-full py-2.5 rounded-xl bg-secondary text-xs font-semibold text-muted-foreground"
              >
                Done — Refresh Status
              </button>
            </div>
          ) : (
            <button
              onClick={handleGenerate}
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-cyan/10 border border-cyan/20 text-xs font-bold text-cyan"
            >
              {loading ? <Loader2 className="size-3.5 animate-spin" /> : <Zap className="size-3.5" />}
              Connect Telegram Bot
            </button>
          )}
        </div>
      )}
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
      const rows = await getKYCQueue({ data: {} });
      setQueue(rows as KYCEntry[]);
    } catch { setQueue([]); } finally { setLoading(false); }
  }, [adminId]);

  if (!queue && !loading) load();
  if (loading) return <CenterLoader />;

  const handleApprove = async (userId: string) => {
    setActing(userId);
    try {
      await approveKYC({ data: { userId } });
      setQueue((q) => (q ?? []).filter((r) => r.id !== userId));
    } finally { setActing(null); }
  };

  const handleReject = async () => {
    if (!rejectReason) return;
    setActing(rejectReason.id);
    try {
      await rejectKYC({ data: { userId: rejectReason.id, reason: rejectReason.text } });
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
      const rows = await getManualReviewQueue({ data: {} });
      setQueue(rows as ReviewEntry[]);
    } catch { setQueue([]); } finally { setLoading(false); }
  }, [adminId]);

  if (!queue && !loading) load();
  if (loading) return <CenterLoader />;

  const handleApprove = async (tradeId: string) => {
    setActing(tradeId);
    try {
      await approveManualTrade({ data: { tradeId } });
      setQueue((q) => (q ?? []).filter((r) => r.id !== tradeId));
    } finally { setActing(null); }
  };

  const handleReject = async () => {
    if (!rejectModal) return;
    setActing(rejectModal.id);
    try {
      await rejectManualTrade({ data: { tradeId: rejectModal.id, reason: rejectModal.text } });
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
      const res = await getAdminTrades({ data: { page: p, pageSize: PAGE_SIZE, status: s } });
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
      const res = await bulkUpdateRates({ data: { rows: validRows } });
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
      const rows = await getAdminRates({ data: {} });
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
        data: { brand: editing.brand, region: editing.region, ratePerDollar: parsed },
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
                      data: { brand: newBrand.name.trim(), region: newBrand.region, ratePerDollar: parsed },
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
      const res = await adminCreditWallet({ data: { userId: userId.trim(), amountNgn: amountNum, reason } });
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

// ─── Escrow Queue Tab ─────────────────────────────────────────────────────────
const BRAND_EMOJI_ADMIN: Record<string, string> = {
  Apple: "🍎", Amazon: "📦", Steam: "🎮", "Google Play": "▶️",
  Xbox: "🟢", PlayStation: "🎯", Netflix: "🎬", Spotify: "🎵",
};

function useElapsedMs(createdAt: string) {
  const [elapsed, setElapsed] = useState(() => Date.now() - new Date(createdAt).getTime());
  useEffect(() => {
    const id = setInterval(() => setElapsed(Date.now() - new Date(createdAt).getTime()), 1000);
    return () => clearInterval(id);
  }, [createdAt]);
  return elapsed;
}

function EscrowCard({
  entry,
  acting,
  revealed,
  onProcess,
  onReject,
  onReveal,
}: {
  entry: {
    id: string; brand: string | null; region: string | null;
    amount_usd: number | null; amount_ngn: number | null; card_code: string | null;
    created_at: string;
    profiles: { id: string; full_name: string | null; phone: string | null } | null;
  };
  acting: string | null;
  revealed: Set<string>;
  onProcess: (id: string) => void;
  onReject: (id: string) => void;
  onReveal: (id: string) => void;
}) {
  const elapsed = useElapsedMs(entry.created_at);
  const elapsedMin = elapsed / 60_000;
  const remainingMs = Math.max(0, 5 * 60_000 - elapsed);
  const remainMin = Math.floor(remainingMs / 60_000);
  const remainSec = Math.floor((remainingMs % 60_000) / 1_000);
  const isExpired = remainingMs <= 0;
  const isLow = !isExpired && remainingMs < 90_000;

  const urgencyColor = isExpired
    ? "text-red-400"
    : isLow
    ? "text-orange-400"
    : elapsedMin < 2
    ? "text-cyan"
    : "text-gold";

  const urgencyBg = isExpired
    ? "bg-red-500/10 border-red-500/20"
    : isLow
    ? "bg-orange-500/10 border-orange-500/20"
    : elapsedMin < 2
    ? "bg-cyan/10 border-cyan/20"
    : "bg-gold/10 border-gold/20";

  const urgencyLabel = isExpired
    ? "EXPIRED — EXTENDED"
    : isLow
    ? "URGENT"
    : elapsedMin < 2
    ? "FRESH"
    : "ACTIVE";

  const brandEmoji = BRAND_EMOJI_ADMIN[entry.brand ?? ""] ?? "🎁";

  return (
    <div className={`bg-gradient-card rounded-2xl border ${isExpired ? "border-red-500/30" : isLow ? "border-orange-400/30" : "border-white/5"} p-4 space-y-3 transition-all`}>
      {/* Top row */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2.5 flex-1 min-w-0">
          <span className="text-2xl shrink-0">{brandEmoji}</span>
          <div className="min-w-0">
            <p className="font-bold text-sm truncate">
              {entry.brand ?? "Gift Card"}{" "}
              <span className="text-muted-foreground font-normal text-xs">({entry.region ?? "USA"})</span>
            </p>
            <p className="text-xs text-muted-foreground truncate">
              {entry.profiles?.full_name ?? "—"} · {entry.profiles?.phone ?? ""}
            </p>
          </div>
        </div>
        <div className="text-right shrink-0">
          <p className="font-extrabold text-base text-cyan">
            ₦{entry.amount_ngn != null ? Number(entry.amount_ngn).toLocaleString() : "—"}
          </p>
          <p className="text-xs text-muted-foreground">${entry.amount_usd ?? "—"} USD</p>
        </div>
      </div>

      {/* Countdown + urgency badge */}
      <div className={`flex items-center justify-between rounded-xl px-3 py-2.5 border ${urgencyBg}`}>
        <div className="flex items-center gap-2">
          <Timer className={`size-3.5 ${urgencyColor} shrink-0`} />
          <div>
            <p className={`text-xs font-extrabold ${urgencyColor}`}>
              {isExpired
                ? "Window expired — extended window"
                : `${remainMin}:${remainSec < 10 ? `0${remainSec}` : remainSec} remaining`}
            </p>
            <p className="text-[10px] text-muted-foreground">
              User waiting {Math.floor(elapsedMin)}m {Math.floor((elapsedMin % 1) * 60)}s
            </p>
          </div>
        </div>
        <span className={`text-[9px] font-extrabold px-2 py-0.5 rounded-full ${urgencyBg} ${urgencyColor} border`}>
          {urgencyLabel}
        </span>
      </div>

      {/* Card code */}
      <div className="bg-secondary rounded-xl px-4 py-3 flex items-center justify-between">
        <div>
          <p className="text-[10px] text-muted-foreground mb-0.5 font-semibold">CARD CODE</p>
          <p className="font-mono text-xs font-bold tracking-wider">
            {revealed.has(entry.id)
              ? (entry.card_code ?? "—")
              : `${(entry.card_code ?? "").slice(0, 4)}••••••••••`}
          </p>
        </div>
        <button
          onClick={() => onReveal(entry.id)}
          className="text-xs text-cyan font-semibold"
        >
          {revealed.has(entry.id) ? "Hide" : "Reveal"}
        </button>
      </div>

      {/* Actions */}
      <div className="flex gap-2">
        <button
          onClick={() => onProcess(entry.id)}
          disabled={!!acting}
          className="flex-1 flex items-center justify-center gap-1.5 py-3 rounded-xl bg-cyan/15 text-cyan text-xs font-extrabold disabled:opacity-50 active:scale-95 transition-all"
        >
          {acting === entry.id
            ? <Loader2 className="size-3.5 animate-spin" />
            : <Zap className="size-3.5" />}
          Card Processed
        </button>
        <button
          onClick={() => onReject(entry.id)}
          disabled={!!acting}
          className="flex-1 flex items-center justify-center gap-1.5 py-3 rounded-xl bg-red-500/10 text-red-400 text-xs font-extrabold disabled:opacity-50 active:scale-95 transition-all"
        >
          <Ban className="size-3.5" />
          Reject
        </button>
      </div>
    </div>
  );
}

function EscrowTab({ adminId }: { adminId: string }) {
  type EscrowEntry = {
    id: string; brand: string | null; region: string | null;
    amount_usd: number | null; amount_ngn: number | null; card_code: string | null;
    created_at: string;
    profiles: { id: string; full_name: string | null; phone: string | null } | null;
  };

  const [queue, setQueue] = useState<EscrowEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState<string | null>(null);
  const [rejectModal, setRejectModal] = useState<{ id: string; text: string } | null>(null);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await getEscrowQueue({ data: {} });
      setQueue(rows as EscrowEntry[]);
      setLastRefresh(new Date());
    } catch { setQueue([]); } finally { setLoading(false); }
  }, [adminId]);

  useEffect(() => {
    load();
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, [load]);

  const handleProcess = async (tradeId: string) => {
    setActing(tradeId);
    try {
      await processEscrowTrade({ data: { tradeId } });
      setQueue((q) => (q ?? []).filter((r) => r.id !== tradeId));
    } finally { setActing(null); }
  };

  const handleReject = async () => {
    if (!rejectModal) return;
    setActing(rejectModal.id);
    try {
      await rejectManualTrade({ data: { tradeId: rejectModal.id, reason: rejectModal.text } });
      setQueue((q) => (q ?? []).filter((r) => r.id !== rejectModal.id));
      setRejectModal(null);
    } finally { setActing(null); }
  };

  const handleReveal = (id: string) => {
    setRevealed((s) => {
      const n = new Set(s);
      s.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };

  const urgentCount = (queue ?? []).filter((t) => {
    const ms = Date.now() - new Date(t.created_at).getTime();
    return ms > 4 * 60_000;
  }).length;

  return (
    <div className="px-5 pt-4 pb-10 space-y-3">
      {/* Reject modal */}
      {rejectModal && (
        <div className="fixed inset-0 bg-black/70 flex items-end z-50 p-4">
          <div className="w-full bg-card rounded-3xl p-6 space-y-4">
            <p className="font-bold text-sm">Why is this card rejected?</p>
            <textarea
              className="w-full bg-secondary rounded-xl px-4 py-3 text-sm resize-none h-24 outline-none"
              placeholder="e.g. Invalid code, already redeemed, wrong denomination..."
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
                {acting ? <Loader2 className="size-4 animate-spin mx-auto" /> : "Reject & Notify User"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs text-muted-foreground font-semibold uppercase tracking-widest">
            {loading ? "Refreshing…" : `${queue?.length ?? 0} cards in escrow`}
            {urgentCount > 0 && (
              <span className="ml-2 px-1.5 py-0.5 rounded-full bg-red-500/20 text-red-400 text-[9px] font-extrabold">
                {urgentCount} URGENT
              </span>
            )}
          </p>
          {lastRefresh && (
            <p className="text-[10px] text-muted-foreground/50 mt-0.5">
              Auto-refreshes every 15s · Last: {lastRefresh.toLocaleTimeString()}
            </p>
          )}
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-1.5 text-xs text-cyan font-semibold py-1.5 px-3 rounded-xl bg-cyan/10"
        >
          <RefreshCw className={`size-3 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {/* Info banner */}
      {queue && queue.length > 0 && (
        <div className="flex items-start gap-2.5 bg-gold/8 border border-gold/20 rounded-2xl px-4 py-3">
          <AlertTriangle className="size-4 text-gold shrink-0 mt-0.5" />
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            <span className="text-gold font-bold">Action required:</span> Each user is watching a live countdown. Tap{" "}
            <span className="font-bold text-white">"Card Processed"</span> after you've redeemed the card to instantly credit their wallet and clear their screen.
          </p>
        </div>
      )}

      {/* Empty or list */}
      {!queue && loading ? (
        <CenterLoader />
      ) : !queue || queue.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 gap-4 text-muted-foreground">
          <div className="size-16 rounded-full bg-cyan/10 grid place-items-center">
            <Timer className="size-7 text-cyan opacity-60" />
          </div>
          <div className="text-center">
            <p className="text-sm font-semibold">No cards in escrow</p>
            <p className="text-xs mt-1 text-muted-foreground/60">Cards appear here the moment a user's verification succeeds</p>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {queue.map((entry) => (
            <EscrowCard
              key={entry.id}
              entry={entry}
              acting={acting}
              revealed={revealed}
              onProcess={handleProcess}
              onReject={(id) => setRejectModal({ id, text: "" })}
              onReveal={handleReveal}
            />
          ))}
          <div className="flex items-center justify-center gap-2 py-3 text-[11px] text-muted-foreground">
            <ArrowRight className="size-3" />
            Showing {queue.length} active escrow trade{queue.length !== 1 ? "s" : ""}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Vendors Tab ──────────────────────────────────────────────────────────────
type VendorRow = {
  id: string; business_name: string; contact_name: string | null;
  email: string | null; phone: string | null; telegram_username: string | null;
  status: "pending" | "active" | "suspended"; tier: string;
  total_redeemed: number; last_active_at: string | null;
  vendor_wallets?: Array<{ balance: number; total_funded: number }>;
};

type WithdrawalReq = {
  id: string; amount: number; bank_name: string; bank_code: string;
  account_number: string; account_name: string; status: string;
  admin_note: string | null; squadco_ref: string | null;
  created_at: string; processed_at: string | null;
  vendors: { id: string; business_name: string; contact_name: string | null; telegram_username: string | null } | null;
};

function VendorsTab({ adminId }: { adminId: string }) {
  const [vendors, setVendors] = useState<VendorRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState<string | null>(null);
  const [assignModal, setAssignModal] = useState<{ vendorId: string; vendorName: string } | null>(null);
  const [assignForm, setAssignForm] = useState({ brand: "Apple", amountUsd: "", amountNgn: "", cardCode: "", cardPin: "", tradeId: "", notifyTelegram: true });
  const [assigning, setAssigning] = useState(false);
  const [filterStatus, setFilterStatus] = useState<"all" | "pending" | "active" | "suspended">("all");
  const [vendorSubTab, setVendorSubTab] = useState<"vendors" | "withdrawals" | "leaderboard" | "rates">("vendors");

  // ── Add Vendor modal ──────────────────────────────────────────────────────
  const [addVendorOpen, setAddVendorOpen] = useState(false);
  const [addVendorForm, setAddVendorForm] = useState({
    email: "", password: "", businessName: "", contactName: "", phone: "",
    referralCode: "", securityDepositRequired: "",
  });
  const [addVendorLoading, setAddVendorLoading] = useState(false);
  const [addVendorError, setAddVendorError] = useState("");
  const [addVendorSuccess, setAddVendorSuccess] = useState("");

  const handleAddVendor = async () => {
    const { email, password, businessName, contactName, phone } = addVendorForm;
    if (!email || !password || !businessName || !contactName || !phone)
      return setAddVendorError("Email, password, business name, contact name and phone are required");
    if (password.length < 8)
      return setAddVendorError("Password must be at least 8 characters");
    setAddVendorLoading(true); setAddVendorError(""); setAddVendorSuccess("");
    try {
      const res = await adminRegisterVendor({
        data: {
          email,
          password,
          businessName,
          contactName,
          phone,
          referralCode: addVendorForm.referralCode.trim() || undefined,
          securityDepositRequired: addVendorForm.securityDepositRequired
            ? Number(addVendorForm.securityDepositRequired)
            : undefined,
        },
      }) as { success: boolean; error?: string };
      if (!res.success) return setAddVendorError(res.error ?? "Failed to create vendor");
      setAddVendorSuccess(`Vendor account created for ${email}. Status: pending (activate below).`);
      setAddVendorForm({ email: "", password: "", businessName: "", contactName: "", phone: "", referralCode: "", securityDepositRequired: "" });
      await load();
    } catch (e) { setAddVendorError(e instanceof Error ? e.message : "Failed to create vendor"); }
    finally { setAddVendorLoading(false); }
  };
  const [withdrawals, setWithdrawals] = useState<WithdrawalReq[]>([]);
  const [loadingWithdrawals, setLoadingWithdrawals] = useState(false);
  const [actingWithdrawal, setActingWithdrawal] = useState<string | null>(null);
  const [rejectModal, setRejectModal] = useState<{ id: string; name: string } | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  type LeaderRow = { rank: number; id: string; businessName: string; contactName: string | null; telegramUsername: string | null; tier: string; totalRedeemed: number; lastActiveAt: string | null; totalFunded: number; balance: number };
  const [leaderboard, setLeaderboard] = useState<LeaderRow[]>([]);
  const [loadingLeaderboard, setLoadingLeaderboard] = useState(false);
  const [promoting, setPromoting] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await adminGetVendors({ data: {} });
      setVendors(rows as VendorRow[]);
    } catch { setVendors([]); } finally { setLoading(false); }
  }, [adminId]);

  const loadWithdrawals = useCallback(async () => {
    setLoadingWithdrawals(true);
    try {
      const rows = await adminGetWithdrawalRequests({ data: { status: "pending" } });
      setWithdrawals(rows as WithdrawalReq[]);
    } catch { setWithdrawals([]); } finally { setLoadingWithdrawals(false); }
  }, [adminId]);

  const handlePayWithdrawal = async (id: string) => {
    setActingWithdrawal(id);
    try {
      await adminApproveWithdrawal({ data: { requestId: id } });
      await loadWithdrawals();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Payout failed");
    } finally { setActingWithdrawal(null); }
  };

  const handleRejectWithdrawal = async () => {
    if (!rejectModal) return;
    setActingWithdrawal(rejectModal.id);
    try {
      await adminRejectWithdrawal({ data: { requestId: rejectModal.id, reason: rejectReason } });
      setRejectModal(null); setRejectReason("");
      await loadWithdrawals();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Rejection failed");
    } finally { setActingWithdrawal(null); }
  };

  const handlePromote = async (vendorId: string, toTier: "standard" | "premium") => {
    setPromoting(vendorId);
    try {
      const res = await adminPromoteVendorTier({ data: { vendorId, tier: toTier } }) as { ok: boolean };
      if (res.ok) {
        setVendors(prev => prev.map(v => v.id === vendorId ? { ...v, tier: toTier } : v));
        setLeaderboard(prev => prev.map(v => v.id === vendorId ? { ...v, tier: toTier } : v));
      }
    } catch (e) { toast.error(e instanceof Error ? e.message : "Promotion failed"); }
    finally { setPromoting(null); }
  };

  const loadLeaderboard = useCallback(async () => {
    setLoadingLeaderboard(true);
    try {
      const rows = await adminGetVendorLeaderboard({ data: {} });
      setLeaderboard(rows as LeaderRow[]);
    } catch { setLeaderboard([]); } finally { setLoadingLeaderboard(false); }
  }, [adminId]);

  if (!vendors.length && !loading) load();
  if (vendorSubTab === "withdrawals" && !withdrawals.length && !loadingWithdrawals) loadWithdrawals();
  if (vendorSubTab === "leaderboard" && !leaderboard.length && !loadingLeaderboard) loadLeaderboard();
  if (loading) return <CenterLoader />;

  const filtered = vendors.filter(v => filterStatus === "all" || v.status === filterStatus);

  const handleStatusChange = async (vendorId: string, status: "active" | "pending" | "suspended") => {
    setActing(vendorId);
    try {
      await adminUpdateVendorStatus({ data: { vendorId, status } });
      setVendors(prev => prev.map(v => v.id === vendorId ? { ...v, status } : v));
    } finally { setActing(null); }
  };

  const handleAssign = async () => {
    if (!assignModal || !assignForm.cardCode || !assignForm.amountUsd) return;
    setAssigning(true);
    try {
      const result = await adminAssignCard({
        data: {
          vendorId: assignModal.vendorId,
          tradeId: assignForm.tradeId || undefined,
          brand: assignForm.brand,
          amountUsd: parseFloat(assignForm.amountUsd),
          amountNgn: parseFloat(assignForm.amountNgn) || 0,
          cardCode: assignForm.cardCode,
          cardPin: assignForm.cardPin || undefined,
          notifyTelegram: assignForm.notifyTelegram,
        },
      }) as { success: boolean; assignmentId?: string; telegramResult?: { ok: boolean; error?: string } };

      if (result.success) {
        const tlg = result.telegramResult;
        const msg = tlg?.ok ? " ✅ Telegram sent!" : tlg?.error ? ` ⚠️ Telegram: ${tlg.error}` : "";
        toast.success(`Card assigned successfully!${msg}`);
        setAssignModal(null);
        setAssignForm({ brand: "Apple", amountUsd: "", amountNgn: "", cardCode: "", cardPin: "", tradeId: "", notifyTelegram: true });
      }
    } catch (e) { toast.error(e instanceof Error ? e.message : "Assignment failed"); }
    finally { setAssigning(false); }
  };

  const handleSendTelegram = async (assignmentId: string) => {
    setActing(assignmentId);
    try {
      const res = await adminSendTelegramNotification({ data: { assignmentId } }) as { ok: boolean; error?: string };
      res.ok ? toast.success("Telegram notification sent!") : toast.error(res.error ?? "Telegram failed");
    } finally { setActing(null); }
  };

  const fmtNgn = (n: number) => "₦" + n.toLocaleString();
  const timeAgoLocal = (iso: string) => {
    const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (m < 1) return "just now"; if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  };

  const BRANDS = ["Apple", "Amazon", "Steam", "Google Play", "Xbox", "PlayStation", "Netflix", "Spotify"];

  return (
    <>
      {/* Sub-tab toggle */}
      <div className="flex gap-1 p-1 bg-secondary rounded-2xl mx-4 mt-4 mb-2">
        <button onClick={() => setVendorSubTab("rates")} className={`flex-1 text-xs font-bold py-2 rounded-xl transition-colors ${vendorSubTab === "rates" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}>
          Rates
        </button>
        <button onClick={() => setVendorSubTab("vendors")} className={`flex-1 text-xs font-bold py-2 rounded-xl transition-colors ${vendorSubTab === "vendors" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}>
          Vendors ({vendors.length})
        </button>
        <button onClick={() => { setVendorSubTab("withdrawals"); if (!withdrawals.length) loadWithdrawals(); }} className={`flex-1 text-xs font-bold py-2 rounded-xl transition-colors ${vendorSubTab === "withdrawals" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}>
          Withdrawals {withdrawals.filter(w => w.status === "pending").length > 0 ? `(${withdrawals.filter(w => w.status === "pending").length})` : ""}
        </button>
        <button onClick={() => { setVendorSubTab("leaderboard"); if (!leaderboard.length) loadLeaderboard(); }} className={`flex-1 text-xs font-bold py-2 rounded-xl transition-colors ${vendorSubTab === "leaderboard" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}>
          🏆 Leaders
        </button>
      </div>

      {vendorSubTab === "rates" && (
        <div className="px-4 pb-6 pt-2">
          <VendorRatePanel />
        </div>
      )}
      {vendorSubTab === "withdrawals" && (
        <div className="p-4 space-y-3">
          {loadingWithdrawals && <CenterLoader />}
          {!loadingWithdrawals && withdrawals.length === 0 && (
            <EmptyState icon={Wallet} message="No pending withdrawal requests" />
          )}
          {withdrawals.map(wd => (
            <div key={wd.id} className="bg-card border border-border/60 rounded-2xl p-4 space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-extrabold">{wd.vendors?.business_name ?? "Unknown Vendor"}</p>
                  <p className="text-xs text-muted-foreground">{wd.vendors?.contact_name}</p>
                </div>
                <p className="text-lg font-extrabold text-gold shrink-0">{new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN", minimumFractionDigits: 0 }).format(wd.amount)}</p>
              </div>
              <div className="bg-secondary rounded-xl p-3 space-y-1">
                <p className="text-xs font-semibold">{wd.bank_name} · {wd.account_number}</p>
                <p className="text-xs text-muted-foreground">{wd.account_name}</p>
              </div>
              <p className="text-[10px] text-muted-foreground">Requested {new Date(wd.created_at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}</p>
              <div className="flex gap-2">
                <button onClick={() => handlePayWithdrawal(wd.id)} disabled={actingWithdrawal === wd.id}
                  className="flex-1 flex items-center justify-center gap-1.5 bg-green-500/15 border border-green-500/25 text-green-400 text-xs font-bold rounded-xl py-2.5 disabled:opacity-50">
                  {actingWithdrawal === wd.id ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3.5" />}
                  Pay Now via Squadco
                </button>
                <button onClick={() => { setRejectModal({ id: wd.id, name: wd.vendors?.business_name ?? "Vendor" }); setRejectReason(""); }}
                  disabled={actingWithdrawal === wd.id}
                  className="px-3 flex items-center justify-center bg-red-500/10 border border-red-500/20 text-red-400 text-xs font-bold rounded-xl py-2.5 disabled:opacity-50">
                  <X className="size-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {vendorSubTab === "leaderboard" && (
        <div className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-bold text-muted-foreground uppercase tracking-widest">Top Vendors by Redemptions</p>
            <button onClick={loadLeaderboard} className="text-muted-foreground"><RefreshCw className="size-3.5" /></button>
          </div>
          {loadingLeaderboard && <CenterLoader />}
          {!loadingLeaderboard && leaderboard.length === 0 && (
            <EmptyState icon={TrendingUp} message="No active vendors yet" />
          )}
          {leaderboard.map((v, idx) => {
            const medal = idx === 0 ? "🥇" : idx === 1 ? "🥈" : idx === 2 ? "🥉" : null;
            const isTop3 = idx < 3;
            return (
              <div key={v.id} className={`flex items-center gap-3 rounded-2xl p-4 border ${
                idx === 0 ? "bg-gold/10 border-gold/30" :
                idx === 1 ? "bg-white/5 border-white/10" :
                idx === 2 ? "bg-amber-700/10 border-amber-700/20" :
                "bg-card border-border/60"
              }`}>
                {/* Rank */}
                <div className={`w-8 text-center shrink-0 ${isTop3 ? "text-xl" : "text-xs font-extrabold text-muted-foreground"}`}>
                  {medal ?? `#${v.rank}`}
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <p className="text-sm font-extrabold truncate">{v.businessName}</p>
                    {v.tier === "premium" && <Star className="size-3 text-gold shrink-0" />}
                  </div>
                  <p className="text-xs text-muted-foreground truncate">{v.contactName ?? "—"}</p>
                  {v.telegramUsername && (
                    <p className="text-[10px] text-blue-400 flex items-center gap-1 mt-0.5">
                      <MessageCircle className="size-2.5" /> @{v.telegramUsername}
                    </p>
                  )}
                </div>

                {/* Stats + promote */}
                <div className="text-right shrink-0 space-y-1.5">
                  <p className={`text-sm font-extrabold ${isTop3 ? "text-gold" : ""}`}>{v.totalRedeemed}</p>
                  <p className="text-[10px] text-muted-foreground">redeemed</p>
                  <p className="text-xs font-semibold">{"₦" + (v.totalFunded / 1000).toFixed(0) + "k"}</p>
                  <p className="text-[10px] text-muted-foreground">volume</p>
                  {v.tier !== "premium" ? (
                    <button
                      onClick={() => handlePromote(v.id, "premium")}
                      disabled={promoting === v.id}
                      className="flex items-center gap-1 px-2 py-1 text-[10px] font-bold rounded-lg bg-gold/20 border border-gold/30 text-gold disabled:opacity-50"
                    >
                      {promoting === v.id ? <Loader2 className="size-2.5 animate-spin" /> : <Star className="size-2.5" />}
                      Promote
                    </button>
                  ) : (
                    <span className="flex items-center gap-1 px-2 py-1 text-[10px] font-bold rounded-lg bg-gold/10 text-gold/60">
                      <Star className="size-2.5" /> Premium
                    </span>
                  )}
                </div>
              </div>
            );
          })}

          {/* Summary stats */}
          {leaderboard.length > 0 && (
            <div className="grid grid-cols-3 gap-2 pt-2">
              <div className="bg-card border border-border/60 rounded-xl p-3 text-center">
                <p className="text-sm font-extrabold text-gold">{leaderboard.reduce((s, v) => s + v.totalRedeemed, 0)}</p>
                <p className="text-[10px] text-muted-foreground">Total Redeemed</p>
              </div>
              <div className="bg-card border border-border/60 rounded-xl p-3 text-center">
                <p className="text-sm font-extrabold">{"₦" + (leaderboard.reduce((s, v) => s + v.totalFunded, 0) / 1000000).toFixed(1) + "M"}</p>
                <p className="text-[10px] text-muted-foreground">Total Volume</p>
              </div>
              <div className="bg-card border border-border/60 rounded-xl p-3 text-center">
                <p className="text-sm font-extrabold">{leaderboard.length}</p>
                <p className="text-[10px] text-muted-foreground">Active Vendors</p>
              </div>
            </div>
          )}
        </div>
      )}

      {vendorSubTab === "vendors" && (
      <div className="px-5 pt-4 pb-10 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-extrabold">Vendor Network</p>
          <p className="text-xs text-muted-foreground">{vendors.length} vendors registered</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => { setAddVendorOpen(true); setAddVendorError(""); setAddVendorSuccess(""); }}
            className="flex items-center gap-1.5 bg-gold text-jungle-deep text-xs font-extrabold px-3 py-1.5 rounded-xl"
          >
            <Plus className="size-3.5" /> Add Vendor
          </button>
          <button onClick={load} className="text-muted-foreground"><RefreshCw className="size-4" /></button>
        </div>
      </div>

      {/* Add Vendor modal */}
      {addVendorOpen && (
        <div className="bg-card border border-gold/25 rounded-2xl p-5 space-y-3">
          <div className="flex items-center justify-between mb-1">
            <p className="text-sm font-extrabold text-gold">Create vendor account</p>
            <button onClick={() => setAddVendorOpen(false)} className="text-muted-foreground text-xs">✕ Close</button>
          </div>
          {(["businessName", "contactName", "phone", "email"] as const).map(field => (
            <div key={field}>
              <label className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1 block">
                {field === "businessName" ? "Business name" : field === "contactName" ? "Contact name" : field === "phone" ? "Phone" : "Email"}
              </label>
              <input
                type={field === "email" ? "email" : "text"}
                value={addVendorForm[field]}
                onChange={e => setAddVendorForm(f => ({ ...f, [field]: e.target.value }))}
                placeholder={field === "phone" ? "+234..." : ""}
                className="w-full bg-secondary border border-border/60 rounded-xl px-4 py-2.5 text-sm outline-none focus:border-gold/40"
              />
            </div>
          ))}
          <div>
            <label className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1 block">Password (min 8 chars)</label>
            <input
              type="password"
              value={addVendorForm.password}
              onChange={e => setAddVendorForm(f => ({ ...f, password: e.target.value }))}
              placeholder="Set a strong password"
              className="w-full bg-secondary border border-border/60 rounded-xl px-4 py-2.5 text-sm outline-none focus:border-gold/40"
            />
          </div>
          <div>
            <label className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1 block">Security deposit required (₦, optional)</label>
            <input
              type="number"
              value={addVendorForm.securityDepositRequired}
              onChange={e => setAddVendorForm(f => ({ ...f, securityDepositRequired: e.target.value }))}
              placeholder="e.g. 50000"
              className="w-full bg-secondary border border-border/60 rounded-xl px-4 py-2.5 text-sm outline-none focus:border-gold/40"
            />
          </div>
          {addVendorError && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-3 py-2.5 text-xs text-red-400">{addVendorError}</div>
          )}
          {addVendorSuccess && (
            <div className="bg-green-500/10 border border-green-500/20 rounded-xl px-3 py-2.5 text-xs text-green-400">{addVendorSuccess}</div>
          )}
          <button
            onClick={handleAddVendor}
            disabled={addVendorLoading}
            className="w-full bg-gold text-jungle-deep font-extrabold rounded-xl py-3 text-sm flex items-center justify-center gap-2 disabled:opacity-50"
          >
            {addVendorLoading ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
            {addVendorLoading ? "Creating…" : "Create vendor account"}
          </button>
          <p className="text-[10px] text-muted-foreground text-center">Account starts as <span className="text-gold font-semibold">pending</span> — activate it below after reviewing.</p>
        </div>
      )}

      {/* Stats summary */}
      <div className="grid grid-cols-3 gap-2">
        {(["pending","active","suspended"] as const).map(s => (
          <div key={s} className="bg-card border border-border/60 rounded-xl p-3 text-center">
            <p className="text-lg font-extrabold">{vendors.filter(v => v.status === s).length}</p>
            <p className="text-[10px] text-muted-foreground capitalize">{s}</p>
          </div>
        ))}
      </div>

      {/* Filter */}
      <div className="flex gap-2">
        {(["all","pending","active","suspended"] as const).map(f => (
          <button key={f} onClick={() => setFilterStatus(f)}
            className={`px-3 py-1.5 rounded-full text-xs font-bold capitalize transition-colors ${filterStatus === f ? "bg-cyan text-jungle-deep" : "bg-secondary text-muted-foreground"}`}>
            {f}
          </button>
        ))}
      </div>

      {/* Vendor list */}
      {filtered.length === 0 ? (
        <EmptyState icon={Building2} message="No vendors in this category" />
      ) : (
        <div className="space-y-3">
          {filtered.map(v => {
            const walletBalance = v.vendor_wallets?.[0]?.balance ?? 0;
            return (
              <div key={v.id} className="bg-gradient-card border border-white/5 rounded-2xl p-4 space-y-3">
                {/* Vendor header */}
                <div className="flex items-start gap-3">
                  <div className="size-10 rounded-xl bg-secondary grid place-items-center shrink-0">
                    <Building2 className="size-5 text-muted-foreground" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-extrabold truncate">{v.business_name}</p>
                      {v.tier === "premium" && <Star className="size-3 text-gold shrink-0" />}
                    </div>
                    <p className="text-xs text-muted-foreground">{v.contact_name ?? v.email ?? "—"}</p>
                    {v.telegram_username && (
                      <p className="text-[10px] text-blue-400 flex items-center gap-1 mt-0.5">
                        <MessageCircle className="size-2.5" /> @{v.telegram_username}
                      </p>
                    )}
                  </div>
                  <span className={`text-[10px] font-bold px-2 py-1 rounded-full border capitalize shrink-0 ${
                    v.status === "active" ? "text-green-400 bg-green-400/10 border-green-400/20"
                    : v.status === "pending" ? "text-gold bg-gold/10 border-gold/20"
                    : "text-red-400 bg-red-400/10 border-red-400/20"
                  }`}>{v.status}</span>
                </div>

                {/* Stats row */}
                <div className="flex gap-3 text-center">
                  <div className="flex-1 bg-secondary/60 rounded-xl py-2">
                    <p className="text-xs font-extrabold text-gold">{fmtNgn(walletBalance)}</p>
                    <p className="text-[9px] text-muted-foreground">Balance</p>
                  </div>
                  <div className="flex-1 bg-secondary/60 rounded-xl py-2">
                    <p className="text-xs font-extrabold">{v.total_redeemed}</p>
                    <p className="text-[9px] text-muted-foreground">Redeemed</p>
                  </div>
                  <div className="flex-1 bg-secondary/60 rounded-xl py-2">
                    <p className="text-xs font-extrabold text-muted-foreground">{v.last_active_at ? timeAgoLocal(v.last_active_at) : "Never"}</p>
                    <p className="text-[9px] text-muted-foreground">Last Active</p>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex gap-2 flex-wrap">
                  <button
                    onClick={() => setAssignModal({ vendorId: v.id, vendorName: v.business_name })}
                    className="flex-1 flex items-center justify-center gap-1.5 bg-gold/15 border border-gold/20 text-gold text-xs font-bold rounded-xl py-2.5"
                  >
                    <Gift className="size-3.5" /> Assign Card
                  </button>

                  {v.tier !== "premium" && v.status === "active" && (
                    <button
                      onClick={() => handlePromote(v.id, "premium")}
                      disabled={promoting === v.id}
                      className="flex items-center justify-center gap-1 px-3 bg-gold/10 border border-gold/20 text-gold text-xs font-bold rounded-xl py-2.5 disabled:opacity-50"
                    >
                      {promoting === v.id ? <Loader2 className="size-3 animate-spin" /> : <Star className="size-3" />}
                    </button>
                  )}
                  {v.tier === "premium" && v.status === "active" && (
                    <button
                      onClick={() => handlePromote(v.id, "standard")}
                      disabled={promoting === v.id}
                      title="Demote to standard"
                      className="flex items-center justify-center gap-1 px-3 bg-secondary border border-border/60 text-muted-foreground text-xs font-bold rounded-xl py-2.5 disabled:opacity-50"
                    >
                      {promoting === v.id ? <Loader2 className="size-3 animate-spin" /> : <Star className="size-3 text-gold/40" />}
                    </button>
                  )}

                  {v.status === "pending" && (
                    <button
                      onClick={() => handleStatusChange(v.id, "active")}
                      disabled={acting === v.id}
                      className="flex-1 flex items-center justify-center gap-1.5 bg-green-500/15 border border-green-500/25 text-green-400 text-xs font-bold rounded-xl py-2.5 disabled:opacity-50"
                    >
                      {acting === v.id ? <Loader2 className="size-3 animate-spin" /> : <UserCheck className="size-3.5" />}
                      Activate
                    </button>
                  )}
                  {v.status === "active" && (
                    <button
                      onClick={() => handleStatusChange(v.id, "suspended")}
                      disabled={acting === v.id}
                      className="px-3 flex items-center justify-center bg-red-500/10 border border-red-500/20 text-red-400 text-xs font-bold rounded-xl py-2.5 disabled:opacity-50"
                    >
                      {acting === v.id ? <Loader2 className="size-3 animate-spin" /> : <UserX className="size-3.5" />}
                    </button>
                  )}
                  {v.status === "suspended" && (
                    <button
                      onClick={() => handleStatusChange(v.id, "active")}
                      disabled={acting === v.id}
                      className="px-3 flex items-center justify-center bg-green-500/10 border border-green-500/20 text-green-400 text-xs font-bold rounded-xl py-2.5 disabled:opacity-50"
                    >
                      {acting === v.id ? <Loader2 className="size-3 animate-spin" /> : <UserCheck className="size-3.5" />}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Assign Card Modal */}
      {assignModal && (
        <div className="fixed inset-0 bg-black/80 flex items-end sm:items-center justify-center z-50 px-4 pb-6">
          <div className="bg-card border border-border/60 rounded-3xl p-6 w-full max-w-sm space-y-4">
            <div className="flex items-center gap-2">
              <Gift className="size-5 text-gold" />
              <h3 className="text-base font-extrabold">Assign Card to {assignModal.vendorName}</h3>
            </div>

            <div className="space-y-3">
              <div>
                <label className="text-xs font-bold text-muted-foreground mb-1 block">Brand</label>
                <select value={assignForm.brand} onChange={e => setAssignForm(f => ({ ...f, brand: e.target.value }))}
                  className="w-full bg-secondary border border-border/60 rounded-xl px-3 py-2.5 text-sm outline-none">
                  {BRANDS.map(b => <option key={b}>{b}</option>)}
                </select>
              </div>
              <div className="flex gap-2">
                <div className="flex-1">
                  <label className="text-xs font-bold text-muted-foreground mb-1 block">Amount USD</label>
                  <input type="number" value={assignForm.amountUsd} onChange={e => setAssignForm(f => ({ ...f, amountUsd: e.target.value }))}
                    placeholder="e.g. 50" className="w-full bg-secondary border border-border/60 rounded-xl px-3 py-2.5 text-sm outline-none" />
                </div>
                <div className="flex-1">
                  <label className="text-xs font-bold text-muted-foreground mb-1 block">NGN Credit</label>
                  <input type="number" value={assignForm.amountNgn} onChange={e => setAssignForm(f => ({ ...f, amountNgn: e.target.value }))}
                    placeholder="₦ credit" className="w-full bg-secondary border border-border/60 rounded-xl px-3 py-2.5 text-sm outline-none" />
                </div>
              </div>
              <div>
                <label className="text-xs font-bold text-muted-foreground mb-1 block">Card Code</label>
                <input value={assignForm.cardCode} onChange={e => setAssignForm(f => ({ ...f, cardCode: e.target.value }))}
                  placeholder="XXXX-XXXX-XXXX-XXXX" className="w-full bg-secondary border border-border/60 rounded-xl px-3 py-2.5 text-sm font-mono outline-none" />
              </div>
              <div className="flex gap-2">
                <div className="flex-1">
                  <label className="text-xs font-bold text-muted-foreground mb-1 block">PIN (optional)</label>
                  <input value={assignForm.cardPin} onChange={e => setAssignForm(f => ({ ...f, cardPin: e.target.value }))}
                    placeholder="PIN" className="w-full bg-secondary border border-border/60 rounded-xl px-3 py-2.5 text-sm font-mono outline-none" />
                </div>
                <div className="flex-1">
                  <label className="text-xs font-bold text-muted-foreground mb-1 block">Trade ID (optional)</label>
                  <input value={assignForm.tradeId} onChange={e => setAssignForm(f => ({ ...f, tradeId: e.target.value }))}
                    placeholder="UUID" className="w-full bg-secondary border border-border/60 rounded-xl px-3 py-2.5 text-sm outline-none" />
                </div>
              </div>
              <label className="flex items-center gap-3 bg-secondary/50 rounded-xl px-3 py-2.5 cursor-pointer">
                <input type="checkbox" checked={assignForm.notifyTelegram} onChange={e => setAssignForm(f => ({ ...f, notifyTelegram: e.target.checked }))} className="size-4 accent-gold" />
                <div>
                  <p className="text-xs font-bold">Send Telegram notification</p>
                  <p className="text-[10px] text-muted-foreground">Card code delivered directly to vendor's Telegram</p>
                </div>
              </label>
            </div>

            <div className="flex gap-2">
              <button onClick={() => setAssignModal(null)} className="flex-1 py-3 rounded-xl bg-secondary text-sm font-bold">Cancel</button>
              <button onClick={handleAssign} disabled={assigning || !assignForm.cardCode || !assignForm.amountUsd}
                className="flex-1 flex items-center justify-center gap-1.5 py-3 rounded-xl bg-gold text-jungle-deep text-sm font-extrabold disabled:opacity-50">
                {assigning ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                {assigning ? "Assigning…" : "Assign"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
      )}

      {/* Reject withdrawal modal */}
      {rejectModal && (
        <div className="fixed inset-0 bg-black/80 flex items-end sm:items-center justify-center z-50 px-4 pb-6">
          <div className="bg-card border border-border/60 rounded-3xl p-6 w-full max-w-sm space-y-4">
            <div className="flex items-center gap-2">
              <X className="size-5 text-red-400" />
              <h3 className="text-base font-extrabold">Reject Withdrawal</h3>
            </div>
            <p className="text-sm text-muted-foreground">Reject <span className="font-bold">{rejectModal.name}</span>'s withdrawal? Funds return to their wallet immediately.</p>
            <div>
              <label className="text-xs font-bold text-muted-foreground mb-1 block">Reason (optional)</label>
              <input value={rejectReason} onChange={e => setRejectReason(e.target.value)}
                placeholder="e.g. Incorrect bank details"
                className="w-full bg-secondary border border-border/60 rounded-xl px-3 py-2.5 text-sm outline-none" />
            </div>
            <div className="flex gap-2">
              <button onClick={() => setRejectModal(null)} className="flex-1 py-3 rounded-xl bg-secondary text-sm font-bold">Cancel</button>
              <button onClick={handleRejectWithdrawal} disabled={!!actingWithdrawal}
                className="flex-1 flex items-center justify-center gap-1.5 py-3 rounded-xl bg-red-500/20 border border-red-500/30 text-red-400 text-sm font-extrabold disabled:opacity-50">
                {actingWithdrawal ? <Loader2 className="size-4 animate-spin" /> : <X className="size-4" />}
                Reject & Refund
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ─── System Health Tab ────────────────────────────────────────────────────────
type HealthPayload = {
  ok: boolean;
  ts: number;
  critical: Record<string, boolean>;
  optional: Record<string, boolean>;
};

const SERVICE_LABELS: Record<string, string> = {
  supabase:       "Supabase (DB + Auth)",
  squadco:        "Squad (Payments)",
  reloadly:       "Reloadly (Card Verify)",
  busha:          "Busha (Crypto)",
  onesignal:      "OneSignal (Push)",
  app_secret:     "App Secret (Sessions)",
  cron:           "Cron Secret (Scheduler)",
  telegram:       "Telegram Bot (Vendor)",
  admin_telegram: "Telegram Bot (Admin)",
  resend:         "Resend (Email)",
  dojah:          "Dojah (KYC / BVN)",
};

const SERVICE_DOCS: Record<string, string> = {
  dojah:          "app.dojah.io → Apps → API Keys → add DOJAH_APP_ID + DOJAH_SECRET_KEY to GitHub Secrets",
  resend:         "resend.com/api-keys → add RESEND_API_KEY to GitHub Secrets",
  telegram:       "BotFather → add TELEGRAM_BOT_TOKEN + TELEGRAM_WEBHOOK_SECRET to GitHub Secrets",
  admin_telegram: "BotFather → add ADMIN_TELEGRAM_BOT_TOKEN + ADMIN_TELEGRAM_BOT_USERNAME + ADMIN_TELEGRAM_WEBHOOK_SECRET to GitHub Secrets",
};

function HealthRow({
  label, ok, hint, critical,
}: { label: string; ok: boolean; hint?: string; critical?: boolean }) {
  return (
    <div className="flex items-start gap-3 px-4 py-3 border-b border-white/5 last:border-0">
      {ok
        ? <CheckCircle2 className="size-4 text-green-400 mt-0.5 shrink-0" />
        : <XCircle className={`size-4 mt-0.5 shrink-0 ${critical ? "text-red-400" : "text-yellow-400"}`} />
      }
      <div className="flex-1 min-w-0">
        <p className={`text-sm font-semibold ${ok ? "text-foreground" : critical ? "text-red-300" : "text-yellow-300"}`}>
          {label}
        </p>
        {!ok && hint && (
          <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">{hint}</p>
        )}
      </div>
      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0 ${
        ok
          ? "bg-green-500/10 text-green-400"
          : critical
          ? "bg-red-500/10 text-red-400"
          : "bg-yellow-500/10 text-yellow-400"
      }`}>
        {ok ? "OK" : critical ? "DOWN" : "WARN"}
      </span>
    </div>
  );
}

function SystemHealthTab() {
  const [data, setData]       = useState<HealthPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastFetch, setLastFetch] = useState<number | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetch = useCallback(async () => {
    setLoading(true);
    try {
      const res = await globalThis.fetch("/api/health");
      const json: HealthPayload = await res.json();
      setData(json);
      setLastFetch(Date.now());
    } catch {
      /* network error — keep stale data */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetch();
    intervalRef.current = setInterval(fetch, 60_000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [fetch]);

  const allOk      = data?.ok ?? false;
  const downCount  = data
    ? Object.values({ ...data.critical, ...data.optional }).filter(v => !v).length
    : 0;

  return (
    <div className="px-5 pt-4 pb-10 space-y-5">

      {/* Summary banner */}
      {data && (
        <div className={`rounded-2xl border p-4 flex items-center gap-3 ${
          allOk
            ? "bg-green-500/5 border-green-500/20"
            : "bg-red-500/5 border-red-500/20"
        }`}>
          {allOk
            ? <CheckCircle2 className="size-6 text-green-400 shrink-0" />
            : <AlertTriangle className="size-6 text-red-400 shrink-0" />
          }
          <div>
            <p className={`text-sm font-extrabold ${allOk ? "text-green-300" : "text-red-300"}`}>
              {allOk ? "All systems operational" : `${downCount} service${downCount !== 1 ? "s" : ""} need attention`}
            </p>
            <p className="text-[11px] text-muted-foreground">
              Last checked: {lastFetch ? new Date(lastFetch).toLocaleTimeString() : "—"} · Auto-refreshes every 60s
            </p>
          </div>
        </div>
      )}

      {loading && !data && <CenterLoader />}

      {/* Critical services */}
      {data && (
        <div>
          <p className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider mb-2">
            Critical — must be up
          </p>
          <div className="bg-card border border-border/60 rounded-2xl overflow-hidden">
            {Object.entries(data.critical).map(([key, ok]) => (
              <HealthRow
                key={key}
                label={SERVICE_LABELS[key] ?? key}
                ok={ok}
                hint={SERVICE_DOCS[key]}
                critical
              />
            ))}
          </div>
        </div>
      )}

      {/* Optional services */}
      {data && (
        <div>
          <p className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider mb-2">
            Optional — degrade gracefully when missing
          </p>
          <div className="bg-card border border-border/60 rounded-2xl overflow-hidden">
            {Object.entries(data.optional).map(([key, ok]) => (
              <HealthRow
                key={key}
                label={SERVICE_LABELS[key] ?? key}
                ok={ok}
                hint={SERVICE_DOCS[key]}
                critical={false}
              />
            ))}
          </div>
        </div>
      )}

      {/* Fix instructions for any missing optional */}
      {data && Object.entries(data.optional).some(([, v]) => !v) && (
        <div className="bg-yellow-500/5 border border-yellow-500/20 rounded-2xl p-4 space-y-2">
          <div className="flex items-center gap-2">
            <AlertTriangle className="size-4 text-yellow-400 shrink-0" />
            <p className="text-xs font-bold text-yellow-300">How to fix missing secrets</p>
          </div>
          <ol className="text-[11px] text-muted-foreground space-y-1 list-decimal list-inside leading-relaxed">
            <li>Get the API key from the provider dashboard (see hint below each service)</li>
            <li>Go to <span className="font-bold text-foreground">GitHub → repo → Settings → Secrets → Actions</span></li>
            <li>Add the secret(s) listed in the hint</li>
            <li>Push any commit to <span className="font-bold text-foreground">main</span> — the deploy pipeline uploads them to Cloudflare Workers automatically</li>
          </ol>
        </div>
      )}

      <button
        onClick={fetch}
        disabled={loading}
        className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-secondary text-xs font-semibold text-muted-foreground disabled:opacity-50"
      >
        <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
        {loading ? "Checking…" : "Refresh now"}
      </button>
    </div>
  );
}

// ─── Role Management Tab ──────────────────────────────────────────────────────
const ROLE_LABELS: Record<string, { label: string; color: string; bg: string }> = {
  user:        { label: "User",        color: "text-zinc-400",   bg: "bg-zinc-800/60" },
  support:     { label: "Support",     color: "text-blue-400",   bg: "bg-blue-500/10" },
  vendor:      { label: "Vendor",      color: "text-green-400",  bg: "bg-green-500/10" },
  admin:       { label: "Admin",       color: "text-yellow-400", bg: "bg-yellow-500/10" },
  super_admin: { label: "Super Admin", color: "text-purple-400", bg: "bg-purple-500/10" },
};

type UserRow = {
  id: string;
  full_name: string;
  phone: string | null;
  avatar_url: string | null;
  role: string;
  kyc_status: string;
  premium: boolean;
  created_at: string;
};

function RoleBadge({ role }: { role: string }) {
  const r = ROLE_LABELS[role] ?? { label: role, color: "text-zinc-400", bg: "bg-zinc-800/60" };
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${r.color} ${r.bg}`}>
      {role === "super_admin" && <Crown className="size-2.5" />}
      {role === "admin"       && <Shield className="size-2.5" />}
      {r.label}
    </span>
  );
}

function RolesTab({ adminId }: { adminId: string }) {
  const [users, setUsers]               = useState<UserRow[]>([]);
  const [loading, setLoading]           = useState(true);
  const [search, setSearch]             = useState("");
  const [roleFilter, setRoleFilter]     = useState("all");
  const [page, setPage]                 = useState(1);
  const [total, setTotal]               = useState(0);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [changing, setChanging]         = useState<string | null>(null);
  const [confirm, setConfirm]           = useState<{ userId: string; name: string; newRole: string } | null>(null);

  const LIMIT = 40;

  useEffect(() => {
    checkSuperAdminAccess({ data: {} })
      .then(r => setIsSuperAdmin(r.isSuperAdmin))
      .catch(() => setIsSuperAdmin(false));
  }, [adminId]);

  const loadPage = useCallback(async (p: number, q: string, rf: string) => {
    setLoading(true);
    try {
      const result = await adminListUsers({ data: { search: q, role: rf === "all" ? undefined : rf, page: p } });
      setUsers(result.users as UserRow[]);
      setTotal(result.total);
      setPage(p);
    } catch {
      toast.error("Failed to load users");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadPage(1, search, roleFilter); }, []);

  const handleSearch = useCallback((q: string) => {
    setSearch(q);
    loadPage(1, q, roleFilter);
  }, [roleFilter, loadPage]);

  const handleRoleFilter = useCallback((rf: string) => {
    setRoleFilter(rf);
    loadPage(1, search, rf);
  }, [search, loadPage]);

  const confirmChange = (user: UserRow, newRole: string) => {
    if (user.id === adminId) { toast.error("You cannot change your own role"); return; }
    setConfirm({ userId: user.id, name: user.full_name || user.phone || user.id, newRole });
  };

  const doChange = async () => {
    if (!confirm) return;
    setChanging(confirm.userId);
    setConfirm(null);
    try {
      await adminSetRole({ data: { targetUserId: confirm.userId, newRole: confirm.newRole } });
      toast.success(`Role changed to ${confirm.newRole}`);
      setUsers(prev => prev.map(u => u.id === confirm.userId ? { ...u, role: confirm.newRole } : u));
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to change role");
    } finally {
      setChanging(null);
    }
  };

  const totalPages = Math.ceil(total / LIMIT);

  return (
    <div className="p-4 space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-base font-bold flex items-center gap-2">
            <UserCog className="size-4 text-cyan" /> Role Management
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            {isSuperAdmin
              ? "Super admin — you can view and assign roles."
              : "Admin view — contact a super admin to change roles."}
          </p>
        </div>
        <span className="text-xs text-muted-foreground">{total} users</span>
      </div>

      {/* Permission banner for non-super-admins */}
      {!isSuperAdmin && (
        <div className="flex items-center gap-2 rounded-xl bg-yellow-500/10 border border-yellow-500/20 px-3 py-2">
          <Shield className="size-4 text-yellow-400 shrink-0" />
          <p className="text-xs text-yellow-300">
            View only. Only super admins can assign or change roles.
          </p>
        </div>
      )}

      {/* Search + filter */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search by name or phone…"
            defaultValue={search}
            onChange={e => handleSearch(e.target.value)}
            className="w-full pl-8 pr-3 py-2 rounded-xl bg-card border border-white/5 text-sm placeholder:text-muted-foreground focus:outline-none focus:border-cyan/40"
          />
        </div>
        <select
          value={roleFilter}
          onChange={e => handleRoleFilter(e.target.value)}
          className="px-3 py-2 rounded-xl bg-card border border-white/5 text-sm text-foreground focus:outline-none focus:border-cyan/40"
        >
          <option value="all">All roles</option>
          <option value="user">User</option>
          <option value="support">Support</option>
          <option value="vendor">Vendor</option>
          <option value="admin">Admin</option>
          <option value="super_admin">Super Admin</option>
        </select>
      </div>

      {/* User list */}
      {loading ? (
        <CenterLoader />
      ) : users.length === 0 ? (
        <EmptyState icon={Users} message="No users found" />
      ) : (
        <div className="space-y-2">
          {users.map(user => {
            const isMe = user.id === adminId;
            const isChanging = changing === user.id;
            return (
              <div
                key={user.id}
                className="flex items-center gap-3 bg-card rounded-2xl border border-white/5 px-4 py-3"
              >
                {/* Avatar */}
                <div className="size-9 rounded-full bg-gradient-to-br from-cyan/20 to-cyan/5 border border-white/5 grid place-items-center shrink-0">
                  {user.avatar_url
                    ? <img src={user.avatar_url} className="size-9 rounded-full object-cover" alt="" />
                    : <span className="text-xs font-bold text-cyan">
                        {(user.full_name || user.phone || "?").slice(0, 2).toUpperCase()}
                      </span>
                  }
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold truncate">
                      {user.full_name || <span className="text-muted-foreground italic">Unnamed</span>}
                    </p>
                    {isMe && (
                      <span className="text-[10px] text-cyan font-bold">(you)</span>
                    )}
                    {user.premium && (
                      <Star className="size-3 text-yellow-400 fill-yellow-400" />
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground truncate">
                    {user.phone ?? "No phone"} · joined {new Date(user.created_at).toLocaleDateString()}
                  </p>
                </div>

                {/* Role badge + change */}
                <div className="flex items-center gap-2 shrink-0">
                  {isChanging ? (
                    <Loader2 className="size-4 animate-spin text-cyan" />
                  ) : isSuperAdmin && !isMe ? (
                    <select
                      value={user.role}
                      onChange={e => confirmChange(user, e.target.value)}
                      className="text-xs rounded-lg bg-background border border-white/10 px-2 py-1 text-foreground focus:outline-none focus:border-cyan/40"
                    >
                      <option value="user">User</option>
                      <option value="support">Support</option>
                      <option value="vendor">Vendor</option>
                      <option value="admin">Admin</option>
                      <option value="super_admin">Super Admin</option>
                    </select>
                  ) : (
                    <RoleBadge role={user.role} />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between pt-2">
          <button
            onClick={() => loadPage(page - 1, search, roleFilter)}
            disabled={page <= 1}
            className="flex items-center gap-1 text-xs text-muted-foreground disabled:opacity-30"
          >
            <ChevronLeft className="size-3.5" /> Prev
          </button>
          <span className="text-xs text-muted-foreground">
            Page {page} of {totalPages}
          </span>
          <button
            onClick={() => loadPage(page + 1, search, roleFilter)}
            disabled={page >= totalPages}
            className="flex items-center gap-1 text-xs text-muted-foreground disabled:opacity-30"
          >
            Next <ChevronRight className="size-3.5" />
          </button>
        </div>
      )}

      {/* Confirmation modal */}
      {confirm && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="w-full max-w-sm rounded-2xl bg-card border border-white/10 p-5 space-y-4">
            <div>
              <h3 className="text-base font-bold">Confirm Role Change</h3>
              <p className="text-sm text-muted-foreground mt-1">
                Change <strong className="text-foreground">{confirm.name}</strong>'s role to{" "}
                <strong className={ROLE_LABELS[confirm.newRole]?.color ?? "text-foreground"}>
                  {ROLE_LABELS[confirm.newRole]?.label ?? confirm.newRole}
                </strong>?
              </p>
              <p className="text-xs text-muted-foreground mt-2">
                This will be logged to the audit trail and cannot be undone automatically.
              </p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setConfirm(null)}
                className="flex-1 py-2.5 rounded-xl bg-background border border-white/10 text-sm text-muted-foreground"
              >
                Cancel
              </button>
              <button
                onClick={doChange}
                className="flex-1 py-2.5 rounded-xl bg-cyan text-black text-sm font-bold"
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main Admin Screen ────────────────────────────────────────────────────────
export function AdminScreen({ adminId, onBack }: Props) {
  const [tab, setTab] = useState<AdminTab>("stats");

  const TABS: { key: AdminTab; label: string; icon: typeof BarChart3 }[] = [
    { key: "stats",   label: "Stats",   icon: BarChart3 },
    { key: "kyc",     label: "KYC",     icon: ShieldCheck },
    { key: "escrow",  label: "Escrow",  icon: Timer },
    { key: "review",  label: "Review",  icon: Eye },
    { key: "trades",  label: "Trades",  icon: TrendingUp },
    { key: "rates",   label: "Rates",   icon: DollarSign },
    { key: "credit",  label: "Credit",  icon: Wallet },
    { key: "vendors", label: "Vendors", icon: Building2 },
    { key: "audit",   label: "Audit",   icon: Zap },
    { key: "system",   label: "System",  icon: Activity },
    { key: "roles",    label: "Roles",   icon: UserCog },
    { key: "mission",  label: "Mission", icon: BarChart3 },
    { key: "trust",    label: "Trust",   icon: ShieldCheck },
    { key: "treasury", label: "Treasury", icon: TrendingUp },
    { key: "keys",     label: "API Keys", icon: Zap },
    { key: "health",   label: "Health",  icon: Activity },
    { key: "premium",  label: "Premium", icon: Crown },
    { key: "safety",   label: "Safety",  icon: Shield },
    { key: "founder",  label: "Founder", icon: Zap },
  ];

  return (
    <div className="flex flex-col min-h-dvh">
      <header className="px-5 pt-safe-top pb-5 bg-gradient-hero rounded-b-[2rem] shadow-glow-jungle relative overflow-hidden">
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
        {tab === "stats"   && <StatsTab   adminId={adminId} />}
        {tab === "kyc"     && <KYCTab     adminId={adminId} />}
        {tab === "escrow"  && <EscrowTab  adminId={adminId} />}
        {tab === "review"  && <ReviewTab  adminId={adminId} />}
        {tab === "trades"  && <TradesTab  adminId={adminId} />}
        {tab === "rates"   && <RatesTab   adminId={adminId} />}
        {tab === "credit"  && <CreditTab  adminId={adminId} />}
        {tab === "vendors" && <VendorsTab adminId={adminId} />}
        {tab === "audit"   && (
          <div className="p-5">
            <AuditLogViewer />
          </div>
        )}
        {tab === "system"   && <SystemHealthTab />}
        {tab === "roles"    && <RolesTab adminId={adminId} />}
        {tab === "mission"  && <MissionControlTab />}
        {tab === "trust"    && <TrustTab />}
        {tab === "treasury" && <TreasuryTab />}
        {tab === "keys"     && <ApiKeysTab />}
        {tab === "health"   && <ProviderHealthTab />}
        {tab === "premium"  && <PremiumAdminTab />}
        {tab === "safety"   && <KillSwitchPanel />}
        {tab === "founder"  && <FounderDashboard />}
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


/* ─── Revenue tab (spread income) — admin only ─────────────────────────────── */
export function RevenueTab() {
  const [days, setDays] = React.useState(7);
  const { data, isLoading } = useQuery({
    queryKey: ["spread-revenue", days],
    queryFn: async () => {
      const { getSpreadRevenue } = await import("../server-functions/admin");
      return getSpreadRevenue({ data: { days } });
    },
    staleTime: 5 * 60 * 1000,
  });

  const total = data?.totalFee ?? 0;
  const daily = data?.daily ?? [];
  const recent = data?.recentSwaps ?? [];

  return (
    <div className="space-y-4 px-5 py-4">
      <div className="flex gap-2">
        {[7, 30, 90].map(d => (
          <button key={d} onClick={() => setDays(d)}
            className={`px-4 py-1.5 rounded-full text-xs font-bold transition ${days === d ? "bg-gold text-jungle-deep" : "bg-secondary text-muted-foreground"}`}>
            {d}d
          </button>
        ))}
      </div>
      <div className="bg-card rounded-2xl border border-border p-4">
        <p className="text-xs text-muted-foreground">Total spread revenue ({days}d)</p>
        <p className="text-2xl font-extrabold">{isLoading ? "…" : total.toFixed(6)}</p>
      </div>
      <div className="space-y-1">
        {daily.map(({ date, fee }) => (
          <div key={date} className="flex items-center justify-between bg-card rounded-xl px-4 py-2.5 border border-border">
            <span className="text-xs text-muted-foreground">{date}</span>
            <span className="text-xs font-bold">{fee.toFixed(6)}</span>
          </div>
        ))}
      </div>
      {recent.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-bold text-muted-foreground uppercase tracking-wide mb-2">Recent swaps</p>
          {recent.map((s, i) => (
            <div key={i} className="bg-card rounded-xl border border-border px-4 py-2.5 flex items-center justify-between">
              <div>
                <p className="text-xs font-bold">{s.from} → {s.to}</p>
                <p className="text-[10px] text-muted-foreground">{s.fromAmount} {s.from}</p>
              </div>
              <p className="text-xs font-bold text-cyan">+{s.fee.toFixed(6)}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
