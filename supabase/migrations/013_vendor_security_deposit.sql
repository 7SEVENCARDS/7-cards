-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 013: Vendor Security Deposit & Strike System
--
-- Goal: make it very hard for vendors to rip off users.
--   1. Vendors optionally (or mandatorily, set per-vendor by admin) post a
--      security deposit funded from their wallet balance.  It is held as a
--      locked amount and forfeited on assignment failures.
--   2. Every assignment failure increments a consecutive-failure counter.
--      At the threshold (default 3 consecutive failures) the vendor is
--      auto-suspended immediately — no admin action required.
--   3. On reactivation the consecutive counter resets; a clean redemption
--      streak also resets it.
--   4. All deposit movements are recorded as vendor_transactions rows so the
--      audit trail is complete.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── New columns on vendors ───────────────────────────────────────────────────

ALTER TABLE vendors
  ADD COLUMN IF NOT EXISTS security_deposit_required NUMERIC(15,2) NOT NULL DEFAULT 0
    CHECK (security_deposit_required >= 0),
  ADD COLUMN IF NOT EXISTS security_deposit_held     NUMERIC(15,2) NOT NULL DEFAULT 0
    CHECK (security_deposit_held >= 0),
  ADD COLUMN IF NOT EXISTS failed_assignments        INTEGER       NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS consecutive_failures      INTEGER       NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_failure_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS suspension_reason         TEXT;

-- ─── Widen vendor_transactions.type ──────────────────────────────────────────

ALTER TABLE vendor_transactions
  DROP CONSTRAINT IF EXISTS vendor_transactions_type_check;

ALTER TABLE vendor_transactions
  ADD CONSTRAINT vendor_transactions_type_check
    CHECK (type IN (
      'credit',
      'debit',
      'assignment_credit',
      'withdrawal',
      'referral_bonus',
      'security_deposit',
      'security_deposit_forfeit',
      'security_deposit_refund'
    ));

-- ─── RPC: record_vendor_failure ───────────────────────────────────────────────
-- Increments failure counters and auto-suspends if threshold is reached.
-- Returns a JSON object describing the outcome so the caller can notify
-- the vendor without a second round-trip.
--
-- The threshold is hard-coded to 3 consecutive failures.  Reactivation by
-- an admin resets the counter via record_vendor_success or direct UPDATE.

