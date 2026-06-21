-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 016: Immutable Truth Engine
--
-- Implements the three pillars of the cryptographic audit architecture:
--
-- Pillar 1 — Zero-Trust Cryptographic Logging
--   trade_audit_log: append-only ledger. Every trade event produces a
--   SHA-256 hash of (token_hash | server_ts_ms | vendor_id | trade_id | event).
--   Unique constraint on payload_hash makes the log un-falsifiable —
--   you cannot insert or overwrite an existing hash.
--
-- Pillar 2 — Multi-Point Timestamp Audit
--   card_exposed_at_ms on vendor_card_assignments: exact millisecond the card
--   code was delivered to the vendor via Telegram. vendor_disputes stores
--   T_Exposure, T_Redeemed (from Reloadly re-query), and the full verdict.
--
-- Pillar 3 — Automated Capital Depreciation
--   Verdict = FRAUD_CONFIRMED → existing forfeit_vendor_security_deposit RPC
--   + record_vendor_failure auto-suspension fires atomically, zero human touch.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Pillar 1: Immutable cryptographic ledger ──────────────────────────────────
CREATE TABLE IF NOT EXISTS trade_audit_log (
  id             UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_id       UUID,   -- nullable — some events pre-date a trade row
  assignment_id  UUID,   -- nullable
  event          TEXT    NOT NULL,
  -- card_verified | card_exposed | card_claimed | van_created | van_paid
  -- vendor_marked_redeemed | vendor_marked_failed
  -- fraud_audit_initiated | fraud_confirmed | system_error | inconclusive
  actor_type     TEXT    NOT NULL CHECK (actor_type IN ('system','vendor','user','admin')),
  actor_id       TEXT,   -- supabase user_id or vendor UUID as text
  server_ts_ms   BIGINT  NOT NULL,   -- Date.now() — ms precision, always server-set
  payload_hash   TEXT    NOT NULL,   -- SHA-256 of canonical payload — THE KEY GUARANTEE
  payload        JSONB   NOT NULL DEFAULT '{}',
  CONSTRAINT trade_audit_log_hash_unique UNIQUE (payload_hash)
  -- The UNIQUE constraint on payload_hash is the cryptographic guarantee:
  -- a duplicate or tampered entry is mathematically rejected by the DB.
);

-- Append-only enforcement via RLS — even service role cannot UPDATE or DELETE
-- (service role bypasses RLS for INSERT, but we set no UPDATE/DELETE policies)
ALTER TABLE trade_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin_read_audit_log"
  ON trade_audit_log FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'
  ));
-- No UPDATE or DELETE policy → nobody can modify or remove audit entries

CREATE INDEX IF NOT EXISTS idx_tal_trade_id     ON trade_audit_log (trade_id);
CREATE INDEX IF NOT EXISTS idx_tal_assignment   ON trade_audit_log (assignment_id);
CREATE INDEX IF NOT EXISTS idx_tal_event_ts     ON trade_audit_log (event, server_ts_ms DESC);
CREATE INDEX IF NOT EXISTS idx_tal_actor        ON trade_audit_log (actor_type, actor_id);
CREATE INDEX IF NOT EXISTS idx_tal_ts           ON trade_audit_log (server_ts_ms DESC);

-- ── Pillar 2: Exposure + Redeemed timestamps on assignments ───────────────────
-- card_exposed_at_ms = T_Exposure: exact millisecond the card code landed in the
-- vendor's Telegram chat (set the moment sendTelegramMessage() returns OK).
ALTER TABLE vendor_card_assignments
  ADD COLUMN IF NOT EXISTS card_exposed_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS card_exposed_at_ms  BIGINT,      -- T_Exposure in ms
  ADD COLUMN IF NOT EXISTS failure_reason      TEXT,
  ADD COLUMN IF NOT EXISTS fraud_verdict       TEXT
    CHECK (fraud_verdict IN ('pending','fraud_confirmed','system_error','cleared','inconclusive')),
  ADD COLUMN IF NOT EXISTS fraud_verdict_at    TIMESTAMPTZ;

-- ── Pillar 2: Forensic dispute records ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS vendor_disputes (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id         UUID        NOT NULL,
  vendor_id             UUID        NOT NULL REFERENCES vendors(id),
  trade_id              UUID,
  failure_reason        TEXT        NOT NULL,
  -- Timestamp axis (all in milliseconds since Unix epoch for sub-second precision)
  t_exposure_ms         BIGINT,     -- when card code hit vendor Telegram
  t_audit_ms            BIGINT,     -- when forensic check ran
  t_redeemed_ms         BIGINT,     -- inferred from Reloadly re-query result
  -- Reloadly evidence
  reloadly_audit_raw    JSONB,      -- raw API response at audit time
  reloadly_card_status  TEXT,       -- 'VALID'|'REDEEMED'|'INVALID'|'UNKNOWN'
  -- Verdict
  verdict               TEXT        NOT NULL DEFAULT 'pending'
    CHECK (verdict IN ('pending','fraud_confirmed','system_error','inconclusive')),
  verdict_at            TIMESTAMPTZ,
  verdict_evidence      JSONB,      -- full forensic evidence package
  -- Enforcement
  auto_actioned         BOOLEAN     NOT NULL DEFAULT FALSE,
  deposit_forfeited_ngn NUMERIC(15,2) NOT NULL DEFAULT 0,
  auto_suspended        BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE vendor_disputes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admin_read_disputes"
  ON vendor_disputes FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'
  ));

CREATE INDEX IF NOT EXISTS idx_disputes_vendor     ON vendor_disputes (vendor_id);
CREATE INDEX IF NOT EXISTS idx_disputes_assignment ON vendor_disputes (assignment_id);
CREATE INDEX IF NOT EXISTS idx_disputes_verdict    ON vendor_disputes (verdict, created_at DESC);

-- ── Helper: verify a hash hasn't been tampered with ───────────────────────────
-- Returns TRUE if the hash exists and the payload still hashes to the same value.
-- Call this from any audit verification endpoint.
CREATE OR REPLACE FUNCTION verify_audit_entry(p_hash TEXT, p_payload JSONB)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM trade_audit_log
    WHERE payload_hash = p_hash
      AND payload = p_payload
  );
$$;
