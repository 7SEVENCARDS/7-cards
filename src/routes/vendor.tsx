import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect, useCallback, useRef } from "react";
import {
  LayoutDashboard, CreditCard, Wallet2, User, LogOut,
  Eye, EyeOff, CheckCircle2, XCircle, Clock, Loader2,
  Copy, Send, RefreshCw, ArrowRight, Plus, Building2,
  MessageCircle, ShieldCheck, TrendingUp, Gift, ChevronRight,
  AlertTriangle, Lock, Banknote, Star,
} from "lucide-react";
import {
  getVendorSession,
  vendorLogin,
  vendorLogout,
  getMyAssignments,
  markAssignmentRedeemed,
  markAssignmentFailed,
  getVendorWallet,
  updateVendorProfile,
  provisionVirtualAccount,
  getActiveVirtualAccounts,
  requestWithdrawal,
  getMyWithdrawals,
  getMyBadges,
  getMyReferralInfo,
} from "../server-functions/vendors";
import { getMyBroadcastClaims, getActiveBroadcasts, getMyRateHistory } from "../server-functions/vendor-broadcast";
import type { ActiveBroadcastRow, RateHistoryRow } from "../server-functions/vendor-broadcast";

export const Route = createFileRoute("/vendor")({
  component: VendorPortal,
});

type VendorStatus = "pending" | "active" | "suspended";
type VendorSession = {
  id: string; user_id: string; business_name: string; contact_name: string | null;
  phone: string | null; email: string | null; telegram_username: string | null;
  bank_name: string | null; bank_code: string | null; account_number: string | null;
  account_name: string | null; status: VendorStatus; tier: string;
  total_redeemed: number; total_volume_ngn: number;
};
type Assignment = {
  id: string; brand: string; amount_usd: number; amount_ngn: number | null;
  card_code: string; card_pin: string | null; status: string;
  telegram_sent: boolean; claimed_via_telegram: boolean;
  created_at: string; redeemed_at: string | null;
  van_account_number: string | null; van_bank_name: string | null;
  van_amount_ngn: number | null; van_paid: boolean; van_paid_at: string | null;
};
type WalletData = { wallet: { balance: number; total_funded: number } | null; transactions: Array<{ id: string; type: string; amount: number; description: string | null; created_at: string }> };