CREATE OR REPLACE FUNCTION record_vendor_failure(
  p_vendor_id UUID
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_consecutive        INTEGER;
  v_deposit_held       NUMERIC;
  v_auto_suspended     BOOLEAN := FALSE;
  v_suspension_reason  TEXT;
  v_threshold CONSTANT INTEGER := 3;
BEGIN
  UPDATE vendors
     SET failed_assignments   = failed_assignments   + 1,
         consecutive_failures = consecutive_failures + 1,
         last_failure_at      = now(),
         updated_at           = now()
   WHERE id = p_vendor_id
  RETURNING consecutive_failures, security_deposit_held
       INTO v_consecutive, v_deposit_held;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Vendor not found: %', p_vendor_id;
  END IF;

  -- Auto-suspend when consecutive failures hit the threshold
  IF v_consecutive >= v_threshold THEN
    v_suspension_reason := format(
      'Auto-suspended: %s consecutive failed assignments (threshold: %s)',
      v_consecutive, v_threshold
    );
    UPDATE vendors
       SET status           = 'suspended',
           suspension_reason = v_suspension_reason,
           updated_at        = now()
     WHERE id = p_vendor_id
       AND status = 'active';

    v_auto_suspended := TRUE;
  END IF;

  RETURN json_build_object(
    'consecutive_failures', v_consecutive,
    'threshold',            v_threshold,
    'auto_suspended',       v_auto_suspended,
    'suspension_reason',    v_suspension_reason,
    'deposit_held',         v_deposit_held
  );
END;
$$;

-- ─── RPC: record_vendor_success ───────────────────────────────────────────────
-- Resets the consecutive-failure counter after a successful redemption.

CREATE OR REPLACE FUNCTION record_vendor_success(
  p_vendor_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE vendors
     SET consecutive_failures = 0,
         last_active_at       = now(),
         updated_at           = now()
   WHERE id = p_vendor_id;
END;
$$;

-- ─── RPC: lock_vendor_security_deposit ───────────────────────────────────────
-- Moves p_amount from the vendor's spendable wallet balance into locked
-- security deposit.  Fails if the balance is insufficient.

CREATE OR REPLACE FUNCTION lock_vendor_security_deposit(
  p_vendor_id UUID,
  p_amount    NUMERIC
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Deposit amount must be positive';
  END IF;

  -- Deduct from spendable balance, add to locked
  UPDATE vendor_wallets
     SET balance    = balance - p_amount,
         locked     = locked  + p_amount,
         updated_at = now()
   WHERE vendor_id  = p_vendor_id
     AND balance   >= p_amount;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Insufficient wallet balance for security deposit (need ₦%)', p_amount;
  END IF;

  -- Track how much of the locked amount is earmarked as security deposit
  UPDATE vendors
     SET security_deposit_held = security_deposit_held + p_amount,
         updated_at            = now()
   WHERE id = p_vendor_id;
END;
$$;

-- ─── RPC: forfeit_vendor_security_deposit ────────────────────────────────────
-- Removes up to p_amount from the locked security deposit.
-- The forfeited funds leave the vendor's balance entirely (retained by 7SEVEN
-- as compensation).  Capped at the actual deposit held.

CREATE OR REPLACE FUNCTION forfeit_vendor_security_deposit(
  p_vendor_id  UUID,
  p_amount     NUMERIC
)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_held    NUMERIC;
  v_forfeit NUMERIC;
BEGIN
  SELECT security_deposit_held INTO v_held
    FROM vendors WHERE id = p_vendor_id FOR UPDATE;

  v_forfeit := LEAST(p_amount, COALESCE(v_held, 0));

  IF v_forfeit <= 0 THEN
    RETURN 0;
  END IF;

  -- Shrink the locked bucket (funds exit the wallet entirely)
  UPDATE vendor_wallets
     SET locked     = GREATEST(0, locked - v_forfeit),
         updated_at = now()
   WHERE vendor_id  = p_vendor_id;

  -- Shrink the deposit tracker on vendor
  UPDATE vendors
     SET security_deposit_held = GREATEST(0, security_deposit_held - v_forfeit),
         updated_at            = now()
   WHERE id = p_vendor_id;

  RETURN v_forfeit;
END;
$$;

-- ─── RPC: release_vendor_security_deposit ────────────────────────────────────
-- Moves p_amount back from locked security deposit into spendable balance.
-- Used by admin when a vendor is in good standing and no longer needs to hold
-- the deposit (e.g., vendor is retiring, or admin is refunding).

CREATE OR REPLACE FUNCTION release_vendor_security_deposit(
  p_vendor_id UUID,
  p_amount    NUMERIC
)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_held    NUMERIC;
  v_release NUMERIC;
BEGIN
  SELECT security_deposit_held INTO v_held
    FROM vendors WHERE id = p_vendor_id FOR UPDATE;

  v_release := LEAST(p_amount, COALESCE(v_held, 0));

  IF v_release <= 0 THEN
    RETURN 0;
  END IF;

  -- Move from locked back to spendable balance
  UPDATE vendor_wallets
     SET balance    = balance   + v_release,
         locked     = GREATEST(0, locked - v_release),
         updated_at = now()
   WHERE vendor_id  = p_vendor_id;

  UPDATE vendors
     SET security_deposit_held = GREATEST(0, security_deposit_held - v_release),
         updated_at            = now()
   WHERE id = p_vendor_id;

  RETURN v_release;
END;
$$;

-- ─── Indexes ──────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_vendors_consecutive_failures
  ON vendors (consecutive_failures DESC)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_vendors_deposit_gap
  ON vendors (security_deposit_required, security_deposit_held)
  WHERE status = 'active';
