-- ─── Vendor Referral System ───────────────────────────────────────────────────
-- Run in Supabase SQL Editor

-- 1. Add referral_code (unique per vendor) and referred_by to vendors
ALTER TABLE vendors
  ADD COLUMN IF NOT EXISTS referral_code TEXT UNIQUE
    DEFAULT upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)),
  ADD COLUMN IF NOT EXISTS referred_by UUID REFERENCES vendors(id) ON DELETE SET NULL;

-- Backfill referral codes for existing vendors who don't have one
UPDATE vendors
  SET referral_code = upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))
  WHERE referral_code IS NULL;

-- 2. Referral tracking table
CREATE TABLE IF NOT EXISTS vendor_referrals (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id      UUID         NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  referred_id      UUID         NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  bonus_amount_ngn NUMERIC(12,2) NOT NULL DEFAULT 2500,
  bonus_paid       BOOLEAN      NOT NULL DEFAULT FALSE,
  bonus_paid_at    TIMESTAMPTZ,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE(referrer_id, referred_id)
);

CREATE INDEX IF NOT EXISTS idx_vendor_referrals_referrer ON vendor_referrals(referrer_id);
CREATE INDEX IF NOT EXISTS idx_vendor_referrals_referred ON vendor_referrals(referred_id);