type VendorTab = "dashboard" | "cards" | "wallet" | "profile";

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmtNgn(n: number) { return "₦" + Number(n).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fmtUsd(n: number) { return "$" + Number(n).toFixed(2); }
function timeAgo(iso: string) {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "just now"; if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
function copyToClipboard(text: string) { navigator.clipboard.writeText(text).catch(() => {}); }

const BRAND_EMOJI: Record<string, string> = {
  Apple: "🍎", Amazon: "📦", Steam: "🎮", "Google Play": "▶️",
  Xbox: "🟢", PlayStation: "🎯", Netflix: "🎬", Spotify: "🎵",
};

// ─── Countdown hook — ticks every second, client-side only ────────────────────
function useBroadcastCountdown(expiresAt: string): number {
  const getRemaining = () =>
    Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
  const [sec, setSec] = useState(getRemaining);
  useEffect(() => {
    const id = setInterval(() => setSec(getRemaining()), 1000);
    return () => clearInterval(id);
  }, [expiresAt]);
  return sec;
}

function fmtCountdown(sec: number): string {
  if (sec <= 0) return "Expired";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, "0")}s left` : `${s}s left`;
}

// ─── Single broadcast countdown card ─────────────────────────────────────────
function BroadcastCountdownBanner({ b }: { b: ActiveBroadcastRow }) {
  const sec = useBroadcastCountdown(b.expires_at);
  const expired = sec <= 0 || b.status !== "pending";
  const urgent  = sec > 0 && sec <= 60;
  const warning = sec > 60 && sec <= 300;

  const borderColor = b.claimed_by_me
    ? "border-green-500/30 bg-green-500/5"
    : expired
    ? "border-border/40 bg-secondary/40"
    : urgent
    ? "border-red-500/40 bg-red-500/5"
    : warning
    ? "border-gold/40 bg-gold/5"
    : "border-cyan/30 bg-cyan/5";

  const countdownColor = b.claimed_by_me
    ? "text-green-400"
    : expired
    ? "text-muted-foreground"
    : urgent
    ? "text-red-400"
    : warning
    ? "text-gold"
    : "text-cyan";

  return (
    <div className={`rounded-2xl border px-4 py-3 flex items-center gap-3 transition-colors ${borderColor} ${urgent && !b.claimed_by_me && !expired ? "animate-pulse" : ""}`}>
      <span className="text-2xl shrink-0">{BRAND_EMOJI[b.brand] ?? "🎁"}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-sm font-extrabold">{b.brand} <span className="text-muted-foreground font-normal">${Number(b.amount_usd).toFixed(0)}</span></p>
          {b.claimed_by_me && (
            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-green-500/20 text-green-400 border border-green-500/25">
              ✓ You claimed it
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">
          {b.claimed_by_me
            ? `₦${Number(b.amount_ngn).toLocaleString("en-NG")} — check your Telegram for the card code`
            : expired
            ? "This offer has closed"
            : "Reply YES in Telegram to claim"}
        </p>
      </div>
      <div className="text-right shrink-0">
        <p className={`text-xs font-extrabold tabular-nums ${countdownColor}`}>
          {b.claimed_by_me ? "🎉 Won" : expired ? "⏰ Closed" : `⏳ ${fmtCountdown(sec)}`}
        </p>
        {!b.claimed_by_me && !expired && (
          <p className="text-[10px] text-muted-foreground mt-0.5">
            ₦{Number(b.amount_ngn).toLocaleString("en-NG")}
          </p>
        )}
      </div>
    </div>
  );
}

// ─── Live broadcast section — polls every 30s ─────────────────────────────────
function LiveBroadcastSection() {
  const [broadcasts, setBroadcasts] = useState<ActiveBroadcastRow[]>([]);
  const [loaded, setLoaded] = useState(false);

  const fetch = useCallback(async () => {
    try {
      const rows = await getActiveBroadcasts({ data: {} }) as ActiveBroadcastRow[];
      setBroadcasts(rows);
    } catch { /* non-fatal */ }
    setLoaded(true);
  }, []);

  useEffect(() => {
    fetch();
    const id = setInterval(fetch, 30_000);
    return () => clearInterval(id);
  }, [fetch]);

  if (!loaded || broadcasts.length === 0) return null;

  return (
    <div>
      <p className="text-xs font-bold text-muted-foreground uppercase tracking-widest mb-2">
        Live Offers
      </p>
      <div className="space-y-2">
        {broadcasts.map(b => <BroadcastCountdownBanner key={b.id} b={b} />)}
      </div>
    </div>
  );
}

const STATUS_COLORS: Record<string, string> = {
  assigned: "text-gold bg-gold/10 border-gold/20",
  viewed:   "text-cyan bg-cyan/10 border-cyan/20",
  redeemed: "text-green-400 bg-green-400/10 border-green-400/20",
  failed:   "text-red-400 bg-red-400/10 border-red-400/20",
  cancelled:"text-muted-foreground bg-secondary border-border",
};

// ─── Auth Screen — Login Only ─────────────────────────────────────────────────
// Vendor self-registration is disabled. Accounts are created by admin only.
function AuthScreen({ onAuth }: { onAuth: (v: VendorSession) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleLogin = async () => {
    if (!email || !password) return setError("Enter email and password");
    setLoading(true); setError("");
    try {
      const res = await vendorLogin({ data: { email, password } }) as { success: boolean; error?: string };
      if (!res.success) return setError(res.error ?? "Login failed");
      const session = await getVendorSession({ data: {} }) as { authenticated: boolean; vendor?: VendorSession };
      if (session.authenticated && session.vendor) onAuth(session.vendor);
      else setError("Session error — please try again");
    } catch (e) { setError(e instanceof Error ? e.message : "Login failed"); }
    finally { setLoading(false); }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="inline-flex size-16 rounded-3xl bg-gradient-to-br from-gold/30 to-gold/10 border border-gold/20 items-center justify-center mb-4">
            <Building2 className="size-8 text-gold" />
          </div>
          <h1 className="text-2xl font-extrabold text-white">7SEVEN Vendor Portal</h1>
          <p className="text-sm text-muted-foreground mt-1">Sign in to your vendor account</p>
        </div>

        <div className="bg-card border border-border/60 rounded-3xl p-6 space-y-4">
          <div>
            <label className="text-xs font-bold text-muted-foreground mb-1.5 block">Email</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@business.com" className="w-full bg-secondary border border-border/60 rounded-xl px-4 py-3 text-sm outline-none focus:border-gold/40" />
          </div>
          <div>
            <label className="text-xs font-bold text-muted-foreground mb-1.5 block">Password</label>
            <div className="relative">
              <input type={showPass ? "text" : "password"} value={password} onChange={e => setPassword(e.target.value)} onKeyDown={e => { if (e.key === "Enter") handleLogin(); }} placeholder="••••••••" className="w-full bg-secondary border border-border/60 rounded-xl px-4 py-3 text-sm outline-none focus:border-gold/40 pr-12" />
              <button onClick={() => setShowPass(!showPass)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                {showPass ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
          </div>

          {error && (
            <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/20 rounded-xl px-3 py-2.5">
              <AlertTriangle className="size-4 text-red-400 shrink-0" />
              <p className="text-xs text-red-400">{error}</p>
            </div>
          )}

          <button
            onClick={handleLogin}
            disabled={loading}
            className="w-full bg-gold text-jungle-deep font-extrabold rounded-xl py-3.5 flex items-center justify-center gap-2 disabled:opacity-50"
          >
            {loading ? <Loader2 className="size-4 animate-spin" /> : <ArrowRight className="size-4" />}
            {loading ? "Signing in…" : "Sign In"}
          </button>

          <p className="text-center text-xs text-muted-foreground">
            No account? Contact <span className="text-gold font-semibold">7SEVEN support</span> to get set up.
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── Status Gate ──────────────────────────────────────────────────────────────
function StatusGate({ status, onLogout }: { status: VendorStatus; onLogout: () => void }) {
  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-4">
      <div className="text-center max-w-sm">
        <div className={`size-20 rounded-full mx-auto mb-6 grid place-items-center ${status === "pending" ? "bg-gold/15 border-2 border-gold/30" : "bg-red-500/15 border-2 border-red-500/30"}`}>
          {status === "pending" ? <Clock className="size-9 text-gold" /> : <XCircle className="size-9 text-red-400" />}
        </div>
        <h2 className="text-xl font-extrabold mb-2">
          {status === "pending" ? "Application Pending" : "Account Suspended"}
        </h2>
        <p className="text-sm text-muted-foreground leading-relaxed mb-6">
          {status === "pending"
            ? "Your vendor application is under review. You'll be notified when your account is activated. This usually takes 1–2 business days."
            : "Your vendor account has been suspended. Please contact support@7evencards.xyz for assistance."}
        </p>
        <button onClick={onLogout} className="text-sm text-muted-foreground underline">Sign out</button>
      </div>
    </div>
  );
}

// ─── Dashboard Tab ────────────────────────────────────────────────────────────
function DashboardTab({ vendor }: { vendor: VendorSession }) {
  const [wallet, setWallet] = useState<WalletData | null>(null);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      getVendorWallet({ data: {} }) as Promise<WalletData>,
      getMyAssignments({ data: { limit: 5 } }) as Promise<Assignment[]>,
    ]).then(([w, a]) => { setWallet(w); setAssignments(a); }).finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="flex-1 flex items-center justify-center"><Loader2 className="size-6 animate-spin text-gold" /></div>;

  const pendingCount = assignments.filter(a => a.status === "assigned" || a.status === "viewed").length;
  const redeemedCount = assignments.filter(a => a.status === "redeemed").length;

  return (
    <div className="p-6 space-y-6">
      {/* Welcome */}
      <div>
        <h2 className="text-xl font-extrabold">Hello, {vendor.contact_name ?? vendor.business_name} 👋</h2>
        <p className="text-sm text-muted-foreground mt-0.5">Here's your vendor overview</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-card border border-border/60 rounded-2xl p-4">
          <Wallet2 className="size-5 text-gold mb-2" />
          <p className="text-xs text-muted-foreground">Wallet Balance</p>
          <p className="text-lg font-extrabold text-gold">{fmtNgn(wallet?.wallet?.balance ?? 0)}</p>
        </div>
        <div className="bg-card border border-border/60 rounded-2xl p-4">
          <Gift className="size-5 text-cyan mb-2" />
          <p className="text-xs text-muted-foreground">Pending Cards</p>
          <p className="text-lg font-extrabold text-cyan">{pendingCount}</p>
        </div>
        <div className="bg-card border border-border/60 rounded-2xl p-4">
          <CheckCircle2 className="size-5 text-green-400 mb-2" />
          <p className="text-xs text-muted-foreground">Redeemed (All Time)</p>
          <p className="text-lg font-extrabold text-green-400">{vendor.total_redeemed}</p>
        </div>
        <div className="bg-card border border-border/60 rounded-2xl p-4">
          <TrendingUp className="size-5 text-purple-400 mb-2" />
          <p className="text-xs text-muted-foreground">Total Volume</p>
          <p className="text-lg font-extrabold text-purple-400">{fmtNgn(vendor.total_volume_ngn)}</p>
        </div>
      </div>

      {/* Tier Badge */}
      <div className={`rounded-2xl p-4 border flex items-center gap-3 ${vendor.tier === "premium" ? "bg-gold/8 border-gold/20" : "bg-secondary border-border/60"}`}>
        <Star className={`size-5 shrink-0 ${vendor.tier === "premium" ? "text-gold" : "text-muted-foreground"}`} />
        <div>
          <p className="text-sm font-bold capitalize">{vendor.tier} Tier</p>
          <p className="text-xs text-muted-foreground">{vendor.tier === "premium" ? "Priority card assignments, higher limits" : "Complete 10+ redemptions to unlock Premium tier"}</p>
        </div>
      </div>

      {/* Live Broadcast Countdown */}
      <LiveBroadcastSection />

      {/* Telegram Setup Reminder */}
      {!vendor.telegram_username && (
        <div className="bg-blue-500/10 border border-blue-500/20 rounded-2xl p-4 flex items-start gap-3">
          <MessageCircle className="size-5 text-blue-400 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-bold text-blue-300">Connect Telegram</p>
            <p className="text-xs text-muted-foreground mt-0.5">Add your Telegram @username to receive card codes directly in Telegram the moment they're assigned.</p>
          </div>
        </div>
      )}

      {/* Recent assignments */}
      {assignments.length > 0 && (
        <div>
          <p className="text-xs font-bold text-muted-foreground uppercase tracking-widest mb-3">Recent Assignments</p>
          <div className="space-y-2">
            {assignments.slice(0, 3).map(a => (
              <div key={a.id} className="bg-card border border-border/60 rounded-xl px-4 py-3 flex items-center gap-3">
                <span className="text-xl">{BRAND_EMOJI[a.brand] ?? "🎁"}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold">{a.brand} {fmtUsd(a.amount_usd)}</p>
                  <p className="text-xs text-muted-foreground">{timeAgo(a.created_at)}</p>
                </div>
                <span className={`text-[10px] font-bold px-2 py-1 rounded-full border capitalize ${STATUS_COLORS[a.status] ?? "text-muted-foreground bg-secondary border-border"}`}>{a.status}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Cards Tab ────────────────────────────────────────────────────────────────
function CardsTab() {
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "assigned" | "redeemed">("all");
  const [revealedIds, setRevealedIds] = useState<Set<string>>(new Set());
  const [acting, setActing] = useState<string | null>(null);
  const [failReason, setFailReason] = useState<{ id: string; text: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await getMyAssignments({ data: { limit: 50 } }) as Assignment[];
      setAssignments(rows);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = assignments.filter(a => {
    if (filter === "assigned") return a.status === "assigned" || a.status === "viewed";
    if (filter === "redeemed") return a.status === "redeemed";
    return true;
  });

  const handleCopy = (text: string, id: string) => {
    copyToClipboard(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  };

  const handleRedeem = async (id: string) => {
    setActing(id);
    try {
      await markAssignmentRedeemed({ data: { assignmentId: id } });
      setAssignments(prev => prev.map(a => a.id === id ? { ...a, status: "redeemed", redeemed_at: new Date().toISOString() } : a));
    } finally { setActing(null); }
  };

  const handleFail = async () => {
    if (!failReason) return;
    setActing(failReason.id);
    try {
      await markAssignmentFailed({ data: { assignmentId: failReason.id, reason: failReason.text } });
      setAssignments(prev => prev.map(a => a.id === failReason.id ? { ...a, status: "failed" } : a));
      setFailReason(null);
    } finally { setActing(null); }
  };

  if (loading) return <div className="flex-1 flex items-center justify-center"><Loader2 className="size-6 animate-spin text-gold" /></div>;

  return (
    <div className="p-6">
      {/* Live broadcast countdown — always visible at top of Cards tab */}
      <LiveBroadcastSection />

      {/* Filter tabs */}
      <div className="flex gap-2 mb-4 mt-2">
        {(["all", "assigned", "redeemed"] as const).map(f => (
          <button key={f} onClick={() => setFilter(f)} className={`px-3 py-1.5 rounded-full text-xs font-bold transition-colors capitalize ${filter === f ? "bg-gold text-jungle-deep" : "bg-secondary text-muted-foreground"}`}>
            {f}
          </button>
        ))}
        <button onClick={load} className="ml-auto text-muted-foreground"><RefreshCw className="size-3.5" /></button>
      </div>

      {filtered.length === 0 ? (
        <div className="text-center py-20">
          <Gift className="size-12 text-muted-foreground/40 mx-auto mb-4" />
          <p className="text-sm text-muted-foreground">No cards in this category</p>
          <p className="text-xs text-muted-foreground mt-1">New cards appear here when admin assigns them to you</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map(a => {
            const isRevealed = revealedIds.has(a.id);
            const canAct = a.status === "assigned" || a.status === "viewed";
            return (
              <div key={a.id} className={`bg-card border rounded-2xl overflow-hidden ${canAct ? "border-gold/30" : "border-border/60"}`}>
                {/* Header */}
                <div className="px-4 py-3 flex items-center gap-3">
                  <span className="text-2xl">{BRAND_EMOJI[a.brand] ?? "🎁"}</span>
                  <div className="flex-1">
                    <p className="text-sm font-bold">{a.brand}</p>
                    <p className="text-xs text-muted-foreground">{fmtUsd(a.amount_usd)} · {a.amount_ngn ? fmtNgn(a.amount_ngn) : "—"}</p>
                  </div>
                  <span className={`text-[10px] font-bold px-2 py-1 rounded-full border capitalize ${STATUS_COLORS[a.status] ?? "text-muted-foreground bg-secondary border-border"}`}>{a.status}</span>
                </div>

                {/* Card code */}
                <div className="px-4 pb-4 space-y-2">
                  <div className="bg-secondary rounded-xl px-3 py-2.5 flex items-center gap-2">
                    <Lock className="size-3.5 text-muted-foreground shrink-0" />
                    <code className={`flex-1 text-sm font-mono ${isRevealed ? "text-gold" : "blur-sm select-none"}`}>
                      {a.card_code}
                    </code>
                    {isRevealed ? (
                      <button onClick={() => handleCopy(a.card_code, a.id + "-code")} className="shrink-0">
                        {copied === a.id + "-code" ? <CheckCircle2 className="size-4 text-green-400" /> : <Copy className="size-4 text-muted-foreground" />}
                      </button>
                    ) : (
                      <button onClick={() => setRevealedIds(s => { const n = new Set(s); n.add(a.id); return n; })} className="shrink-0 text-xs text-cyan font-semibold flex items-center gap-1">
                        <Eye className="size-3.5" /> Reveal
                      </button>
                    )}
                  </div>

                  {a.card_pin && isRevealed && (
                    <div className="bg-secondary rounded-xl px-3 py-2 flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">PIN:</span>
                      <code className="text-sm font-mono text-gold flex-1">{a.card_pin}</code>
                      <button onClick={() => handleCopy(a.card_pin!, a.id + "-pin")}>
                        {copied === a.id + "-pin" ? <CheckCircle2 className="size-4 text-green-400" /> : <Copy className="size-4 text-muted-foreground" />}
                      </button>
                    </div>
                  )}

                  {/* ── VAN Payment Section (Telegram-claimed assignments) ── */}
                  {a.van_account_number && (
                    <div className={`rounded-xl border p-3 space-y-2 mt-1 ${a.van_paid ? "border-green-500/25 bg-green-500/5" : "border-cyan/25 bg-cyan/5"}`}>
                      <div className="flex items-center gap-1.5">
                        <Banknote className={`size-3.5 shrink-0 ${a.van_paid ? "text-green-400" : "text-cyan"}`} />
                        <p className={`text-[11px] font-extrabold ${a.van_paid ? "text-green-400" : "text-cyan"}`}>
                          {a.van_paid ? "Payment Received ✓" : "Pay to Complete Trade"}
                        </p>
                        {!a.van_paid && (
                          <span className="ml-auto text-[9px] text-muted-foreground animate-pulse">Awaiting payment</span>
                        )}
                      </div>
                      {!a.van_paid && (
                        <>
                          <div className="flex items-center justify-between bg-background/60 rounded-lg px-3 py-2">
                            <div>
                              <p className="text-[10px] text-muted-foreground">{a.van_bank_name ?? "Wema Bank"}</p>
                              <p className="text-base font-mono font-extrabold tracking-widest">{a.van_account_number}</p>
                              <p className="text-[10px] text-muted-foreground">7SEVEN CARDS</p>
                            </div>
                            <button
                              onClick={() => handleCopy(a.van_account_number!, a.id + "-van")}
                              className="ml-3 shrink-0"
                            >
                              {copied === a.id + "-van"
                                ? <CheckCircle2 className="size-5 text-green-400" />
                                : <Copy className="size-5 text-muted-foreground" />}
                            </button>
                          </div>
                          <p className="text-[11px] text-muted-foreground">
                            Transfer exactly <span className="text-foreground font-extrabold">{fmtNgn(a.van_amount_ngn ?? a.amount_ngn ?? 0)}</span> to complete. User is credited automatically.
                          </p>
                        </>
                      )}
                      {a.van_paid && a.van_paid_at && (
                        <p className="text-[10px] text-green-400">Settled {timeAgo(a.van_paid_at)}</p>
                      )}
                    </div>
                  )}

                  <p className="text-[10px] text-muted-foreground">
                    {a.claimed_via_telegram ? "📲 Claimed via Telegram · " : ""}Assigned {timeAgo(a.created_at)} · Ref: {a.id.slice(0, 8)}
                  </p>

                  {canAct && (
                    <div className="flex gap-2 pt-1">
                      <button
                        onClick={() => handleRedeem(a.id)}
                        disabled={acting === a.id}
                        className="flex-1 flex items-center justify-center gap-1.5 bg-green-500/15 border border-green-500/25 text-green-400 text-xs font-bold rounded-xl py-2.5 disabled:opacity-50"
                      >
                        {acting === a.id ? <Loader2 className="size-3.5 animate-spin" /> : <CheckCircle2 className="size-3.5" />}
                        Mark Redeemed
                      </button>
                      <button
                        onClick={() => setFailReason({ id: a.id, text: "" })}
                        className="px-3 flex items-center justify-center bg-red-500/10 border border-red-500/20 text-red-400 text-xs font-bold rounded-xl"
                      >
                        <XCircle className="size-4" />
                      </button>
                    </div>
                  )}

                  {a.status === "redeemed" && (
                    <div className="flex items-center gap-1.5 text-xs text-green-400 font-semibold">
                      <CheckCircle2 className="size-3.5" />
                      Redeemed {a.redeemed_at ? timeAgo(a.redeemed_at) : ""}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Fail modal */}
      {failReason && (
        <div className="fixed inset-0 bg-black/70 flex items-end sm:items-center justify-center z-50 px-4 pb-6">
          <div className="bg-card border border-border/60 rounded-3xl p-6 w-full max-w-sm space-y-4">
            <h3 className="text-base font-extrabold">Report Card Failure</h3>
            <p className="text-sm text-muted-foreground">Describe why this card couldn't be redeemed. Admin will review.</p>
            <textarea
              value={failReason.text}
              onChange={e => setFailReason(f => f ? { ...f, text: e.target.value } : null)}
              placeholder="e.g. Card says already redeemed, Balance was $0..."
              className="w-full bg-secondary border border-border/60 rounded-xl px-3 py-3 text-sm resize-none h-24 outline-none"
            />
            <div className="flex gap-2">
              <button onClick={() => setFailReason(null)} className="flex-1 py-3 rounded-xl bg-secondary text-sm font-bold">Cancel</button>
              <button onClick={handleFail} disabled={!failReason.text.trim() || !!acting} className="flex-1 py-3 rounded-xl bg-red-500/20 border border-red-500/30 text-red-400 text-sm font-bold disabled:opacity-50">
                {acting ? <Loader2 className="size-4 animate-spin mx-auto" /> : "Report Failed"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Wallet Tab ────────────────────────────────────────────────────────────────
type WithdrawalRow = {
  id: string; amount: number; bank_name: string; account_number: string;
  account_name: string; status: string; admin_note: string | null;
  created_at: string; processed_at: string | null;
};

type ReferralInfo = { referralCode: string | null; referralLink: string; totalReferred: number; bonusesPaid: number; totalEarnedNgn: number };

function WalletTab() {
  const [data, setData] = useState<WalletData | null>(null);
  const [vans, setVans] = useState<Array<{ id: string; account_number: string; bank_name: string; account_name: string | null; amount_expected: number | null; expires_at: string; reference: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [provisioning, setProvisioning] = useState(false);
  const [amount, setAmount] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [withdrawals, setWithdrawals] = useState<WithdrawalRow[]>([]);
  const [showWithdrawModal, setShowWithdrawModal] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [withdrawForm, setWithdrawForm] = useState({ amount: "", bankName: "", bankCode: "", accountNumber: "", accountName: "" });
  const [referral, setReferral] = useState<ReferralInfo | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [w, v, wd, ref] = await Promise.all([
        getVendorWallet({ data: {} }) as Promise<WalletData>,
        getActiveVirtualAccounts({ data: {} }) as Promise<typeof vans>,
        getMyWithdrawals({ data: {} }) as Promise<WithdrawalRow[]>,
        getMyReferralInfo({ data: {} }) as Promise<ReferralInfo>,
      ]);
      setData(w); setVans(v); setWithdrawals(wd); setReferral(ref);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleProvision = async () => {
    setProvisioning(true);
    try {
      const amtNgn = parseFloat(amount) || 0;
      const van = await provisionVirtualAccount({ data: { amountNgn: amtNgn } }) as typeof vans[0];
      setVans(prev => [van, ...prev]);
      setAmount("");
    } catch (e) { alert(e instanceof Error ? e.message : "Failed to provision account"); }
    finally { setProvisioning(false); }
  };

  const handleCopy = (text: string, key: string) => {
    copyToClipboard(text); setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  };

  const handleWithdraw = async () => {
    setWithdrawing(true);
    try {
      await requestWithdrawal({
        data: {
          amount: parseFloat(withdrawForm.amount),
          bankName: withdrawForm.bankName,
          bankCode: withdrawForm.bankCode,
          accountNumber: withdrawForm.accountNumber,
          accountName: withdrawForm.accountName,
        },
      });
      setShowWithdrawModal(false);
      setWithdrawForm({ amount: "", bankName: "", bankCode: "", accountNumber: "", accountName: "" });
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Withdrawal failed");
    } finally {
      setWithdrawing(false);
    }
  };

  if (loading) return <div className="flex-1 flex items-center justify-center"><Loader2 className="size-6 animate-spin text-gold" /></div>;

  return (
    <div className="p-6 space-y-6">
      {/* Balance card */}
      <div className="bg-gradient-to-br from-gold/20 via-gold/10 to-transparent border border-gold/20 rounded-3xl p-6">
        <p className="text-xs text-gold/70 font-bold uppercase tracking-widest">Vendor Balance</p>
        <p className="text-4xl font-extrabold text-gold mt-1">{fmtNgn(data?.wallet?.balance ?? 0)}</p>
        <p className="text-xs text-muted-foreground mt-2">Total funded: {fmtNgn(data?.wallet?.total_funded ?? 0)}</p>
        <button
          onClick={() => setShowWithdrawModal(true)}
          disabled={(data?.wallet?.balance ?? 0) < 1000}
          className="mt-4 w-full flex items-center justify-center gap-2 bg-gold text-black font-extrabold text-sm rounded-xl py-2.5 disabled:opacity-40"
        >
          <Banknote className="size-4" /> Withdraw Funds
        </button>
      </div>

      {/* Refer & Earn */}
      <ReferSection referral={referral} />

      {/* Fund wallet */}
      <div className="bg-card border border-border/60 rounded-2xl p-5 space-y-4">
        <div className="flex items-center gap-2">
          <Plus className="size-4 text-cyan" />
          <p className="text-sm font-extrabold">Fund Wallet</p>
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed">Generate a dedicated account number for your deposit. Funds credit automatically once payment is confirmed.</p>
        <div className="flex gap-2">
          <div className="flex-1 flex items-center gap-2 bg-secondary border border-border/60 rounded-xl px-3 py-2.5">
            <span className="text-sm text-muted-foreground">₦</span>
            <input type="number" value={amount} onChange={e => setAmount(e.target.value)} placeholder="Amount (optional)" className="flex-1 bg-transparent text-sm outline-none" />
          </div>
          <button onClick={handleProvision} disabled={provisioning} className="px-4 rounded-xl bg-cyan/15 border border-cyan/25 text-cyan text-sm font-bold flex items-center gap-1.5 disabled:opacity-50">
            {provisioning ? <Loader2 className="size-4 animate-spin" /> : <Banknote className="size-4" />}
            Generate
          </button>
        </div>
      </div>

      {/* Active VANs */}
      {vans.length > 0 && (
        <div className="space-y-3">
          <p className="text-xs font-bold text-muted-foreground uppercase tracking-widest">Active Accounts</p>
          {vans.map(van => (
            <div key={van.id} className="bg-card border border-cyan/20 rounded-2xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-bold text-cyan">{van.bank_name}</p>
                <span className="text-[10px] text-muted-foreground">Expires {new Date(van.expires_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</span>
              </div>
              <div className="flex items-center justify-between bg-secondary rounded-xl px-3 py-2.5">
                <div>
                  <p className="text-xs text-muted-foreground">{van.account_name ?? "7SEVEN Vendor"}</p>
                  <p className="text-lg font-mono font-bold">{van.account_number}</p>
                </div>
                <button onClick={() => handleCopy(van.account_number, van.id)}>
                  {copied === van.id ? <CheckCircle2 className="size-5 text-green-400" /> : <Copy className="size-5 text-muted-foreground" />}
                </button>
              </div>
              {van.amount_expected && (
                <p className="text-xs text-muted-foreground">Expected: <span className="text-foreground font-semibold">{fmtNgn(van.amount_expected)}</span></p>
              )}
              <p className="text-[10px] text-muted-foreground">Ref: {van.reference}</p>
            </div>
          ))}
        </div>
      )}

      {/* Transactions */}
      {(data?.transactions ?? []).length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-bold text-muted-foreground uppercase tracking-widest">Recent Transactions</p>
          {data!.transactions.map(tx => (
            <div key={tx.id} className="flex items-center gap-3 py-2.5 border-b border-border/40 last:border-0">
              <div className={`size-8 rounded-full grid place-items-center shrink-0 ${tx.type.includes("credit") ? "bg-green-500/10" : "bg-red-500/10"}`}>
                {tx.type.includes("credit") ? <TrendingUp className="size-4 text-green-400" /> : <Banknote className="size-4 text-red-400" />}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold truncate">{tx.description ?? tx.type}</p>
                <p className="text-xs text-muted-foreground">{timeAgo(tx.created_at)}</p>
              </div>
              <p className={`text-sm font-extrabold shrink-0 ${tx.type.includes("credit") ? "text-green-400" : "text-red-400"}`}>
                {tx.type.includes("credit") ? "+" : "-"}{fmtNgn(tx.amount)}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* Withdrawal History */}
      {withdrawals.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-bold text-muted-foreground uppercase tracking-widest">Withdrawals</p>
          {withdrawals.map(w => {
            const statusColor =
              w.status === "paid" ? "text-green-400 bg-green-400/10 border-green-400/20"
              : w.status === "pending" ? "text-gold bg-gold/10 border-gold/20"
              : w.status === "rejected" ? "text-red-400 bg-red-400/10 border-red-400/20"
              : "text-muted-foreground bg-secondary border-border/40";
            return (
              <div key={w.id} className="flex items-center gap-3 bg-card border border-border/60 rounded-xl p-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-extrabold">{fmtNgn(w.amount)}</p>
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${statusColor}`}>{w.status}</span>
                  </div>
                  <p className="text-xs text-muted-foreground truncate">{w.bank_name} · {w.account_number}</p>
                  {w.admin_note && <p className="text-xs text-red-400 mt-0.5">{w.admin_note}</p>}
                  <p className="text-[10px] text-muted-foreground mt-0.5">{timeAgo(w.created_at)}</p>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Withdraw Modal */}
      {showWithdrawModal && (
        <div className="fixed inset-0 bg-black/80 flex items-end sm:items-center justify-center z-50 px-4 pb-6">
          <div className="bg-card border border-border/60 rounded-3xl p-6 w-full max-w-sm space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Banknote className="size-5 text-gold" />
                <h3 className="text-base font-extrabold">Withdraw Funds</h3>
              </div>
              <button onClick={() => setShowWithdrawModal(false)} className="text-muted-foreground hover:text-foreground"><XCircle className="size-5" /></button>
            </div>
            <p className="text-xs text-muted-foreground">Available: <span className="text-gold font-bold">{fmtNgn(data?.wallet?.balance ?? 0)}</span> · Min ₦1,000</p>
            <div className="space-y-3">
              <div>
                <label className="text-xs font-bold text-muted-foreground mb-1 block">Amount (₦)</label>
                <input type="number" value={withdrawForm.amount} onChange={e => setWithdrawForm(f => ({ ...f, amount: e.target.value }))}
                  placeholder="e.g. 50000" className="w-full bg-secondary border border-border/60 rounded-xl px-3 py-2.5 text-sm outline-none" />
              </div>
              <div className="flex gap-2">
                <div className="flex-1">
                  <label className="text-xs font-bold text-muted-foreground mb-1 block">Bank Name</label>
                  <input value={withdrawForm.bankName} onChange={e => setWithdrawForm(f => ({ ...f, bankName: e.target.value }))}
                    placeholder="e.g. GTBank" className="w-full bg-secondary border border-border/60 rounded-xl px-3 py-2.5 text-sm outline-none" />
                </div>
                <div className="w-24">
                  <label className="text-xs font-bold text-muted-foreground mb-1 block">Bank Code</label>
                  <input value={withdrawForm.bankCode} onChange={e => setWithdrawForm(f => ({ ...f, bankCode: e.target.value }))}
                    placeholder="058" className="w-full bg-secondary border border-border/60 rounded-xl px-3 py-2.5 text-sm outline-none" />
                </div>
              </div>
              <div>
                <label className="text-xs font-bold text-muted-foreground mb-1 block">Account Number</label>
                <input value={withdrawForm.accountNumber} onChange={e => setWithdrawForm(f => ({ ...f, accountNumber: e.target.value }))}
                  placeholder="0123456789" maxLength={10} className="w-full bg-secondary border border-border/60 rounded-xl px-3 py-2.5 text-sm font-mono outline-none" />
              </div>
              <div>
                <label className="text-xs font-bold text-muted-foreground mb-1 block">Account Name</label>
                <input value={withdrawForm.accountName} onChange={e => setWithdrawForm(f => ({ ...f, accountName: e.target.value }))}
                  placeholder="Full name as on account" className="w-full bg-secondary border border-border/60 rounded-xl px-3 py-2.5 text-sm outline-none" />
              </div>
            </div>
            <button
              onClick={handleWithdraw}
              disabled={withdrawing || !withdrawForm.amount || !withdrawForm.bankCode || !withdrawForm.accountNumber || !withdrawForm.accountName}
              className="w-full flex items-center justify-center gap-2 bg-gold text-black font-extrabold text-sm rounded-xl py-3 disabled:opacity-50"
            >
              {withdrawing ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
              {withdrawing ? "Submitting…" : "Submit Withdrawal Request"}
            </button>
            <p className="text-[10px] text-center text-muted-foreground">Funds are locked until approved by admin. Processing is typically same-day.</p>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Refer & Earn Section (used inside WalletTab JSX) ─────────────────────────
function ReferSection({ referral }: { referral: ReferralInfo | null }) {
  const [copied, setCopied] = useState(false);
  if (!referral) return null;
  const link = referral.referralLink;
  const handleCopy = () => {
    copyToClipboard(link); setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="rounded-3xl border border-gold/20 bg-gold/5 p-5 space-y-4">
      <div className="flex items-center gap-2">
        <span className="text-lg">🤝</span>
        <div>
          <p className="text-sm font-extrabold">Refer &amp; Earn</p>
          <p className="text-[11px] text-muted-foreground">Earn <span className="text-gold font-bold">₦2,500</span> when your recruit completes 10 redemptions</p>
        </div>
      </div>

      {/* Referral link */}
      <div>
        <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1.5">Your invite link</p>
        <div className="flex items-center gap-2 bg-secondary rounded-xl px-3 py-2.5">
          <code className="flex-1 text-xs font-mono text-gold truncate">{link}</code>
          <button onClick={handleCopy} className="shrink-0 text-muted-foreground hover:text-white transition-colors">
            {copied ? <CheckCircle2 className="size-4 text-green-400" /> : <Copy className="size-4" />}
          </button>
        </div>
        {referral.referralCode && (
          <p className="text-[10px] text-muted-foreground mt-1.5">Code: <span className="font-mono font-bold text-white">{referral.referralCode}</span></p>
        )}
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: "Referred", value: String(referral.totalReferred), emoji: "👥" },
          { label: "Bonuses Paid", value: String(referral.bonusesPaid), emoji: "✅" },
          { label: "Total Earned", value: `₦${(referral.totalEarnedNgn / 1000).toFixed(1)}k`, emoji: "💰" },
        ].map(s => (
          <div key={s.label} className="bg-secondary rounded-2xl p-3 text-center">
            <p className="text-base">{s.emoji}</p>
            <p className="text-sm font-extrabold mt-0.5">{s.value}</p>
            <p className="text-[9px] text-muted-foreground uppercase tracking-wide">{s.label}</p>
          </div>
        ))}
      </div>

      <p className="text-[10px] text-muted-foreground text-center">
        Share your link. When your recruit reaches 10 redeemed cards, ₦2,500 lands in your wallet automatically.
      </p>
    </div>
  );
}

