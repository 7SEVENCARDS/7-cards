// ─────────────────────────────────────────────────────────────────────────────
// VendorRatePanel — Admin: All-Vendor Rate Comparison + Approval Dashboard
//
// Shows every active vendor's current approved rate, any pending rate change
// that needs admin action, full rate change history, and approve/reject/override
// controls — all before any rate touches live trades.
//
// Layout:
//   ① Summary bar  — pending count, avg rate, rate spread (max-min), vendor count
//   ② Rate ladder  — horizontal strip: all vendors ranked by current rate
//   ③ Vendor cards — sorted by: pending first, then by rate desc
//      Each card:
//        • Name + tier badge + status dot
//        • Current approved rate (big)
//        • Pending section (amber, [Approve] [Reject]) when pending exists
//        • Last-change info (Δ, direction arrow, via, time ago)
//        • [Override] button always available
//        • Expandable history list (last 10 entries)
//   ④ Override modal — slide-up input + optional notes + confirm
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useCallback, useEffect } from "react";
import {
  TrendingUp, TrendingDown, Minus, RefreshCw, Loader2,
  CheckCircle2, XCircle, Pencil, ChevronDown, ChevronUp,
  Clock, AlertTriangle, ArrowUpRight, ArrowDownRight,
  Shield, Zap, Star, BarChart3, X,
} from "lucide-react";
import {
  adminGetVendorRates,
  adminApproveVendorRate,
  adminRejectVendorRate,
  adminOverrideVendorRate,
} from "../server-functions/admin";

// ─── Types ────────────────────────────────────────────────────────────────────
type RateHistoryEntry = {
  id: string;
  old_rate:     number | null;
  new_rate:     number;
  changed_via:  "telegram" | "admin" | "portal";
  status:       "pending" | "approved" | "rejected" | "overridden";
  admin_notes:  string | null;
  actioned_at:  string | null;
  created_at:   string;
};

