-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 032: WalletService support — decrement RPC, lock/unlock RPCs,
--   user withdrawal requests table, wallet_ledger enrichment columns,
--   and wallet stats view.
--
-- Safe to re-run (idempotent). All objects use IF NOT EXISTS / CREATE OR REPLACE.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── 1. Enrich wallet_ledger with context columns ─────────────────────────────
-- These columns allow WalletService to store the "why" of every balance change.
ALTER TABLE wallet_ledger
  ADD COLUMN IF NOT EXISTS ref_id          TEXT,
  ADD COLUMN IF NOT EXISTS description     TEXT,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

-- Unique partial index: prevents duplicate WalletService operations.
-- Null keys are excluded so legacy trigger-written rows don't conflict.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_ledger_idempotency
  ON wallet_ledger (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ─── 2. decrement_wallet_balance RPC ─────────────────────────────────────────
-- Mirrors increment_wallet_balance. Raises an exception if funds are insufficient.
-- Triggers trg_wallet_balance_change to write a basic ledger row.
CREATE OR REPLACE FUNCTION decrement_wallet_balance(
  p_user_id  UUID,
  p_currency TEXT,
  p_amount   NUMERIC
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  current_balance NUMERIC;
BEGIN
  SELECT balance INTO current_balance
  FROM wallets
  WHERE user_id = p_user_id AND currency = p_currency
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Wallet not found for user % currency %', p_user_id, p_currency;
  END IF;

  IF current_balance < p_amount THEN
    RAISE EXCEPTION 'Insufficient balance. Available: % requested: %', current_balance, p_amount;
  END IF;

  UPDATE wallets
  SET balance = balance - p_amount, updated_at = now()
  WHERE user_id = p_user_id AND currency = p_currency;
END;
$$;

-- ─── 3. lock_wallet_for_withdrawal RPC ───────────────────────────────────────
-- Moves amount from balance → locked_balance atomically.
-- The user cannot spend locked funds; they are returned if withdrawal fails.
CREATE OR REPLACE FUNCTION lock_wallet_for_withdrawal(
  p_user_id UUID,
  p_amount  NUMERIC
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  current_balance NUMERIC;
BEGIN
  SELECT balance INTO current_balance
  FROM wallets
  WHERE user_id = p_user_id AND currency = 'NGN'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NGN wallet not found for user %', p_user_id;
  END IF;

  IF current_balance < p_amount THEN
    RAISE EXCEPTION 'Insufficient balance for withdrawal lock. Available: %, requested: %',
      current_balance, p_amount;
  END IF;

  UPDATE wallets
  SET
    balance        = balance - p_amount,
    locked_balance = COALESCE(locked_balance, 0) + p_amount,
    updated_at     = now()
  WHERE user_id = p_user_id AND currency = 'NGN';
END;
$$;

-- ─── 4. unlock_wallet_withdrawal RPC ─────────────────────────────────────────
-- Finalises a withdrawal lock.
--   p_completed = TRUE  → deduct from locked_balance (withdrawal succeeded)
--   p_completed = FALSE → restore locked_balance → available balance (refund)
CREATE OR REPLACE FUNCTION unlock_wallet_withdrawal(
  p_user_id   UUID,
  p_amount    NUMERIC,
  p_completed BOOLEAN
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF p_completed THEN
    -- Permanently remove from locked_balance (money left the platform)
    UPDATE wallets
    SET
      locked_balance = GREATEST(0, COALESCE(locked_balance, 0) - p_amount),
      updated_at     = now()
    WHERE user_id = p_user_id AND currency = 'NGN';
  ELSE
    -- Refund: move back from locked → available
    UPDATE wallets
    SET
      balance        = balance + p_amount,
      locked_balance = GREATEST(0, COALESCE(locked_balance, 0) - p_amount),
      updated_at     = now()
    WHERE user_id = p_user_id AND currency = 'NGN';
  END IF;
END;
$$;

-- ─── 5. user_withdrawal_requests table ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_withdrawal_requests (
  id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID          NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Amount breakdown
  amount_ngn        NUMERIC(18,2) NOT NULL CHECK (amount_ngn > 0),
  platform_fee_ngn  NUMERIC(18,2) NOT NULL DEFAULT 0,
  provider_fee_ngn  NUMERIC(18,2) NOT NULL DEFAULT 0,
  net_amount_ngn    NUMERIC(18,2) NOT NULL CHECK (net_amount_ngn > 0),

  -- Bank details (snapshotted at request time)
  bank_name         TEXT          NOT NULL,
  bank_code         TEXT          NOT NULL,
  account_number    TEXT          NOT NULL,
  account_name      TEXT          NOT NULL,
  payout_account_id UUID,

  -- Lifecycle status
  -- submitted → under_review → queued → processing → provider_processing
  -- → provider_confirmed → completed | failed | cancelled | reversed
  status            TEXT          NOT NULL DEFAULT 'submitted'
    CHECK (status IN (
      'submitted','under_review','queued','processing',
      'provider_processing','provider_confirmed',
      'completed','failed','cancelled','reversed'
    )),

  -- Provider tracking
  provider          TEXT,         -- 'squad' | 'paystack' | 'flutterwave'
  provider_ref      TEXT,         -- provider's transaction reference
  provider_response JSONB,        -- raw provider response for audit

  -- Failure info
  failure_reason    TEXT,
  retry_count       INTEGER       NOT NULL DEFAULT 0,

  -- Timing
  estimated_arrival TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  failed_at         TIMESTAMPTZ,

  -- Traceability
  idempotency_key   TEXT          UNIQUE,
  trace_id          TEXT          UNIQUE NOT NULL DEFAULT gen_random_uuid()::TEXT,
  support_ref       TEXT          UNIQUE NOT NULL DEFAULT
    upper(substring(gen_random_uuid()::TEXT FROM 1 FOR 8)),

  created_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- Only one active withdrawal per user at a time
CREATE UNIQUE INDEX IF NOT EXISTS idx_uwr_one_active_per_user
  ON user_withdrawal_requests (user_id)
  WHERE status IN (
    'submitted','under_review','queued','processing','provider_processing','provider_confirmed'
  );

CREATE INDEX IF NOT EXISTS idx_uwr_user_created
  ON user_withdrawal_requests (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_uwr_provider_ref
  ON user_withdrawal_requests (provider_ref)
  WHERE provider_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_uwr_status
  ON user_withdrawal_requests (status);

ALTER TABLE user_withdrawal_requests ENABLE ROW LEVEL SECURITY;

-- Users can only read their own withdrawal requests
CREATE POLICY "uwr_owner_read" ON user_withdrawal_requests
  FOR SELECT USING (auth.uid() = user_id);

-- Only service role (server functions) can insert/update
-- No client INSERT policy — requests are created server-side only.

-- ─── 6. v_user_wallet_stats view ─────────────────────────────────────────────
-- Lifetime wallet statistics derived from the ledger.
CREATE OR REPLACE VIEW v_user_wallet_stats AS
SELECT
  user_id,
  SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END)                         AS lifetime_credits_ngn,
  SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END)                    AS lifetime_debits_ngn,
  SUM(CASE WHEN ref_type = 'withdrawal' AND amount < 0 THEN ABS(amount) ELSE 0 END) AS total_withdrawn_ngn,
  SUM(CASE WHEN ref_type = 'referral_commission' AND amount > 0 THEN amount ELSE 0 END) AS referral_earnings_ngn,
  SUM(CASE WHEN ref_type = 'weekly_commission' AND amount > 0 THEN amount ELSE 0 END)   AS bonus_earnings_ngn
FROM wallet_ledger
WHERE currency = 'NGN'
GROUP BY user_id;

-- ─── 7. Auto-update updated_at on user_withdrawal_requests ───────────────────
CREATE OR REPLACE FUNCTION fn_uwr_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_uwr_updated_at ON user_withdrawal_requests;
CREATE TRIGGER trg_uwr_updated_at
  BEFORE UPDATE ON user_withdrawal_requests
  FOR EACH ROW EXECUTE FUNCTION fn_uwr_updated_at();