// ─── Profile Tab ──────────────────────────────────────────────────────────────
type BadgeItem = { id: string; emoji: string; name: string; description: string; earned: boolean };

function ProfileTab({ vendor, onLogout }: { vendor: VendorSession; onLogout: () => void }) {
  const [form, setForm] = useState({
    businessName: vendor.business_name ?? "",
    contactName: vendor.contact_name ?? "",
    phone: vendor.phone ?? "",
    telegramUsername: vendor.telegram_username ?? "",
    bankName: vendor.bank_name ?? "",
    bankCode: vendor.bank_code ?? "",
    accountNumber: vendor.account_number ?? "",
    accountName: vendor.account_name ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [badges, setBadges] = useState<{ earned: BadgeItem[]; locked: BadgeItem[] } | null>(null);
  const [rateData, setRateData] = useState<{ currentRate: number | null; history: RateHistoryRow[] } | null>(null);

  useEffect(() => {
    getMyBadges({ data: {} })
      .then(r => setBadges(r as { earned: BadgeItem[]; locked: BadgeItem[] }))
      .catch(() => {});
    getMyRateHistory({ data: {} })
      .then(r => setRateData(r as { currentRate: number | null; history: RateHistoryRow[] }))
      .catch(() => {});
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateVendorProfile({ data: form });
      setSaved(true); setTimeout(() => setSaved(false), 2000);
    } finally { setSaving(false); }
  };

  const field = (label: string, key: keyof typeof form, placeholder?: string, hint?: string) => (
    <div>
      <label className="text-xs font-bold text-muted-foreground mb-1.5 block">{label}</label>
      <input value={form[key]} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))} placeholder={placeholder} className="w-full bg-secondary border border-border/60 rounded-xl px-4 py-3 text-sm outline-none focus:border-gold/40" />
      {hint && <p className="text-[10px] text-muted-foreground mt-1">{hint}</p>}
    </div>
  );

  return (
    <div className="p-6 space-y-6">

      {/* ── My Rate ── */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <TrendingUp className="size-4 text-gold" />
          <h3 className="text-sm font-extrabold">My Exchange Rate</h3>
        </div>

        {/* Current rate card */}
        <div className={`rounded-2xl border p-4 mb-3 ${rateData?.currentRate ? "border-gold/25 bg-gold/5" : "border-border/60 bg-secondary/50"}`}>
          <p className="text-xs text-muted-foreground mb-1">Current rate</p>
          <p className={`text-2xl font-extrabold tabular-nums ${rateData?.currentRate ? "text-gold" : "text-muted-foreground"}`}>
            {rateData?.currentRate
              ? `₦${Number(rateData.currentRate).toLocaleString("en-NG")}/$1`
              : "Not set yet"}
          </p>
          <p className="text-[10px] text-muted-foreground mt-1.5">
            7SEVEN bot asks every 6 hours via Telegram. Reply <b>YES</b> then send your new number to update instantly.
          </p>
        </div>

        {/* Rate history */}
        {rateData && rateData.history.length > 0 && (
          <div>
            <p className="text-[10px] text-muted-foreground font-bold uppercase tracking-wider mb-2">Rate History</p>
            <div className="space-y-2">
              {rateData.history.slice(0, 5).map(r => {
                const change = r.old_rate
                  ? ((Number(r.new_rate) - Number(r.old_rate)) / Number(r.old_rate) * 100).toFixed(1)
                  : null;
                const up = change ? Number(change) >= 0 : null;
                return (
                  <div key={r.id} className="bg-secondary/60 rounded-xl px-3 py-2.5 flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <p className="text-sm font-extrabold">₦{Number(r.new_rate).toLocaleString("en-NG")}/$1</p>
                        {change && (
                          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${up ? "bg-green-500/15 text-green-400" : "bg-red-500/15 text-red-400"}`}>
                            {up ? "▲" : "▼"} {Math.abs(Number(change))}%
                          </span>
                        )}
                      </div>
                      {r.old_rate && (
                        <p className="text-[10px] text-muted-foreground">
                          was ₦{Number(r.old_rate).toLocaleString("en-NG")} · via {r.changed_via}
                        </p>
                      )}
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-[10px] text-muted-foreground">{timeAgo(r.created_at)}</p>
                      {r.admin_notified_at && (
                        <p className="text-[9px] text-green-400 mt-0.5">Admin notified ✓</p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {rateData && rateData.history.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-3">
            No rate changes yet. The bot will ask you every 6 hours via Telegram.
          </p>
        )}
      </div>

      <div className="h-px bg-border/60" />

      {/* ── Badges ── */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <span className="text-base">🏆</span>
          <h3 className="text-sm font-extrabold">Your Badges</h3>
          {badges && (
            <span className="ml-auto text-[10px] text-muted-foreground font-semibold">
              {badges.earned.length}/{badges.earned.length + badges.locked.length} earned
            </span>
          )}
        </div>

        {!badges ? (
          <div className="flex justify-center py-4">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-3">
            {badges.earned.length > 0 && (
              <div className="grid grid-cols-2 gap-2">
                {badges.earned.map(b => (
                  <div key={b.id} className="flex items-start gap-2.5 rounded-2xl border border-gold/25 bg-gold/5 p-3">
                    <span className="text-xl shrink-0 mt-0.5">{b.emoji}</span>
                    <div className="min-w-0">
                      <p className="text-xs font-extrabold text-gold leading-tight">{b.name}</p>
                      <p className="text-[10px] text-muted-foreground leading-snug mt-0.5">{b.description}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {badges.earned.length === 0 && (
              <div className="text-center py-5 rounded-2xl border border-border/40 bg-secondary/50">
                <p className="text-2xl mb-1">🎖️</p>
                <p className="text-xs font-bold text-muted-foreground">No badges yet</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">Start redeeming cards to earn them</p>
              </div>
            )}

            {badges.locked.length > 0 && (
              <div>
                <p className="text-[10px] text-muted-foreground font-bold uppercase tracking-wider mb-2">Locked</p>
                <div className="grid grid-cols-2 gap-2">
                  {badges.locked.map(b => (
                    <div key={b.id} className="flex items-start gap-2.5 rounded-2xl border border-border/40 bg-secondary/40 p-3 opacity-50">
                      <span className="text-xl shrink-0 mt-0.5 grayscale">{b.emoji}</span>
                      <div className="min-w-0">
                        <p className="text-xs font-extrabold leading-tight">{b.name}</p>
                        <p className="text-[10px] text-muted-foreground leading-snug mt-0.5">{b.description}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="h-px bg-border/60" />

      <div>
        <h3 className="text-base font-extrabold">Business Info</h3>
        <p className="text-xs text-muted-foreground mt-0.5">Update your vendor profile details</p>
      </div>

      <div className="space-y-4">
        {field("Business Name", "businessName", "Your business name")}
        {field("Contact Name", "contactName", "Your full name")}
        {field("Phone Number", "phone", "+234...")}
      </div>

      <div className="h-px bg-border/60" />

      <div>
        <div className="flex items-center gap-2 mb-4">
          <MessageCircle className="size-4 text-blue-400" />
          <h3 className="text-sm font-extrabold">Telegram Notifications</h3>
        </div>
        {field("Telegram Username", "telegramUsername", "@yourusername",
          "Enter without @. Start a chat with @7SevenCardsBot first so we can reach you.")}
        {form.telegramUsername && (
          <a
            href={`https://t.me/${form.telegramUsername.replace(/^@/, "")}`}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-flex items-center gap-1.5 text-xs text-blue-400 font-semibold"
          >
            Open @{form.telegramUsername} on Telegram →
          </a>
        )}
      </div>

      <div className="h-px bg-border/60" />

      <div>
        <div className="flex items-center gap-2 mb-4">
          <Banknote className="size-4 text-green-400" />
          <h3 className="text-sm font-extrabold">Bank Details</h3>
        </div>
        <div className="space-y-3">
          {field("Bank Name", "bankName", "e.g. GTBank")}
          {field("Bank Code", "bankCode", "e.g. 058")}
          {field("Account Number", "accountNumber", "10-digit account number")}
          {field("Account Name", "accountName", "As registered with bank")}
        </div>
      </div>

      <button onClick={handleSave} disabled={saving} className="w-full flex items-center justify-center gap-2 bg-gold text-jungle-deep font-extrabold rounded-xl py-3.5 disabled:opacity-50">
        {saving ? <Loader2 className="size-4 animate-spin" /> : saved ? <CheckCircle2 className="size-4" /> : <Send className="size-4" />}
        {saved ? "Saved!" : saving ? "Saving…" : "Save Changes"}
      </button>

      <div className="h-px bg-border/60" />

      <div className="space-y-3">
        <div className="flex items-center justify-between py-2">
          <p className="text-sm text-muted-foreground">Status</p>
          <span className="text-xs font-bold text-green-400 bg-green-400/10 border border-green-400/20 px-2 py-0.5 rounded-full capitalize">{vendor.status}</span>
        </div>
        <div className="flex items-center justify-between py-2">
          <p className="text-sm text-muted-foreground">Tier</p>
          <span className="text-xs font-bold text-gold capitalize">{vendor.tier}</span>
        </div>
        <div className="flex items-center justify-between py-2">
          <p className="text-sm text-muted-foreground">Total Redeemed</p>
          <span className="text-xs font-semibold">{vendor.total_redeemed} cards</span>
        </div>
      </div>

      <button onClick={onLogout} className="w-full flex items-center justify-center gap-2 py-3 rounded-xl border border-border/60 text-sm text-muted-foreground font-semibold">
        <LogOut className="size-4" /> Sign Out
      </button>
    </div>
  );
}

// ─── Main Portal ──────────────────────────────────────────────────────────────
function VendorPortal() {
  const [vendor, setVendor] = useState<VendorSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<VendorTab>("dashboard");

  useEffect(() => {
    getVendorSession({ data: {} })
      .then((s: unknown) => {
        const session = s as { authenticated: boolean; vendor?: VendorSession };
        if (session.authenticated && session.vendor) setVendor(session.vendor);
      })
      .finally(() => setLoading(false));
  }, []);

  const handleLogout = async () => {
    await vendorLogout({ data: {} });
    setVendor(null);
  };

  if (loading) return (
    <div className="min-h-screen bg-background flex items-center justify-center">
      <div className="text-center space-y-3">
        <Loader2 className="size-8 animate-spin text-gold mx-auto" />
        <p className="text-sm text-muted-foreground">Loading vendor portal…</p>
      </div>
    </div>
  );

  if (!vendor) return <AuthScreen onAuth={setVendor} />;
  if (vendor.status === "pending" || vendor.status === "suspended") {
    return <StatusGate status={vendor.status} onLogout={handleLogout} />;
  }

  const tabs: { id: VendorTab; label: string; icon: typeof LayoutDashboard }[] = [
    { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
    { id: "cards",     label: "My Cards",  icon: CreditCard },
    { id: "wallet",    label: "Wallet",    icon: Wallet2 },
    { id: "profile",   label: "Profile",   icon: User },
  ];

  return (
    <div className="min-h-screen bg-background flex flex-col md:flex-row">
      {/* Desktop Sidebar */}
      <aside className="hidden md:flex flex-col w-56 shrink-0 border-r border-border/60 bg-card/40 p-5">
        <div className="flex items-center gap-2.5 mb-8">
          <div className="size-9 rounded-xl bg-gradient-to-br from-gold/30 to-gold/10 grid place-items-center">
            <Building2 className="size-5 text-gold" />
          </div>
          <div>
            <p className="text-xs font-extrabold">7SEVEN</p>
            <p className="text-[10px] text-muted-foreground">Vendor Portal</p>
          </div>
        </div>

        <nav className="space-y-1 flex-1">
          {tabs.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-semibold transition-colors ${tab === t.id ? "bg-gold/15 text-gold" : "text-muted-foreground hover:text-foreground hover:bg-secondary"}`}>
              <t.icon className="size-4 shrink-0" />
              {t.label}
            </button>
          ))}
        </nav>

        <div className="border-t border-border/60 pt-4 mt-4">
          <div className="flex items-center gap-2 mb-3">
            <div className="size-7 rounded-full bg-secondary grid place-items-center">
              <User className="size-3.5 text-muted-foreground" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-bold truncate">{vendor.business_name}</p>
              <p className="text-[10px] text-muted-foreground capitalize">{vendor.tier}</p>
            </div>
          </div>
          <button onClick={handleLogout} className="w-full flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground py-2 px-3 rounded-lg hover:bg-secondary">
            <LogOut className="size-3.5" /> Sign Out
          </button>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 flex flex-col overflow-hidden">
        {/* Mobile header */}
        <header className="md:hidden flex items-center justify-between px-4 py-3 border-b border-border/60 bg-card/40 sticky top-0 z-10">
          <div className="flex items-center gap-2">
            <Building2 className="size-5 text-gold" />
            <p className="text-sm font-extrabold">Vendor Portal</p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{vendor.business_name}</span>
          </div>
        </header>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {tab === "dashboard" && <DashboardTab vendor={vendor} />}
          {tab === "cards"     && <CardsTab />}
          {tab === "wallet"    && <WalletTab />}
          {tab === "profile"   && <ProfileTab vendor={vendor} onLogout={handleLogout} />}
        </div>

        {/* Mobile bottom nav */}
        <nav className="md:hidden shrink-0 flex border-t border-border/60 bg-background/95 backdrop-blur">
          {tabs.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} className={`flex-1 flex flex-col items-center gap-1 py-3 text-[10px] font-bold transition-colors ${tab === t.id ? "text-gold" : "text-muted-foreground"}`}>
              <t.icon className="size-5" />
              {t.label}
            </button>
          ))}
        </nav>
      </main>
    </div>
  );
}
