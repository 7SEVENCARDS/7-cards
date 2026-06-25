-- ─────────────────────────────────────────────────────────────────────────────
-- Production Safety Layer — Migration
--
-- Creates:
--   financial_locks          — distributed lock table (kill duplicate payouts)
--   fraud_reserve_events     — immutable ledger for fraud reserve
--   fraud_reserve_balance    — single-row materialized balance
--   backup_verification_log  — history of backup health checks
--
-- Seeds:
--   feature_flags rows for all 6 kill switches (all OFF by default)
--
-- RLS: all tables are admin-only (service role) or via RLS policies below.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Distributed Financial Locks ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS financial_locks (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lock_key   TEXT NOT NULL UNIQUE,
  locked_by  TEXT NOT NULL,
  locked_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS financial_locks_expires_at_idx ON financial_locks (expires_at);

ALTER TABLE financial_locks ENABLE ROW LEVEL SECURITY;
-- Only service-role can access (server-side only)
CREATE POLICY "service_only_locks" ON financial_locks
  USING (false) WITH CHECK (false);

-- ── 2. Fraud Reserve Events ledger ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fraud_reserve_events (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  type              TEXT        NOT NULL CHECK (type IN ('debit', 'credit')),
  amount_ngn        NUMERIC     NOT NULL CHECK (amount_ngn > 0),
  reason            TEXT        NOT NULL,
  reference         TEXT,
  admin_id          UUID,
  balance_after_ngn NUMERIC     NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fraud_reserve_events_created_at_idx ON fraud_reserve_events (created_at DESC);
CREATE INDEX IF NOT EXISTS fraud_reserve_events_type_idx        ON fraud_reserve_events (type);

ALTER TABLE fraud_reserve_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_only_reserve_events" ON fraud_reserve_events
  USING (false) WITH CHECK (false);

-- ── 3. Fraud Reserve Balance (single materialized row) ────────────────────────
CREATE TABLE IF NOT EXISTS fraud_reserve_balance (
  id          INT  PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  balance_ngn NUMERIC NOT NULL DEFAULT 0 CHECK (balance_ngn >= 0),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO fraud_reserve_balance (id, balance_ngn)
VALUES (1, 0)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE fraud_reserve_balance ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_only_reserve_balance" ON fraud_reserve_balance
  USING (false) WITH CHECK (false);

-- Atomic adjust function (called from fraud-reserve.ts)
CREATE OR REPLACE FUNCTION adjust_fraud_reserve(p_delta NUMERIC)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_new NUMERIC;
BEGIN
  UPDATE fraud_reserve_balance
  SET
    balance_ngn = GREATEST(0, balance_ngn + p_delta),
    updated_at  = now()
  WHERE id = 1
  RETURNING balance_ngn INTO v_new;

  IF v_new IS NULL THEN
    INSERT INTO fraud_reserve_balance (id, balance_ngn)
    VALUES (1, GREATEST(0, p_delta))
    ON CONFLICT (id) DO UPDATE
    SET balance_ngn = GREATEST(0, fraud_reserve_balance.balance_ngn + p_delta),
        updated_at  = now()
    RETURNING balance_ngn INTO v_new;
  END IF;

  RETURN v_new;
END;
$$;

-- ── 4. Backup Verification Log ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS backup_verification_log (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  ok             BOOLEAN     NOT NULL,
  checked_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  backup_status  TEXT        NOT NULL DEFAULT 'unknown',
  last_backup_at TIMESTAMPTZ,
  sanity_ok      BOOLEAN     NOT NULL DEFAULT false,
  sanity_details TEXT,
  alert_fired    BOOLEAN     NOT NULL DEFAULT false,
  error_message  TEXT
);

CREATE INDEX IF NOT EXISTS backup_verification_log_checked_at_idx ON backup_verification_log (checked_at DESC);

ALTER TABLE backup_verification_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_only_backup_log" ON backup_verification_log
  USING (false) WITH CHECK (false);

-- ── 5. Seed Kill Switch Feature Flags (all OFF by default) ────────────────────
-- Kill switches re-use the existing feature_flags table.
-- When enabled=true the switch is THROWN (system is frozen).
INSERT INTO feature_flags (key, enabled, description, rollout_pct, metadata)
VALUES
  ('kill_switch_treasury',          false, 'Freeze all treasury-funded card buys',    100, '{"is_kill_switch": true}'),
  ('kill_switch_withdrawals',       false, 'Freeze all user withdrawal payouts',       100, '{"is_kill_switch": true}'),
  ('kill_switch_new_trades',        false, 'Prevent new card trade submissions',       100, '{"is_kill_switch": true}'),
  ('kill_switch_provider_squad',    false, 'Disable Squad payment gateway',            100, '{"is_kill_switch": true}'),
  ('kill_switch_provider_reloadly', false, 'Disable Reloadly gift-card network',       100, '{"is_kill_switch": true}'),
  ('kill_switch_provider_busha',    false, 'Disable Busha crypto gateway',             100, '{"is_kill_switch": true}')
ON CONFLICT (key) DO NOTHING;

-- ── 6. Add updated_by column to feature_flags if not present ─────────────────
ALTER TABLE feature_flags ADD COLUMN IF NOT EXISTS updated_by UUID;
