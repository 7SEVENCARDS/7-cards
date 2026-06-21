-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 012: Atomic Vendor Wallet Operations + Type Constraint Fix
--
-- Mirrors the pattern already used for user wallets in migrations 003 & 007:
--   increment_vendor_wallet_balance / deduct_vendor_wallet_balance use atomic
--   UPDATE … SET balance = balance + p_amount — no read-then-write race under
--   concurrent webhook credits or simultaneous withdrawal requests.
--
-- Also widens vendor_transactions.type to include all values used in app code.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── Widen the type constraint ───────────────────────────────────────────────
ALTER TABLE vendor_transactions
  DROP CONSTRAINT IF EXISTS vendor_transactions_type_check;

ALTER TABLE vendor_transactions
  ADD CONSTRAINT vendor_transactions_type_check
  CHECK (type IN (
    'credit',
    'debit',
    'assignment_credit',
    'withdrawal',
    'referral_bonus'
  ));

-- ─── increment_vendor_wallet_balance ─────────────────────────────────────────
-- Atomically credits a vendor wallet. Upserts the row if missing.
-- SECURITY DEFINER — bypasses RLS so the webhook/admin path can always write.
CREATE OR REPLACE FUNCTION increment_vendor_wallet_balance(
  p_vendor_id UUID,
  p_amount    NUMERIC
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO vendor_wallets (vendor_id, balance, total_funded)
  VALUES (p_vendor_id, p_amount, p_amount)
  ON CONFLICT (vendor_id) DO UPDATE
    SET balance      = vendor_wallets.balance + p_amount,
        total_funded = vendor_wallets.total_funded + p_amount,
        updated_at   = now();
END;
$$;

-- ─── deduct_vendor_wallet_balance ────────────────────────────────────────────
-- Atomically debits a vendor wallet.
-- The CHECK (balance >= 0) constraint on vendor_wallets enforces the floor —
-- this function will raise a constraint-violation error if the balance would
-- go negative, which the caller should surface as an insufficient-funds error.
CREATE OR REPLACE FUNCTION deduct_vendor_wallet_balance(
  p_vendor_id UUID,
  p_amount    NUMERIC
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE vendor_wallets
  SET balance         = balance - p_amount,
      total_withdrawn = total_withdrawn + p_amount,
      updated_at      = now()
  WHERE vendor_id = p_vendor_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'vendor_wallet not found for vendor_id %', p_vendor_id;
  END IF;
END;
$$;
