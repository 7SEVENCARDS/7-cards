-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 009: Vendor Network
-- Vendors buy gift cards from 7SEVEN (assigned by admin), redeem them, and
-- fund their vendor wallets via provisioned virtual account numbers.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── Vendor Profiles ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vendors (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  business_name        TEXT NOT NULL,
  contact_name         TEXT,
  phone                TEXT,
  email                TEXT,
  telegram_username    TEXT,
  telegram_chat_id     BIGINT,
  bank_name            TEXT,
  bank_code            TEXT,
  account_number       TEXT,
  account_name         TEXT,
  status               TEXT DEFAULT 'pending'
    CHECK (status IN ('pending','active','suspended')),
  tier                 TEXT DEFAULT 'standard'
    CHECK (tier IN ('standard','premium')),
  total_redeemed       INTEGER DEFAULT 0,
  total_volume_ngn     NUMERIC(20,2) DEFAULT 0,
  last_active_at       TIMESTAMPTZ,
  notes                TEXT,
  created_at           TIMESTAMPTZ DEFAULT now(),
  updated_at           TIMESTAMPTZ DEFAULT now()
);

-- ─── Vendor Wallets ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vendor_wallets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id       UUID NOT NULL UNIQUE REFERENCES vendors(id) ON DELETE CASCADE,
  balance         NUMERIC(20,2) DEFAULT 0 CHECK (balance >= 0),
  locked          NUMERIC(20,2) DEFAULT 0 CHECK (locked >= 0),
  total_funded    NUMERIC(20,2) DEFAULT 0,
  total_withdrawn NUMERIC(20,2) DEFAULT 0,
  currency        TEXT DEFAULT 'NGN',
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- ─── Card Assignments (admin → vendor) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS vendor_card_assignments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id       UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  trade_id        UUID REFERENCES trades(id),
  brand           TEXT NOT NULL,
  region          TEXT DEFAULT 'USA',
  amount_usd      NUMERIC(10,2) NOT NULL,
  amount_ngn      NUMERIC(15,2),
  card_code       TEXT NOT NULL,
  card_pin        TEXT,
  status          TEXT DEFAULT 'assigned'
    CHECK (status IN ('assigned','viewed','redeemed','failed','cancelled')),
  assigned_by     UUID REFERENCES auth.users(id),
  telegram_sent   BOOLEAN DEFAULT false,
  viewed_at       TIMESTAMPTZ,
  redeemed_at     TIMESTAMPTZ,
  failed_at       TIMESTAMPTZ,
  failure_reason  TEXT,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- ─── Virtual Account Numbers (per funding request) ────────────────────────────
CREATE TABLE IF NOT EXISTS vendor_virtual_accounts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id       UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  account_number  TEXT NOT NULL,
  bank_name       TEXT NOT NULL,
  bank_code       TEXT,
  account_name    TEXT,
  reference       TEXT NOT NULL UNIQUE,
  squadco_ref     TEXT,
  amount_expected NUMERIC(15,2),
  status          TEXT DEFAULT 'pending'
    CHECK (status IN ('pending','funded','expired','cancelled')),
  expires_at      TIMESTAMPTZ DEFAULT (now() + interval '24 hours'),
  funded_at       TIMESTAMPTZ,
  amount_received NUMERIC(15,2),
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- ─── Vendor Wallet Transactions ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vendor_transactions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id       UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  type            TEXT NOT NULL
    CHECK (type IN ('credit','debit','assignment_credit','withdrawal')),
  amount          NUMERIC(15,2) NOT NULL,
  balance_after   NUMERIC(15,2),
  description     TEXT,
  reference       TEXT,
  assignment_id   UUID REFERENCES vendor_card_assignments(id),
  virtual_account_id UUID REFERENCES vendor_virtual_accounts(id),
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- ─── Indexes ──────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_vendors_status          ON vendors (status);
CREATE INDEX IF NOT EXISTS idx_vendors_last_active     ON vendors (last_active_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_vendor_assignments_vid  ON vendor_card_assignments (vendor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vendor_assignments_st   ON vendor_card_assignments (status);
CREATE INDEX IF NOT EXISTS idx_vendor_transactions_vid ON vendor_transactions (vendor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vendor_vans_vendor      ON vendor_virtual_accounts (vendor_id, status);

-- ─── Row-Level Security ───────────────────────────────────────────────────────
ALTER TABLE vendors                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_wallets           ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_card_assignments  ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_virtual_accounts  ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_transactions      ENABLE ROW LEVEL SECURITY;

-- Vendors can only read/update their own records
CREATE POLICY "vendors_own" ON vendors
  FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE POLICY "vendor_wallets_own" ON vendor_wallets
  FOR SELECT USING (
    vendor_id IN (SELECT id FROM vendors WHERE user_id = auth.uid())
  );

CREATE POLICY "vendor_assignments_own" ON vendor_card_assignments
  FOR SELECT USING (
    vendor_id IN (SELECT id FROM vendors WHERE user_id = auth.uid())
  );

CREATE POLICY "vendor_assignments_update_own" ON vendor_card_assignments
  FOR UPDATE USING (
    vendor_id IN (SELECT id FROM vendors WHERE user_id = auth.uid())
  );

CREATE POLICY "vendor_vans_own" ON vendor_virtual_accounts
  FOR SELECT USING (
    vendor_id IN (SELECT id FROM vendors WHERE user_id = auth.uid())
  );

CREATE POLICY "vendor_txns_own" ON vendor_transactions
  FOR SELECT USING (
    vendor_id IN (SELECT id FROM vendors WHERE user_id = auth.uid())
  );