type VendorRateRow = {
  id:                       string;
  business_name:            string;
  contact_name:             string | null;
  tier:                     "standard" | "premium";
  status:                   string;
  preferred_rate_ngn_per_usd:  number | null;
  pending_rate_ngn_per_usd:    number | null;
  pending_rate_submitted_at:   string | null;
  rate_last_updated_at:        string | null;
  last_rate_check_sent_at:     string | null;
  history:                  RateHistoryEntry[];
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmtNgn(n: number | null): string {
  if (n == null) return "—";
  return "₦" + Number(n).toLocaleString("en-NG");
}

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function rateΔ(oldRate: number | null, newRate: number): string {
  if (!oldRate) return "first";
  const pct = ((newRate - oldRate) / oldRate * 100).toFixed(1);
  return (newRate > oldRate ? "+" : "") + pct + "%";
}

function rateDir(oldRate: number | null, newRate: number): "up" | "down" | "same" {
  if (!oldRate) return "same";
  if (newRate > oldRate) return "up";
  if (newRate < oldRate) return "down";
  return "same";
}

const VIA_LABEL: Record<string, string> = { telegram: "Telegram", admin: "Admin override", portal: "Portal" };
const VIA_COLOR: Record<string, string> = {
  telegram: "text-blue-400 bg-blue-500/10",
  admin:    "text-purple-400 bg-purple-500/10",
  portal:   "text-cyan-400 bg-cyan-500/10",
};
const TIER_STYLE: Record<string, string> = {
  premium:  "text-gold bg-gold/10 border-gold/30",
  standard: "text-muted-foreground bg-secondary border-border",
};

// ─── Override Modal ───────────────────────────────────────────────────────────
function OverrideModal({
  vendor,
  onClose,
  onDone,
}: {
  vendor: VendorRateRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const [rate, setRate]   = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy]   = useState(false);
  const [err, setErr]     = useState("");

  const submit = async () => {
    const n = parseFloat(rate.replace(/[^\d.]/g, ""));
    if (isNaN(n) || n < 100 || n > 5000) { setErr("Enter a rate between 100 and 5000"); return; }
    setBusy(true);
    try {
      await adminOverrideVendorRate({ data: { vendorId: vendor.id, newRate: n, notes: notes.trim() || undefined } });
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Override failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-md bg-background border border-border/60 rounded-t-3xl p-6 pb-10 space-y-5"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-extrabold">Override Rate</h2>
            <p className="text-xs text-muted-foreground">{vendor.business_name}</p>
          </div>
          <button onClick={onClose} className="size-8 grid place-items-center rounded-full bg-secondary">
            <X className="size-4" />
          </button>
        </div>

        <div className="bg-secondary rounded-2xl p-4">
          <p className="text-xs text-muted-foreground mb-0.5">Current approved rate</p>
          <p className="text-2xl font-extrabold">{fmtNgn(vendor.preferred_rate_ngn_per_usd)} <span className="text-sm font-normal text-muted-foreground">/$1</span></p>
        </div>

        <div className="space-y-3">
          <div>
            <label className="text-xs font-bold text-muted-foreground">New rate (₦ per $1)</label>
            <input
              value={rate}
              onChange={e => setRate(e.target.value)}
              placeholder="e.g. 1510"
              className="mt-1.5 w-full bg-secondary border border-border/60 rounded-xl px-4 py-3 text-lg font-bold font-mono outline-none focus:border-gold/40"
              inputMode="decimal"
              autoFocus
            />
          </div>
          <div>
            <label className="text-xs font-bold text-muted-foreground">Admin notes (optional)</label>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Reason for override…"
              rows={2}
              className="mt-1.5 w-full bg-secondary border border-border/60 rounded-xl px-4 py-2 text-sm outline-none focus:border-gold/40 resize-none"
            />
          </div>
          {err && <p className="text-xs text-red-400 font-bold">{err}</p>}
        </div>

        <button
          onClick={submit}
          disabled={busy || !rate}
          className="w-full flex items-center justify-center gap-2 bg-gradient-gold text-jungle-deep font-extrabold py-3.5 rounded-2xl disabled:opacity-50"
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Pencil className="size-4" />}
          Apply Override
        </button>
      </div>
    </div>
  );
}

// ─── Rate History Row ─────────────────────────────────────────────────────────
function HistoryEntry({ h }: { h: RateHistoryEntry }) {
  const dir = rateDir(h.old_rate, h.new_rate);
  return (
    <div className="flex items-start gap-3 py-2 border-b border-border/30 last:border-0">
      <div className={`size-6 rounded-full grid place-items-center shrink-0 mt-0.5 ${
        dir === "up" ? "bg-green-500/15" : dir === "down" ? "bg-red-500/15" : "bg-secondary"
      }`}>
        {dir === "up"   ? <ArrowUpRight className="size-3 text-green-400" /> :
         dir === "down" ? <ArrowDownRight className="size-3 text-red-400" /> :
         <Minus className="size-3 text-muted-foreground" />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-xs font-extrabold">{fmtNgn(h.new_rate)}</span>
          {h.old_rate && (
            <span className={`text-[10px] font-bold ${dir === "up" ? "text-green-400" : dir === "down" ? "text-red-400" : "text-muted-foreground"}`}>
              {rateΔ(h.old_rate, h.new_rate)}
            </span>
          )}
          <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${VIA_COLOR[h.changed_via] ?? "text-muted-foreground"}`}>
            {VIA_LABEL[h.changed_via]}
          </span>
          <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full border ${
            h.status === "approved"   ? "border-green-500/30 text-green-400 bg-green-500/10" :
            h.status === "rejected"   ? "border-red-500/30 text-red-400 bg-red-500/10" :
            h.status === "pending"    ? "border-yellow-500/30 text-yellow-400 bg-yellow-500/10" :
            "border-purple-500/30 text-purple-400 bg-purple-500/10"
          }`}>
            {h.status.toUpperCase()}
          </span>
        </div>
        <p className="text-[10px] text-muted-foreground">{timeAgo(h.created_at)}</p>
        {h.admin_notes && <p className="text-[10px] text-muted-foreground/70 italic mt-0.5">{h.admin_notes}</p>}
      </div>
    </div>
  );
}

// ─── Individual Vendor Rate Card ──────────────────────────────────────────────
function VendorRateCard({
  vendor,
  onAction,
  onOverride,
}: {
  vendor: VendorRateRow;
  onAction: (v: VendorRateRow) => void;
  onOverride: (v: VendorRateRow) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [approving, setApproving] = useState(false);
  const [rejecting, setRejecting] = useState(false);

  const hasPending  = vendor.pending_rate_ngn_per_usd != null;
  const currentRate = vendor.preferred_rate_ngn_per_usd;
  const pendingRate = vendor.pending_rate_ngn_per_usd;
  const lastHistory = vendor.history[0];

  // Direction from last change (compare first two history entries)
  const dir = lastHistory ? rateDir(lastHistory.old_rate, lastHistory.new_rate) : "same";
  const pendingDir = hasPending && currentRate ? rateDir(currentRate, pendingRate!) : "same";

  const approve = async () => {
    setApproving(true);
    try {
      await adminApproveVendorRate({ data: { vendorId: vendor.id } });
      onAction(vendor);
    } catch { setApproving(false); }
  };

  const reject = async () => {
    setRejecting(true);
    try {
      await adminRejectVendorRate({ data: { vendorId: vendor.id } });
      onAction(vendor);
    } catch { setRejecting(false); }
  };

  return (
    <div className={`bg-card border rounded-2xl overflow-hidden transition-all ${
      hasPending ? "border-amber-500/40 shadow-[0_0_0_1px_rgba(245,158,11,0.15)]" : "border-border/60"
    }`}>
      {/* Pending alert strip */}
      {hasPending && (
        <div className="flex items-center gap-2 px-4 py-2 bg-amber-500/10 border-b border-amber-500/20">
          <AlertTriangle className="size-3.5 text-amber-400 shrink-0" />
          <p className="text-[11px] font-extrabold text-amber-400">PENDING ADMIN APPROVAL · submitted {timeAgo(vendor.pending_rate_submitted_at)}</p>
        </div>
      )}

      {/* Main card body */}
      <div className="px-4 pt-3 pb-4">
        {/* Header row */}
        <div className="flex items-start gap-2 mb-3">
          <div className="size-9 rounded-xl bg-secondary grid place-items-center shrink-0 text-sm font-extrabold text-muted-foreground">
            {vendor.business_name.slice(0, 2).toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <p className="text-sm font-extrabold truncate">{vendor.business_name}</p>
              <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full border ${TIER_STYLE[vendor.tier] ?? TIER_STYLE.standard}`}>
                {vendor.tier === "premium" ? "⭐ PREMIUM" : "STANDARD"}
              </span>
            </div>
            {vendor.contact_name && <p className="text-[10px] text-muted-foreground truncate">{vendor.contact_name}</p>}
          </div>
          {/* Dot */}
          <div className={`size-2 rounded-full mt-1.5 shrink-0 ${vendor.status === "active" ? "bg-green-400" : "bg-red-400"}`} />
        </div>

        {/* Rate display */}
        <div className="flex items-end gap-4 mb-4">
          {/* Current approved rate */}
          <div className="flex-1">
            <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-0.5">Approved Rate</p>
            <div className="flex items-baseline gap-1.5">
              <p className="text-2xl font-extrabold tabular-nums">
                {currentRate ? `₦${Number(currentRate).toLocaleString("en-NG")}` : "—"}
              </p>
              <p className="text-xs text-muted-foreground mb-0.5">/$1</p>
            </div>
            {lastHistory && (
              <div className="flex items-center gap-1 mt-0.5">
                {dir === "up" ? <TrendingUp className="size-3 text-green-400" /> :
                 dir === "down" ? <TrendingDown className="size-3 text-red-400" /> :
                 <Minus className="size-3 text-muted-foreground" />}
                <span className={`text-[10px] font-bold ${dir === "up" ? "text-green-400" : dir === "down" ? "text-red-400" : "text-muted-foreground"}`}>
                  {rateΔ(lastHistory.old_rate, lastHistory.new_rate)}
                </span>
                <span className="text-[10px] text-muted-foreground">{timeAgo(vendor.rate_last_updated_at)}</span>
              </div>
            )}
          </div>

          {/* Pending rate */}
          {hasPending && (
            <div className="text-right">
              <p className="text-[10px] font-bold text-amber-400 uppercase tracking-wider mb-0.5">Pending</p>
              <div className="flex items-baseline gap-1 justify-end">
                <p className="text-xl font-extrabold text-amber-300 tabular-nums">
                  ₦{Number(pendingRate).toLocaleString("en-NG")}
                </p>
              </div>
              <div className="flex items-center gap-1 justify-end mt-0.5">
                {pendingDir === "up" ? <ArrowUpRight className="size-3 text-green-400" /> : <ArrowDownRight className="size-3 text-red-400" />}
                <span className={`text-[10px] font-bold ${pendingDir === "up" ? "text-green-400" : "text-red-400"}`}>
                  {rateΔ(currentRate ?? null, pendingRate!)}
                </span>
              </div>
            </div>
          )}
        </div>

        {/* Last check info */}
        <div className="flex items-center gap-3 mb-4 text-[10px] text-muted-foreground">
          <div className="flex items-center gap-1">
            <Clock className="size-3" />
            Last check: {timeAgo(vendor.last_rate_check_sent_at)}
          </div>
          {lastHistory && (
            <span className={`px-1.5 py-0.5 rounded-full ${VIA_COLOR[lastHistory.changed_via] ?? ""}`}>
              via {VIA_LABEL[lastHistory.changed_via]}
            </span>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2">
          {hasPending ? (
            <>
              <button
                onClick={approve}
                disabled={approving}
                className="flex-1 flex items-center justify-center gap-1.5 bg-green-500/15 border border-green-500/30 text-green-400 font-extrabold text-xs py-2.5 rounded-xl active:scale-95 transition"
              >
                {approving ? <Loader2 className="size-3.5 animate-spin" /> : <CheckCircle2 className="size-3.5" />}
                Approve {fmtNgn(pendingRate!)}
              </button>
              <button
                onClick={reject}
                disabled={rejecting}
                className="flex-1 flex items-center justify-center gap-1.5 bg-red-500/10 border border-red-500/30 text-red-400 font-extrabold text-xs py-2.5 rounded-xl active:scale-95 transition"
              >
                {rejecting ? <Loader2 className="size-3.5 animate-spin" /> : <XCircle className="size-3.5" />}
                Reject
              </button>
              <button
                onClick={() => onOverride(vendor)}
                className="size-9 shrink-0 grid place-items-center rounded-xl border border-border/60 bg-secondary text-muted-foreground hover:border-gold/40 hover:text-gold transition"
                title="Override with custom rate"
              >
                <Pencil className="size-3.5" />
              </button>
            </>
          ) : (
            <>
              <div className="flex-1 text-[10px] text-muted-foreground px-2">
                {vendor.history.length > 0
                  ? `${vendor.history.length} rate change${vendor.history.length > 1 ? "s" : ""} on record`
                  : "No rate history yet"}
              </div>
              <button
                onClick={() => onOverride(vendor)}
                className="flex items-center gap-1.5 border border-border/60 bg-secondary text-muted-foreground hover:border-gold/40 hover:text-gold font-bold text-xs px-3 py-2 rounded-xl transition"
              >
                <Pencil className="size-3.5" /> Override Rate
              </button>
            </>
          )}
        </div>
      </div>

      {/* History toggle */}
      {vendor.history.length > 0 && (
        <>
          <button
            onClick={() => setExpanded(v => !v)}
            className="w-full flex items-center justify-between px-4 py-2.5 border-t border-border/40 bg-secondary/40 text-xs text-muted-foreground hover:bg-secondary/70 transition"
          >
            <span className="font-bold">Rate History</span>
            {expanded ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
          </button>
          {expanded && (
            <div className="px-4 py-2 divide-y divide-border/20">
              {vendor.history.map(h => <HistoryEntry key={h.id} h={h} />)}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── Rate Ladder (compact comparison strip) ───────────────────────────────────
function RateLadder({ vendors }: { vendors: VendorRateRow[] }) {
  const withRates = [...vendors]
    .filter(v => v.preferred_rate_ngn_per_usd != null)
    .sort((a, b) => (b.preferred_rate_ngn_per_usd ?? 0) - (a.preferred_rate_ngn_per_usd ?? 0));

  if (withRates.length === 0) return null;

  const maxRate = withRates[0].preferred_rate_ngn_per_usd ?? 1;
  const minRate = withRates[withRates.length - 1].preferred_rate_ngn_per_usd ?? 1;
  const spread  = maxRate - minRate;

  return (
    <div className="bg-card border border-border/60 rounded-2xl p-4 overflow-x-auto">
      <div className="flex items-end gap-3 min-w-0" style={{ minWidth: withRates.length * 68 }}>
        {withRates.map((v, i) => {
          const rate    = v.preferred_rate_ngn_per_usd ?? 0;
          const barPct  = spread > 0 ? (rate - minRate) / spread : 1;
          const barH    = Math.max(20, Math.round(barPct * 64)) + 8;
          const hasPending = v.pending_rate_ngn_per_usd != null;
          return (
            <div key={v.id} className="flex flex-col items-center gap-1.5" style={{ width: 60 }}>
              {/* Pending dot */}
              {hasPending && (
                <div className="size-2 rounded-full bg-amber-400 animate-pulse" title="Pending rate" />
              )}
              {/* Bar */}
              <div
                className={`w-full rounded-t-lg transition-all ${
                  i === 0 ? "bg-green-500/60" : i === withRates.length - 1 ? "bg-red-500/40" : "bg-cyan/40"
                }`}
                style={{ height: barH }}
              />
              {/* Rate label */}
              <p className="text-[9px] font-extrabold tabular-nums text-center leading-tight">
                {(rate / 1000).toFixed(2)}k
              </p>
              {/* Name */}
              <p className="text-[8px] text-muted-foreground text-center leading-tight truncate w-full">
                {v.business_name.split(" ")[0]}
              </p>
            </div>
          );
        })}
      </div>
      <div className="flex items-center justify-between mt-3 pt-2 border-t border-border/30">
        <p className="text-[10px] text-muted-foreground">
          <span className="text-green-400 font-bold">Highest: {fmtNgn(maxRate)}</span>
        </p>
        <p className="text-[10px] text-muted-foreground">
          Spread: <b>{fmtNgn(Math.round(spread))}</b>
        </p>
        <p className="text-[10px] text-muted-foreground">
          <span className="text-red-400 font-bold">Lowest: {fmtNgn(minRate)}</span>
        </p>
      </div>
    </div>
  );
}

// ─── Sort selector ────────────────────────────────────────────────────────────
type SortKey = "pending_first" | "rate_desc" | "rate_asc" | "name" | "last_change";

function sortVendors(vendors: VendorRateRow[], by: SortKey): VendorRateRow[] {
  return [...vendors].sort((a, b) => {
    if (by === "pending_first") {
      const aP = a.pending_rate_ngn_per_usd != null ? 0 : 1;
      const bP = b.pending_rate_ngn_per_usd != null ? 0 : 1;
      if (aP !== bP) return aP - bP;
      return (b.preferred_rate_ngn_per_usd ?? 0) - (a.preferred_rate_ngn_per_usd ?? 0);
    }
    if (by === "rate_desc") return (b.preferred_rate_ngn_per_usd ?? 0) - (a.preferred_rate_ngn_per_usd ?? 0);
    if (by === "rate_asc")  return (a.preferred_rate_ngn_per_usd ?? 0) - (b.preferred_rate_ngn_per_usd ?? 0);
    if (by === "name")      return a.business_name.localeCompare(b.business_name);
    if (by === "last_change") {
      const aT = a.rate_last_updated_at ?? "0";
      const bT = b.rate_last_updated_at ?? "0";
      return bT.localeCompare(aT);
    }
    return 0;
  });
}

// ─── Main VendorRatePanel ──────────────────────────────────────────────────────
export function VendorRatePanel() {
  const [vendors, setVendors]     = useState<VendorRateRow[] | null>(null);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState<string | null>(null);
  const [sort, setSort]           = useState<SortKey>("pending_first");
  const [overrideTarget, setOverrideTarget] = useState<VendorRateRow | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const res = await adminGetVendorRates({ data: {} }) as { vendors: VendorRateRow[] };
      setVendors(res.vendors);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load vendor rates");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleAction = () => load(true);
  const handleOverrideDone = () => { setOverrideTarget(null); load(true); };

  const sorted   = vendors ? sortVendors(vendors, sort) : [];
  const pending  = vendors?.filter(v => v.pending_rate_ngn_per_usd != null).length ?? 0;
  const withRate = vendors?.filter(v => v.preferred_rate_ngn_per_usd != null) ?? [];
  const avgRate  = withRate.length
    ? Math.round(withRate.reduce((s, v) => s + (v.preferred_rate_ngn_per_usd ?? 0), 0) / withRate.length)
    : null;
  const maxRate  = withRate.length ? Math.max(...withRate.map(v => v.preferred_rate_ngn_per_usd ?? 0)) : null;
  const minRate  = withRate.length ? Math.min(...withRate.map(v => v.preferred_rate_ngn_per_usd ?? 0)) : null;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="size-9 rounded-xl bg-gradient-gold grid place-items-center shrink-0">
            <BarChart3 className="size-5 text-jungle-deep" />
          </div>
          <div>
            <h2 className="text-sm font-extrabold">Rate Comparison</h2>
            <p className="text-[10px] text-muted-foreground">All active vendor rates · approve before trades</p>
          </div>
        </div>
        <button
          onClick={() => load()}
          disabled={loading}
          className="size-8 grid place-items-center rounded-xl border border-border/60 text-muted-foreground hover:border-gold/40 transition"
        >
          {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
        </button>
      </div>

      {/* Summary stats */}
      {vendors && (
        <div className="grid grid-cols-4 gap-2">
          {[
            { label: "Total Vendors", value: vendors.length, icon: Shield, color: "text-cyan" },
            { label: "Pending Review", value: pending, icon: AlertTriangle, color: pending > 0 ? "text-amber-400" : "text-muted-foreground" },
            { label: "Avg Rate", value: avgRate ? `₦${avgRate.toLocaleString()}` : "—", icon: BarChart3, color: "text-foreground" },
            { label: "Rate Spread", value: (maxRate && minRate) ? `₦${(maxRate - minRate).toLocaleString()}` : "—", icon: Zap, color: "text-purple-400" },
          ].map(({ label, value, icon: Icon, color }) => (
            <div key={label} className="bg-card border border-border/60 rounded-xl p-3 text-center">
              <Icon className={`size-4 mx-auto mb-1 ${color}`} />
              <p className={`text-sm font-extrabold ${color}`}>{value}</p>
              <p className="text-[9px] text-muted-foreground mt-0.5 leading-tight">{label}</p>
            </div>
          ))}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 text-xs text-red-400 font-bold">{error}</div>
      )}

      {/* Pending banner */}
      {pending > 0 && (
        <div className="flex items-center gap-2 bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-3">
          <AlertTriangle className="size-4 text-amber-400 shrink-0" />
          <p className="text-xs font-extrabold text-amber-400">
            {pending} vendor{pending > 1 ? "s" : ""} submitted a new rate — approve or override before it affects live trades.
          </p>
        </div>
      )}

      {/* Rate ladder */}
      {vendors && vendors.some(v => v.preferred_rate_ngn_per_usd != null) && (
        <RateLadder vendors={vendors} />
      )}

      {/* Sort selector */}
      {vendors && vendors.length > 0 && (
        <div className="flex gap-1.5 overflow-x-auto pb-0.5 no-scrollbar">
          {([
            ["pending_first", "Pending first"],
            ["rate_desc",     "Highest rate"],
            ["rate_asc",      "Lowest rate"],
            ["last_change",   "Last changed"],
            ["name",          "A–Z"],
          ] as [SortKey, string][]).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setSort(key)}
              className={`shrink-0 text-[10px] font-bold px-3 py-1.5 rounded-full border transition ${
                sort === key
                  ? "bg-gold/15 border-gold/40 text-gold"
                  : "border-border text-muted-foreground hover:border-border"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {/* Vendor cards */}
      {loading && !vendors && (
        <div className="flex justify-center py-12">
          <Loader2 className="size-6 animate-spin text-cyan" />
        </div>
      )}

      {!loading && vendors?.length === 0 && (
        <div className="text-center py-10">
          <Shield className="size-10 mx-auto mb-3 text-muted-foreground/30" />
          <p className="text-sm text-muted-foreground">No active vendors found</p>
        </div>
      )}

      <div className="space-y-3">
        {sorted.map(vendor => (
          <VendorRateCard
            key={vendor.id}
            vendor={vendor}
            onAction={handleAction}
            onOverride={v => setOverrideTarget(v)}
          />
        ))}
      </div>

      {/* Override modal */}
      {overrideTarget && (
        <OverrideModal
          vendor={overrideTarget}
          onClose={() => setOverrideTarget(null)}
          onDone={handleOverrideDone}
        />
      )}
    </div>
  );
}
