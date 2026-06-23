-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 029: Wallet Ledger, Reconciliation Views & Vendor Performance Score
-- Safe to re-run (idempotent). All objects use IF NOT EXISTS / CREATE OR REPLACE.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── Part 1: Immutable Wallet Ledger ─────────────────────────────────────────
-- Every wallet balance change produces one append-only ledger row.
-- Written automatically by trigger — no application code changes required.
-- Wallet balances are reconstructable from ledger history alone.

CREATE TABLE IF NOT EXISTS wallet_ledger (
  id             UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID          NOT NULL,
  currency       TEXT          NOT NULL,
  amount         NUMERIC(18,8) NOT NULL,        -- positive = credit, negative = debit
  balance_before NUMERIC(18,8) NOT NULL,
  balance_after  NUMERIC(18,8) NOT NULL,
  ref_type       TEXT          NOT NULL DEFAULT 'system',
  -- 'trade_payout' | 'admin_credit' | 'withdrawal' | 'system'
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT wallet_ledger_amount_nonzero CHECK (amount <> 0)
);

-- Append-only: no UPDATE or DELETE policies are defined
ALTER TABLE wallet_ledger ENABLE ROW LEVEL SECURITY;

CREATE POLICY "wallet_ledger_owner_read"
  ON wallet_ledger FOR SELECT
  USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_wl_user_currency
  ON wallet_ledger (user_id, currency, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wl_created
  ON wallet_ledger (created_at DESC);

-- Trigger function: fires AFTER UPDATE on wallets whenever balance changes.
-- SECURITY DEFINER so the service role path (which bypasses RLS) still writes
-- into wallet_ledger even though there is no INSERT policy for the service role.
CREATE OR REPLACE FUNCTION fn_wallet_balance_change()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF OLD.balance IS DISTINCT FROM NEW.balance THEN
    INSERT INTO wallet_ledger (
      user_id, currency, amount, balance_before, balance_after, ref_type, created_at
    ) VALUES (
      NEW.user_id,
      NEW.currency,
      NEW.balance - OLD.balance,
      OLD.balance,
      NEW.balance,
      'system',
      now()
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_wallet_balance_change ON wallets;
CREATE TRIGGER trg_wallet_balance_change
  AFTER UPDATE OF balance ON wallets
  FOR EACH ROW EXECUTE FUNCTION fn_wallet_balance_change();

-- ─── Part 2: Reconciliation Views ────────────────────────────────────────────

-- Trades in 'paid' status with no settled_at after 24 hours.
-- These represent missing or stalled settlement executions.
CREATE OR REPLACE VIEW v_unreconciled_trades AS
SELECT
  id,
  user_id,
  type,
  brand,
  amount_usd,
  amount_ngn,
  status,
  payout_method,
  created_at,
  settled_at
FROM trades
WHERE status = 'paid'
  AND settled_at IS NULL
  AND created_at < NOW() - INTERVAL '24 hours';

COMMENT ON VIEW v_unreconciled_trades IS
  'Trades marked paid with no settled_at after 24h — candidate missing settlements.';

-- Vendor card assignments stuck in assigned/card_sent for more than 6 hours.
-- These may indicate a vendor who never responded or a delivery failure.
CREATE OR REPLACE VIEW v_stale_assignments AS
SELECT
  a.id            AS assignment_id,
  a.trade_id,
  a.vendor_id,
  a.status        AS assignment_status,
  t.status        AS trade_status,
  t.amount_usd,
  t.brand,
  a.created_at
FROM vendor_card_assignments a
JOIN trades t ON t.id = a.trade_id
WHERE a.status IN ('assigned', 'card_sent')
  AND a.created_at < NOW() - INTERVAL '6 hours';

COMMENT ON VIEW v_stale_assignments IS
  'Vendor assignments in assigned/card_sent for >6h — may need admin intervention.';

-- Summary: count of trades per status for dashboard reporting
CREATE OR REPLACE VIEW v_trade_status_summary AS
SELECT
  status,
  COUNT(*)                                             AS count,
  SUM(COALESCE(amount_ngn, 0))                         AS total_ngn,
  MIN(created_at)                                      AS oldest,
  MAX(created_at)                                      AS newest
FROM trades
GROUP BY status;

COMMENT ON VIEW v_trade_status_summary IS
  'Per-status count and NGN volume for reconciliation and business analytics.';

-- ─── Part 3: Vendor Performance Score ────────────────────────────────────────
-- Adds performance tracking columns to the vendors table.
-- A SQL function recomputes the score on demand after each assignment outcome.

ALTER TABLE vendors
  ADD COLUMN IF NOT EXISTS total_assignments   INT           NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_completed     INT           NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_failed        INT           NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_disputes      INT           NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS avg_response_ms     BIGINT,
  ADD COLUMN IF NOT EXISTS performance_score   NUMERIC(5,2)  NOT NULL DEFAULT 100.00,
  ADD COLUMN IF NOT EXISTS performance_tier    TEXT          NOT NULL DEFAULT 'bronze'
    CHECK (performance_tier IN ('bronze', 'silver', 'gold', 'platinum'));

COMMENT ON COLUMN vendors.performance_score IS
  'Computed score 0–100. 100=perfect. Deducted for disputes and failures.';
COMMENT ON COLUMN vendors.performance_tier IS
  'bronze(<60) | silver(60-79) | gold(80-94) | platinum(95-100)';

-- Score formula (clamped 0–100):
--   100
--   - 30 × (total_disputes / max(total_completed, 1))   -- dispute penalty
--   - 20 × (total_failed   / max(total_assignments, 1)) -- failure penalty
--   +  5   if total_completed > 10                      -- volume bonus
CREATE OR REPLACE FUNCTION recalculate_vendor_score(p_vendor_id UUID)
RETURNS NUMERIC LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_completed  INT;
  v_failed     INT;
  v_disputes   INT;
  v_total      INT;
  v_score      NUMERIC;
  v_tier       TEXT;
BEGIN
  SELECT
    COALESCE(total_completed, 0),
    COALESCE(total_failed, 0),
    COALESCE(total_disputes, 0),
    COALESCE(total_assignments, 0)
  INTO v_completed, v_failed, v_disputes, v_total
  FROM vendors WHERE id = p_vendor_id;

  IF NOT FOUND THEN RETURN NULL; END IF;

  v_score := 100.0
    - 30.0 * (v_disputes::NUMERIC / GREATEST(v_completed, 1))
    - 20.0 * (v_failed::NUMERIC   / GREATEST(v_total,     1))
    + CASE WHEN v_completed > 10 THEN 5.0 ELSE 0.0 END;

  v_score := GREATEST(0.0, LEAST(100.0, v_score));

  v_tier := CASE
    WHEN v_score >= 95 THEN 'platinum'
    WHEN v_score >= 80 THEN 'gold'
    WHEN v_score >= 60 THEN 'silver'
    ELSE 'bronze'
  END;

  UPDATE vendors
     SET performance_score = v_score,
         performance_tier  = v_tier
   WHERE id = p_vendor_id;

  RETURN v_score;
END;
$$;
