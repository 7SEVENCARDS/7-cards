-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 010: Vendor Withdrawal Requests
-- Vendors request withdrawal of their wallet balance to their bank account.
-- Admin reviews, approves, and triggers payout via Squadco.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS vendor_withdrawal_requests (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id      UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  amount         NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  bank_name      TEXT NOT NULL,
  bank_code      TEXT NOT NULL,
  account_number TEXT NOT NULL,
  account_name   TEXT NOT NULL,
  status         TEXT DEFAULT 'pending'
    CHECK (status IN ('pending','approved','paid','rejected','failed')),
  admin_note     TEXT,
  squadco_ref    TEXT,
  squadco_txn_id TEXT,
  processed_by   UUID REFERENCES auth.users(id),
  processed_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ DEFAULT now(),
  updated_at     TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vendor_withdrawals_vendor ON vendor_withdrawal_requests (vendor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vendor_withdrawals_status ON vendor_withdrawal_requests (status, created_at DESC);

ALTER TABLE vendor_withdrawal_requests ENABLE ROW LEVEL SECURITY;

-- Vendors can create and read their own withdrawal requests
CREATE POLICY "vendor_withdrawals_own_select" ON vendor_withdrawal_requests
  FOR SELECT USING (
    vendor_id IN (SELECT id FROM vendors WHERE user_id = auth.uid())
  );

CREATE POLICY "vendor_withdrawals_own_insert" ON vendor_withdrawal_requests
  FOR INSERT WITH CHECK (
    vendor_id IN (SELECT id FROM vendors WHERE user_id = auth.uid())
  );
