// ─────────────────────────────────────────────────────────────────────────────
// Admin Audit Log Viewer — Immutable Truth Engine Inspector
//
// Lets admins query the trade_audit_log by trade ID, actor/vendor ID, or event
// type without touching the database. Each entry can be SHA-256 verified
// in-browser: the canonical string is rebuilt from the stored payload and
// hashed client-side, then compared to the stored payload_hash.
//
// Two tabs:
//   Audit Log  — filter, browse, and verify individual log entries
//   Disputes   — filter vendor_disputes by verdict status
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useCallback } from "react";
import {
  Shield,
  ShieldCheck,
  ShieldX,
  Search,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Clock,
  Loader2,
  Link2,
  Eye,
} from "lucide-react";
import { queryAuditLog, queryDisputes } from "../server-functions/admin";

// ─── Types ────────────────────────────────────────────────────────────────────
type AuditEntry = {
  id: string;
  trade_id: string | null;
  assignment_id: string | null;
  event: string;
  actor_type: string;
  actor_id: string | null;
  server_ts_ms: number;
  payload_hash: string;
  payload: Record<string, unknown>;
};

type DisputeRow = {
  id: string;
  vendor_id: string;
  trade_id: string | null;
  failure_reason: string;
  t_exposure_ms: number | null;
  t_redeemed_ms: number | null;
  t_audit_ms: number | null;
  verdict: string;
  verdict_at: string | null;
  auto_actioned: boolean;
  deposit_forfeited_ngn: number;
  auto_suspended: boolean;
  created_at: string;
  vendors?: { business_name: string; contact_name: string | null };
};

type VerifyState = "idle" | "checking" | "ok" | "fail";

// ─── Browser SHA-256 (same canonical format as server's audit-log.ts) ─────────
async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

function buildCanonical(entry: AuditEntry): string {
  const payloadJson = JSON.stringify(entry.payload, Object.keys(entry.payload).sort());
  return [
    entry.trade_id      ?? "null",
    entry.assignment_id ?? "null",
    entry.event,
    entry.actor_type,
    entry.actor_id      ?? "system",
    String(entry.server_ts_ms),
    payloadJson,
  ].join("|");
}

