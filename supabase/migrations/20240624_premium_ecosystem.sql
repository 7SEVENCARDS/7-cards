-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: Premium Ecosystem — Treasury Growth, Trust Acceleration,
--            Recurring Revenue, Retention Milestones
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── 1. Premium Revenue Allocations ──────────────────────────────────────────
-- Tracks how each ₦2,000 subscription payment is allocated
CREATE TABLE IF NOT EXISTS premium_revenue_allocations (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id    UUID,
  user_id            UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  total_ngn          NUMERIC(10,2) NOT NULL DEFAULT 2000,
  treasury_ngn       NUMERIC(10,2) NOT NULL DEFAULT 800,    -- 40%
  fraud_reserve_ngn  NUMERIC(10,2) NOT NULL DEFAULT 400,    -- 20%
  operations_ngn     NUMERIC(10,2) NOT NULL DEFAULT 400,    -- 20%
  infrastructure_ngn NUMERIC(10,2) NOT NULL DEFAULT 200,    -- 10%
  growth_ngn         NUMERIC(10,2) NOT NULL DEFAULT 200,    -- 10%
  allocated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_premium_revenue_user     ON premium_revenue_allocations(user_id);
CREATE INDEX IF NOT EXISTS idx_premium_revenue_sub      ON premium_revenue_allocations(subscription_id);
CREATE INDEX IF NOT EXISTS idx_premium_revenue_date     ON premium_revenue_allocations(allocated_at DESC);

-- ─── 2. Premium Liquidity Pool ────────────────────────────────────────────────
-- Singleton row tracking cumulative treasury allocations from premium revenue
CREATE TABLE IF NOT EXISTS premium_liquidity_pool (
  id            TEXT PRIMARY KEY DEFAULT 'singleton',
  balance_ngn   NUMERIC(14,2) NOT NULL DEFAULT 0,
  last_updated  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Insert singleton if not exists
INSERT INTO premium_liquidity_pool (id, balance_ngn, last_updated)
VALUES ('singleton', 0, now())
ON CONFLICT (id) DO NOTHING;

-- RPC to atomically increment the pool
CREATE OR REPLACE FUNCTION increment_premium_liquidity_pool(p_amount_ngn NUMERIC)
RETURNS void AS $$
BEGIN
  UPDATE premium_liquidity_pool
  SET balance_ngn  = balance_ngn + p_amount_ngn,
      last_updated = now()
  WHERE id = 'singleton';
END;
$$ LANGUAGE plpgsql;

-- ─── 3. Premium Milestones ────────────────────────────────────────────────────
-- Tracks loyalty milestones: 30 / 90 / 180 / 365 days of Premium
CREATE TABLE IF NOT EXISTS premium_milestones (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  milestone_days  INTEGER NOT NULL CHECK (milestone_days IN (30, 90, 180, 365)),
  milestone_label TEXT NOT NULL,
  achieved_at     TIMESTAMPTZ NOT NULL,
  benefit         TEXT,
  notified        BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (user_id, milestone_days)
);

CREATE INDEX IF NOT EXISTS idx_premium_milestones_user ON premium_milestones(user_id);
CREATE INDEX IF NOT EXISTS idx_premium_milestones_days ON premium_milestones(milestone_days);

-- ─── 4. Extend subscriptions table for premium type ───────────────────────────
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS premium_type TEXT
  CHECK (premium_type IN ('trader', 'vendor', 'franchise'))
  DEFAULT 'trader';

-- ─── 5. RLS policies ─────────────────────────────────────────────────────────
ALTER TABLE premium_revenue_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE premium_liquidity_pool      ENABLE ROW LEVEL SECURITY;
ALTER TABLE premium_milestones          ENABLE ROW LEVEL SECURITY;

-- Users can see their own milestone achievements
CREATE POLICY "users_own_milestones" ON premium_milestones
  FOR SELECT USING (auth.uid() = user_id);

-- Service role (admin) bypasses RLS for all tables

-- ─── 6. Trust score — add premium_member column ───────────────────────────────
-- The trust_scores breakdown JSONB already stores premium_member field,
-- so no schema change needed. Premium signal is computed in trust-engine.ts.

-- ─── 7. Helpful view: premium user summary ───────────────────────────────────
CREATE OR REPLACE VIEW v_premium_user_summary AS
SELECT
  p.id,
  p.full_name,
  p.phone,
  p.kyc_status,
  p.premium,
  s.plan,
  s.status        AS sub_status,
  s.started_at,
  s.expires_at,
  s.amount_ngn,
  s.premium_type,
  ts.trust_score,
  ts.trust_level
FROM profiles p
LEFT JOIN subscriptions s ON s.user_id = p.id AND s.plan = 'premium' AND s.status = 'active'
LEFT JOIN trust_scores ts ON ts.user_id = p.id
WHERE p.premium = true;
