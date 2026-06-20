-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 007: Crypto Wallet Operations
-- Idempotent — safe to run multiple times.
-- Adds:
--   1. payout_method column on trades (bank | wallet)
--   2. crypto_transactions table
--   3. deduct_wallet_balance() RPC
--   4. wallets unique constraint (required for row locking)
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── 1. payout_method on trades ──────────────────────────────────────────────
ALTER TABLE trades ADD COLUMN IF NOT EXISTS payout_method TEXT DEFAULT 'bank';

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_name = 'trades_payout_method_check'
  ) THEN
    ALTER TABLE trades
      ADD CONSTRAINT trades_payout_method_check
        CHECK (payout_method IN ('bank', 'wallet'));
  END IF;
END $$;

-- ─── 2. crypto_transactions ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crypto_transactions (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID         NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  type          TEXT         NOT NULL CHECK (type IN ('swap', 'send', 'receive', 'convert')),
  from_currency TEXT,
  to_currency   TEXT,
  from_amount   NUMERIC(28, 10),
  to_amount     NUMERIC(28, 10),
  address       TEXT,
  tx_ref        TEXT,
  status        TEXT         NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'completed', 'failed')),
  meta          JSONB,
  created_at    TIMESTAMPTZ  DEFAULT now()
);

ALTER TABLE crypto_transactions ENABLE ROW LEVEL SECURITY;

DO $pol$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'crypto_transactions'
      AND policyname = 'Users can view own crypto txs'
  ) THEN
    CREATE POLICY "Users can view own crypto txs"
      ON crypto_transactions FOR SELECT
      USING (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'crypto_transactions'
      AND policyname = 'Admins can view all crypto txs'
  ) THEN
    CREATE POLICY "Admins can view all crypto txs"
      ON crypto_transactions FOR SELECT
      USING (
        EXISTS (
          SELECT 1 FROM profiles
          WHERE profiles.id = auth.uid()
            AND profiles.role = 'admin'
        )
      );
  END IF;
END $pol$;

CREATE INDEX IF NOT EXISTS idx_crypto_txs_user
  ON crypto_transactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crypto_txs_ref
  ON crypto_transactions(tx_ref)
  WHERE tx_ref IS NOT NULL;

-- ─── 3. deduct_wallet_balance() ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION deduct_wallet_balance(
  p_user_id  UUID,
  p_currency TEXT,
  p_amount   NUMERIC
) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE
  current_balance NUMERIC;
BEGIN
  SELECT balance INTO current_balance
  FROM wallets
  WHERE user_id = p_user_id AND currency = p_currency
  FOR UPDATE;

  IF current_balance IS NULL OR current_balance < p_amount THEN
    RETURN FALSE;
  END IF;

  UPDATE wallets
  SET balance = balance - p_amount
  WHERE user_id = p_user_id AND currency = p_currency;

  RETURN TRUE;
END;
$$;

-- ─── 4. Unique constraint on wallets ─────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'wallets'
      AND constraint_name = 'wallets_user_currency_unique'
  ) THEN
    ALTER TABLE wallets
      ADD CONSTRAINT wallets_user_currency_unique UNIQUE (user_id, currency);
  END IF;
END $$;