async function verifyEntry(entry: AuditEntry): Promise<boolean> {
  const canonical = buildCanonical(entry);
  const computed = await sha256Hex(canonical);
  return computed === entry.payload_hash;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function fmtMs(ms: number): string {
  const d = new Date(ms);
  return d.toISOString().replace("T", " ").replace("Z", "") + " UTC";
}

function fmtTs(iso: string): string {
  return new Date(iso).toLocaleString("en-NG", { hour12: false });
}

function short(id: string | null): string {
  if (!id) return "—";
  return id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

const EVENT_COLORS: Record<string, string> = {
  card_verified:            "text-green-400 bg-green-500/10",
  card_exposed:             "text-yellow-400 bg-yellow-500/10",
  card_claimed:             "text-blue-400 bg-blue-500/10",
  van_created:              "text-cyan-400 bg-cyan-500/10",
  van_paid:                 "text-emerald-400 bg-emerald-500/10",
  vendor_marked_redeemed:   "text-purple-400 bg-purple-500/10",
  vendor_marked_failed:     "text-red-400 bg-red-500/10",
  fraud_audit_initiated:    "text-orange-400 bg-orange-500/10",
  fraud_confirmed:          "text-red-500 bg-red-500/15",
  system_error:             "text-gray-400 bg-gray-500/10",
  inconclusive:             "text-amber-400 bg-amber-500/10",
  card_direct_assigned:     "text-teal-400 bg-teal-500/10",
};

const VERDICT_COLORS: Record<string, string> = {
  pending:          "text-yellow-400 bg-yellow-500/15 border-yellow-500/30",
  fraud_confirmed:  "text-red-400 bg-red-500/15 border-red-500/30",
  system_error:     "text-gray-400 bg-gray-500/15 border-gray-500/30",
  cleared:          "text-green-400 bg-green-500/15 border-green-500/30",
  inconclusive:     "text-amber-400 bg-amber-500/15 border-amber-500/30",
};

const ALL_EVENTS = [
  "card_verified", "card_exposed", "card_claimed", "van_created", "van_paid",
  "vendor_marked_redeemed", "vendor_marked_failed", "fraud_audit_initiated",
  "fraud_confirmed", "system_error", "inconclusive", "card_direct_assigned",
];

// ─── Single Audit Entry Row ───────────────────────────────────────────────────
function EntryRow({ entry }: { entry: AuditEntry }) {
  const [expanded, setExpanded] = useState(false);
  const [verify, setVerify] = useState<VerifyState>("idle");

  const handleVerify = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setVerify("checking");
    try {
      const ok = await verifyEntry(entry);
      setVerify(ok ? "ok" : "fail");
    } catch {
      setVerify("fail");
    }
  };

  const eventColor = EVENT_COLORS[entry.event] ?? "text-muted-foreground bg-secondary";

  return (
    <div className="border border-border/50 rounded-xl overflow-hidden">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-start gap-3 px-3 py-2.5 hover:bg-secondary/40 transition text-left"
      >
        {/* Timestamp */}
        <div className="shrink-0 min-w-0 w-[175px]">
          <p className="text-[10px] font-mono text-muted-foreground leading-tight">{fmtMs(entry.server_ts_ms)}</p>
          <p className="text-[9px] text-muted-foreground/60 mt-0.5">ms: {entry.server_ts_ms}</p>
        </div>

        {/* Event badge + actor */}
        <div className="flex-1 min-w-0">
          <span className={`inline-block text-[10px] font-bold px-2 py-0.5 rounded-full ${eventColor}`}>
            {entry.event}
          </span>
          <p className="text-[10px] text-muted-foreground mt-0.5">
            {entry.actor_type} · {short(entry.actor_id)}
          </p>
        </div>

        {/* Trade / assignment */}
        <div className="shrink-0 text-right hidden sm:block">
          {entry.trade_id && (
            <p className="text-[10px] font-mono text-muted-foreground">{short(entry.trade_id)}</p>
          )}
        </div>

        {/* Hash verify chip */}
        <button
          onClick={handleVerify}
          className={`shrink-0 flex items-center gap-1 text-[10px] font-bold px-2 py-1 rounded-full border transition ${
            verify === "ok"       ? "border-green-500/40 text-green-400 bg-green-500/10" :
            verify === "fail"     ? "border-red-500/40 text-red-400 bg-red-500/10" :
            verify === "checking" ? "border-border text-muted-foreground" :
            "border-border text-muted-foreground hover:border-gold/40 hover:text-gold"
          }`}
          title="Verify SHA-256 hash in browser"
        >
          {verify === "checking" ? (
            <Loader2 className="size-3 animate-spin" />
          ) : verify === "ok" ? (
            <><ShieldCheck className="size-3" /> OK</>
          ) : verify === "fail" ? (
            <><ShieldX className="size-3" /> FAIL</>
          ) : (
            <><Shield className="size-3" /> Verify</>
          )}
        </button>

        <div className="shrink-0">
          {expanded ? <ChevronUp className="size-4 text-muted-foreground" /> : <ChevronDown className="size-4 text-muted-foreground" />}
        </div>
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t border-border/50 px-3 py-3 bg-secondary/20 space-y-3">
          {/* Hash comparison */}
          <div>
            <p className="text-[10px] font-bold text-muted-foreground mb-1">STORED HASH</p>
            <p className="font-mono text-[9px] text-foreground break-all leading-relaxed bg-secondary rounded-lg px-2 py-1.5">
              {entry.payload_hash}
            </p>
          </div>

          {/* Canonical string preview */}
          <div>
            <p className="text-[10px] font-bold text-muted-foreground mb-1">CANONICAL INPUT (pipe-separated)</p>
            <p className="font-mono text-[9px] text-muted-foreground break-all leading-relaxed bg-secondary rounded-lg px-2 py-1.5">
              {buildCanonical(entry)}
            </p>
          </div>

          {/* Full IDs */}
          <div className="grid grid-cols-2 gap-2 text-[10px]">
            <div>
              <p className="font-bold text-muted-foreground">Entry ID</p>
              <p className="font-mono text-foreground break-all">{entry.id}</p>
            </div>
            {entry.trade_id && (
              <div>
                <p className="font-bold text-muted-foreground">Trade ID</p>
                <p className="font-mono text-foreground break-all">{entry.trade_id}</p>
              </div>
            )}
            {entry.assignment_id && (
              <div>
                <p className="font-bold text-muted-foreground">Assignment ID</p>
                <p className="font-mono text-foreground break-all">{entry.assignment_id}</p>
              </div>
            )}
            {entry.actor_id && (
              <div>
                <p className="font-bold text-muted-foreground">Actor ID</p>
                <p className="font-mono text-foreground break-all">{entry.actor_id}</p>
              </div>
            )}
          </div>

          {/* Payload */}
          {Object.keys(entry.payload).length > 0 && (
            <div>
              <p className="text-[10px] font-bold text-muted-foreground mb-1">PAYLOAD</p>
              <pre className="text-[9px] font-mono text-muted-foreground bg-secondary rounded-lg px-2 py-1.5 overflow-x-auto whitespace-pre-wrap break-all">
                {JSON.stringify(entry.payload, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Audit Log Tab ────────────────────────────────────────────────────────────
function AuditLogTab() {
  const [tradeId, setTradeId]     = useState("");
  const [actorId, setActorId]     = useState("");
  const [eventType, setEventType] = useState("");
  const [entries, setEntries]     = useState<AuditEntry[] | null>(null);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState<string | null>(null);
  const [verifyingAll, setVerifyingAll] = useState(false);
  const [allVerifyResults, setAllVerifyResults] = useState<Record<string, boolean>>({});

  const search = useCallback(async () => {
    setLoading(true);
    setError(null);
    setAllVerifyResults({});
    try {
      const res = await queryAuditLog({
        data: {
          tradeId:   tradeId.trim() || undefined,
          actorId:   actorId.trim() || undefined,
          eventType: eventType || undefined,
          limit: 100,
        },
      }) as { entries: AuditEntry[] };
      setEntries(res.entries);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Query failed");
    } finally {
      setLoading(false);
    }
  }, [tradeId, actorId, eventType]);

  const verifyAll = async () => {
    if (!entries) return;
    setVerifyingAll(true);
    const results: Record<string, boolean> = {};
    await Promise.allSettled(
      entries.map(async e => {
        results[e.id] = await verifyEntry(e).catch(() => false);
      })
    );
    setAllVerifyResults(results);
    setVerifyingAll(false);
  };

  const allOk   = Object.keys(allVerifyResults).length > 0 && Object.values(allVerifyResults).every(Boolean);
  const anyFail = Object.values(allVerifyResults).some(v => !v);

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <div className="bg-card border border-border/60 rounded-2xl p-4 space-y-3">
        <p className="text-xs font-extrabold text-muted-foreground uppercase tracking-wider">Filter</p>
        <div className="grid grid-cols-1 gap-2">
          <input
            value={tradeId}
            onChange={e => setTradeId(e.target.value)}
            placeholder="Trade ID (UUID)…"
            className="bg-secondary border border-border/60 rounded-xl px-3 py-2 text-xs font-mono outline-none focus:border-gold/40 placeholder:text-muted-foreground"
          />
          <input
            value={actorId}
            onChange={e => setActorId(e.target.value)}
            placeholder="Actor / Vendor ID…"
            className="bg-secondary border border-border/60 rounded-xl px-3 py-2 text-xs font-mono outline-none focus:border-gold/40 placeholder:text-muted-foreground"
          />
          <select
            value={eventType}
            onChange={e => setEventType(e.target.value)}
            className="bg-secondary border border-border/60 rounded-xl px-3 py-2 text-xs outline-none focus:border-gold/40"
          >
            <option value="">All event types</option>
            {ALL_EVENTS.map(ev => (
              <option key={ev} value={ev}>{ev}</option>
            ))}
          </select>
        </div>
        <button
          onClick={search}
          disabled={loading}
          className="w-full flex items-center justify-center gap-2 bg-gradient-gold text-jungle-deep font-extrabold text-sm py-2.5 rounded-xl"
        >
          {loading ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
          {loading ? "Querying…" : "Search Log"}
        </button>
      </div>

      {/* Verify all / summary */}
      {entries && entries.length > 0 && (
        <div className="flex items-center gap-2">
          <button
            onClick={verifyAll}
            disabled={verifyingAll}
            className="flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-xl border border-border hover:border-gold/40 transition"
          >
            {verifyingAll ? <Loader2 className="size-3.5 animate-spin" /> : <Shield className="size-3.5" />}
            Verify All {entries.length} hashes
          </button>
          {allOk && (
            <span className="flex items-center gap-1 text-xs text-green-400 font-bold">
              <CheckCircle2 className="size-3.5" /> All {Object.keys(allVerifyResults).length} entries intact
            </span>
          )}
          {anyFail && (
            <span className="flex items-center gap-1 text-xs text-red-400 font-bold">
              <XCircle className="size-3.5" /> {Object.values(allVerifyResults).filter(v => !v).length} TAMPERED
            </span>
          )}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 text-xs text-red-400 font-bold">
          {error}
        </div>
      )}

      {/* Results */}
      {entries && (
        entries.length === 0 ? (
          <div className="text-center py-8">
            <p className="text-muted-foreground text-sm">No entries found</p>
          </div>
        ) : (
          <div className="space-y-1.5">
            {entries.map(e => (
              <div key={e.id} className={
                allVerifyResults[e.id] === true  ? "ring-1 ring-green-500/30 rounded-xl" :
                allVerifyResults[e.id] === false ? "ring-1 ring-red-500/50 rounded-xl"   : ""
              }>
                <EntryRow entry={e} />
              </div>
            ))}
          </div>
        )
      )}

      {!entries && !loading && (
        <div className="text-center py-12 text-muted-foreground text-xs">
          Enter filters above and click <b>Search Log</b> to query the audit ledger.
        </div>
      )}
    </div>
  );
}

// ─── Disputes Tab ─────────────────────────────────────────────────────────────
function DisputesTab() {
  const [verdict, setVerdict] = useState("");
  const [disputes, setDisputes] = useState<DisputeRow[] | null>(null);
  const [loading, setLoading]  = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await queryDisputes({
        data: { verdict: verdict || undefined, limit: 50 },
      }) as { disputes: DisputeRow[] };
      setDisputes(res.disputes);
    } catch {
      setDisputes([]);
    } finally {
      setLoading(false);
    }
  }, [verdict]);

  return (
    <div className="space-y-4">
      {/* Filter */}
      <div className="bg-card border border-border/60 rounded-2xl p-4 space-y-3">
        <p className="text-xs font-extrabold text-muted-foreground uppercase tracking-wider">Filter Disputes</p>
        <select
          value={verdict}
          onChange={e => setVerdict(e.target.value)}
          className="w-full bg-secondary border border-border/60 rounded-xl px-3 py-2 text-xs outline-none focus:border-gold/40"
        >
          <option value="">All verdicts</option>
          <option value="pending">Pending</option>
          <option value="fraud_confirmed">Fraud Confirmed</option>
          <option value="inconclusive">Inconclusive</option>
          <option value="system_error">System Error</option>
          <option value="cleared">Cleared</option>
        </select>
        <button
          onClick={load}
          disabled={loading}
          className="w-full flex items-center justify-center gap-2 bg-gradient-gold text-jungle-deep font-extrabold text-sm py-2.5 rounded-xl"
        >
          {loading ? <Loader2 className="size-4 animate-spin" /> : <AlertTriangle className="size-4" />}
          {loading ? "Loading…" : "Load Disputes"}
        </button>
      </div>

      {/* Dispute cards */}
      {disputes?.map(d => {
        const isOpen = expanded === d.id;
        const vc = VERDICT_COLORS[d.verdict] ?? "text-muted-foreground bg-secondary border-border";
        const vendorName = d.vendors?.business_name ?? short(d.vendor_id);

        return (
          <div key={d.id} className="bg-card border border-border/60 rounded-2xl overflow-hidden">
            <button
              onClick={() => setExpanded(isOpen ? null : d.id)}
              className="w-full px-4 py-3 flex items-start gap-3 text-left hover:bg-secondary/30 transition"
            >
              <AlertTriangle className={`size-4 mt-0.5 shrink-0 ${d.verdict === 'fraud_confirmed' ? 'text-red-400' : 'text-yellow-400'}`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-sm font-extrabold">{vendorName}</p>
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${vc}`}>
                    {d.verdict.replace(/_/g, " ").toUpperCase()}
                  </span>
                  {d.auto_actioned && (
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border border-orange-500/30 text-orange-400 bg-orange-500/10">
                      AUTO-ACTIONED
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5 truncate">{d.failure_reason}</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">{fmtTs(d.created_at)}</p>
              </div>
              {isOpen ? <ChevronUp className="size-4 text-muted-foreground shrink-0" /> : <ChevronDown className="size-4 text-muted-foreground shrink-0" />}
            </button>

            {isOpen && (
              <div className="border-t border-border/50 px-4 py-3 space-y-3 text-xs">
                {/* Timestamps axis */}
                <div>
                  <p className="font-bold text-muted-foreground mb-2 uppercase tracking-wider text-[10px]">Timestamp Axis (ms precision)</p>
                  <div className="space-y-1.5">
                    {d.t_exposure_ms != null && (
                      <div className="flex items-center gap-2">
                        <Eye className="size-3 text-yellow-400 shrink-0" />
                        <span className="text-muted-foreground">T_Exposure:</span>
                        <span className="font-mono">{fmtMs(d.t_exposure_ms)}</span>
                      </div>
                    )}
                    {d.t_redeemed_ms != null && (
                      <div className="flex items-center gap-2">
                        <CheckCircle2 className="size-3 text-green-400 shrink-0" />
                        <span className="text-muted-foreground">T_Redeemed:</span>
                        <span className="font-mono">{fmtMs(d.t_redeemed_ms)}</span>
                      </div>
                    )}
                    {d.t_audit_ms != null && (
                      <div className="flex items-center gap-2">
                        <Clock className="size-3 text-blue-400 shrink-0" />
                        <span className="text-muted-foreground">T_Audit:</span>
                        <span className="font-mono">{fmtMs(d.t_audit_ms)}</span>
                      </div>
                    )}
                    {d.t_exposure_ms != null && d.t_redeemed_ms != null && (
                      <div className="mt-1 px-2 py-1 bg-secondary rounded-lg">
                        <span className="text-muted-foreground">Δ Exposure→Redeemed: </span>
                        <span className={`font-bold ${d.t_redeemed_ms >= d.t_exposure_ms ? "text-red-400" : "text-green-400"}`}>
                          {d.t_redeemed_ms >= d.t_exposure_ms
                            ? `+${((d.t_redeemed_ms - d.t_exposure_ms) / 1000).toFixed(1)}s AFTER exposure`
                            : `${((d.t_exposure_ms - d.t_redeemed_ms) / 1000).toFixed(1)}s BEFORE exposure (cleared)`}
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Enforcement */}
                {(d.deposit_forfeited_ngn > 0 || d.auto_suspended) && (
                  <div>
                    <p className="font-bold text-muted-foreground mb-2 uppercase tracking-wider text-[10px]">Enforcement</p>
                    <div className="space-y-1">
                      {d.deposit_forfeited_ngn > 0 && (
                        <p>💰 Deposit forfeited: <b>₦{Number(d.deposit_forfeited_ngn).toLocaleString("en-NG")}</b></p>
                      )}
                      {d.auto_suspended && (
                        <p className="text-red-400">🚫 Vendor auto-suspended</p>
                      )}
                      {d.verdict_at && (
                        <p className="text-muted-foreground">Verdict at: {fmtTs(d.verdict_at)}</p>
                      )}
                    </div>
                  </div>
                )}

                {/* IDs */}
                <div className="grid grid-cols-2 gap-2 text-[10px]">
                  <div>
                    <p className="font-bold text-muted-foreground">Dispute ID</p>
                    <p className="font-mono break-all">{d.id}</p>
                  </div>
                  {d.trade_id && (
                    <div>
                      <p className="font-bold text-muted-foreground">Trade ID</p>
                      <p className="font-mono break-all">{d.trade_id}</p>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}

      {disputes?.length === 0 && (
        <div className="text-center py-8 text-muted-foreground text-sm">No disputes found</div>
      )}

      {!disputes && !loading && (
        <div className="text-center py-12 text-muted-foreground text-xs">
          Select a verdict filter and click <b>Load Disputes</b>.
        </div>
      )}
    </div>
  );
}

// ─── Main AuditLogViewer Component ───────────────────────────────────────────
type ViewerTab = "log" | "disputes";

export function AuditLogViewer() {
  const [viewTab, setViewTab] = useState<ViewerTab>("log");

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="size-9 rounded-xl bg-gradient-gold grid place-items-center shrink-0">
          <Shield className="size-5 text-jungle-deep" />
        </div>
        <div>
          <h2 className="text-sm font-extrabold">Immutable Truth Engine</h2>
          <p className="text-[10px] text-muted-foreground">SHA-256 verified · append-only · tamper-evident</p>
        </div>
      </div>

      {/* Tab switcher */}
      <div className="flex bg-secondary rounded-xl p-1 gap-1">
        <button
          onClick={() => setViewTab("log")}
          className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-bold transition ${
            viewTab === "log" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"
          }`}
        >
          <Link2 className="size-3.5" /> Audit Log
        </button>
        <button
          onClick={() => setViewTab("disputes")}
          className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-bold transition ${
            viewTab === "disputes" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"
          }`}
        >
          <AlertTriangle className="size-3.5" /> Disputes
        </button>
      </div>

      {viewTab === "log"      && <AuditLogTab />}
      {viewTab === "disputes" && <DisputesTab />}
    </div>
  );
}
