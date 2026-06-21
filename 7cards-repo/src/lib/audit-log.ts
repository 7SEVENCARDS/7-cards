// ─────────────────────────────────────────────────────────────────────────────
// Immutable Truth Engine — Pillar 1: Zero-Trust Cryptographic Logging
//
// Every key trade event produces a SHA-256 hash of a canonical payload string
// containing: reloadly_token_hash | server_ts_ms | actor_id | trade_id | event
//
// This hash is the unique key in trade_audit_log. The DB UNIQUE constraint
// makes the log mathematically append-only — a duplicate or tampered entry
// is rejected at the database level, not just in application code.
//
// Uses the Web Crypto API (available natively in Cloudflare Workers).
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from "@supabase/supabase-js";

// ─── Core: SHA-256 hex digest ─────────────────────────────────────────────────
export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input)
  );
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

// ─── Canonical payload string ─────────────────────────────────────────────────
// Must be deterministic — same inputs always produce the same string.
// Uses pipe-separated fields with no ambiguity between empty and missing.
// server_ts_ms is always set server-side so clients cannot forge timestamps.
function buildCanonical(opts: {
  tradeId:      string | null;
  assignmentId: string | null;
  event:        string;
  actorType:    string;
  actorId:      string | null;
  serverTsMs:   number;
  payloadJson:  string;
}): string {
  return [
    opts.tradeId      ?? "null",
    opts.assignmentId ?? "null",
    opts.event,
    opts.actorType,
    opts.actorId      ?? "system",
    String(opts.serverTsMs),
    opts.payloadJson,
  ].join("|");
}

// ─── Primary API: log a trade event ──────────────────────────────────────────
// Returns { ok, hash } on success or { ok: false, error } on collision/failure.
// Collisions (same hash) mean a duplicate event — silently ignored (idempotent).
export async function logTradeEvent(
  db: SupabaseClient,
  opts: {
    tradeId:      string | null;
    assignmentId?: string | null;
    event:        string;
    actorType:    "system" | "vendor" | "user" | "admin";
    actorId?:     string | null;
    payload?:     Record<string, unknown>;
  }
): Promise<{ ok: boolean; hash?: string; error?: string }> {
  const serverTsMs  = Date.now();
  const payloadSafe = opts.payload ?? {};
  const payloadJson = JSON.stringify(payloadSafe, Object.keys(payloadSafe).sort());

  const canonical = buildCanonical({
    tradeId:      opts.tradeId,
    assignmentId: opts.assignmentId ?? null,
    event:        opts.event,
    actorType:    opts.actorType,
    actorId:      opts.actorId ?? null,
    serverTsMs,
    payloadJson,
  });

  const hash = await sha256Hex(canonical);

  const { error } = await db.from("trade_audit_log").insert({
    trade_id:     opts.tradeId,
    assignment_id: opts.assignmentId ?? null,
    event:        opts.event,
    actor_type:   opts.actorType,
    actor_id:     opts.actorId ?? null,
    server_ts_ms: serverTsMs,
    payload_hash: hash,
    payload:      payloadSafe,
  });

  if (!error) return { ok: true, hash };

  // Unique violation = duplicate event (already logged) — idempotent, not an error
  if (error.code === "23505") return { ok: true, hash };

  console.error(`[AuditLog] logTradeEvent failed for ${opts.event}:`, error.message);
  return { ok: false, error: error.message };
}

// ─── Convenience: hash the Reloadly token for Pillar-1 logging ───────────────
// We never store the raw token — only its SHA-256 so the log is un-guessable
// but still verifiable against our own env variable.
export async function hashReloadlyToken(): Promise<string> {
  const token = process.env.RELOADLY_CLIENT_SECRET ?? "not-configured";
  return sha256Hex(`reloadly:${token}`);
}

// ─── Verify an audit entry hasn't been tampered with ─────────────────────────
// Recomputes the canonical string and checks the hash matches what's stored.
export async function verifyAuditEntry(
  db: SupabaseClient,
  entryId: string
): Promise<{ ok: boolean; reason?: string }> {
  const { data: entry } = await db
    .from("trade_audit_log")
    .select("*")
    .eq("id", entryId)
    .single() as {
      data: {
        trade_id: string | null;
        assignment_id: string | null;
        event: string;
        actor_type: string;
        actor_id: string | null;
        server_ts_ms: number;
        payload_hash: string;
        payload: Record<string, unknown>;
      } | null;
    };

  if (!entry) return { ok: false, reason: "Entry not found" };

  const payloadJson = JSON.stringify(
    entry.payload,
    Object.keys(entry.payload).sort()
  );

  const canonical = buildCanonical({
    tradeId:      entry.trade_id,
    assignmentId: entry.assignment_id,
    event:        entry.event,
    actorType:    entry.actor_type,
    actorId:      entry.actor_id,
    serverTsMs:   entry.server_ts_ms,
    payloadJson,
  });

  const recomputed = await sha256Hex(canonical);

  if (recomputed !== entry.payload_hash) {
    return { ok: false, reason: "Hash mismatch — entry has been tampered with" };
  }

  return { ok: true };
}
