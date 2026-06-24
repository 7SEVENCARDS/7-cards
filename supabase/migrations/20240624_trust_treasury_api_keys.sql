-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: Trust Engine, Treasury Engine, API Key Management
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── 1. Trust Scores ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trust_scores (
  user_id        UUID PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  trust_score    INTEGER NOT NULL DEFAULT 0 CHECK (trust_score BETWEEN 0 AND 100),
  trust_level    TEXT    NOT NULL DEFAULT 'New' CHECK (trust_level IN ('New', 'Verified', 'Trusted', 'Elite')),
  trust_reason   TEXT,
  breakdown      JSONB   NOT NULL DEFAULT '{}',
  controls       JSONB   NOT NULL DEFAULT '{}',
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trust_scores_level   ON trust_scores(trust_level);
CREATE INDEX IF NOT EXISTS idx_trust_scores_score   ON trust_scores(trust_score DESC);
CREATE INDEX IF NOT EXISTS idx_trust_scores_updated ON trust_scores(updated_at DESC);

-- ─── 2. Trust Score History ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trust_score_history (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  trust_score   INTEGER NOT NULL CHECK (trust_score BETWEEN 0 AND 100),
  trust_level   TEXT    NOT NULL CHECK (trust_level IN ('New', 'Verified', 'Trusted', 'Elite')),
  trust_reason  TEXT,
  breakdown     JSONB   NOT NULL DEFAULT '{}',
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trust_history_user ON trust_score_history(user_id, recorded_at DESC);

-- ─── 3. Treasury Decisions ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS treasury_decisions (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_id                 UUID NOT NULL,
  user_id                  UUID NOT NULL REFERENCES profiles(id) ON DELETE SET NULL,
  brand                    TEXT NOT NULL,
  region                   TEXT NOT NULL DEFAULT 'NG',
  amount_usd               NUMERIC(12,2) NOT NULL,
  decision                 TEXT NOT NULL CHECK (decision IN ('TREASURY_BUY', 'VENDOR_ROUTE', 'HYBRID_ROUTE')),
  confidence               INTEGER NOT NULL DEFAULT 0 CHECK (confidence BETWEEN 0 AND 100),
  reason                   TEXT,
  trust_score              INTEGER,
  fraud_score              INTEGER,
  inventory_risk_score     INTEGER,
  demand_score             INTEGER,
  treasury_utilization     NUMERIC(5,4),
  inventory_velocity       INTEGER,
  vendor_allocation_pct    INTEGER DEFAULT 100,
  treasury_allocation_pct  INTEGER DEFAULT 0,
  decided_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_treasury_decisions_trade      ON treasury_decisions(trade_id);
CREATE INDEX IF NOT EXISTS idx_treasury_decisions_user       ON treasury_decisions(user_id);
CREATE INDEX IF NOT EXISTS idx_treasury_decisions_decision   ON treasury_decisions(decision);
CREATE INDEX IF NOT EXISTS idx_treasury_decisions_decided_at ON treasury_decisions(decided_at DESC);

-- ─── 4. Treasury Inventory Offers ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS treasury_inventory_offers (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inventory_item_id  UUID,
  vendor_id          UUID REFERENCES vendors(id) ON DELETE SET NULL,
  vendor_tier        TEXT NOT NULL,
  brand              TEXT NOT NULL,
  amount_usd         NUMERIC(12,2),
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'expired')),
  offered_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_treasury_offers_vendor ON treasury_inventory_offers(vendor_id);
CREATE INDEX IF NOT EXISTS idx_treasury_offers_status ON treasury_inventory_offers(status);

-- ─── 5. Provider API Keys ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS provider_api_keys (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider          TEXT NOT NULL,
  key_name          TEXT NOT NULL,
  encrypted_value   TEXT NOT NULL,   -- store raw; Supabase encrypts at rest
  masked_value      TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'inactive' CHECK (status IN ('active', 'inactive', 'rotating', 'archived', 'expired')),
  version           INTEGER NOT NULL DEFAULT 1,
  expires_at        TIMESTAMPTZ,
  health_status     TEXT NOT NULL DEFAULT 'unknown' CHECK (health_status IN ('healthy', 'degraded', 'unhealthy', 'unknown')),
  last_validated_at TIMESTAMPTZ,
  rotated_at        TIMESTAMPTZ,
  created_by        UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_provider_api_keys_provider ON provider_api_keys(provider, status);
CREATE INDEX IF NOT EXISTS idx_provider_api_keys_status   ON provider_api_keys(status);

-- Only one active key per provider/key_name pair
CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_api_keys_active_unique
  ON provider_api_keys(provider, key_name)
  WHERE status = 'active';

-- ─── 6. Provider Operation Log (if not already exists) ────────────────────────
CREATE TABLE IF NOT EXISTS provider_operation_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gateway       TEXT NOT NULL,
  provider      TEXT NOT NULL,
  operation     TEXT NOT NULL,
  request_id    UUID,
  success       BOOLEAN NOT NULL DEFAULT false,
  failover      BOOLEAN NOT NULL DEFAULT false,
  latency_ms    INTEGER,
  error_message TEXT,
  user_id       UUID,
  reference     TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_provider_op_log_provider   ON provider_operation_log(provider, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_provider_op_log_success    ON provider_operation_log(success);
CREATE INDEX IF NOT EXISTS idx_provider_op_log_gateway    ON provider_operation_log(gateway);
CREATE INDEX IF NOT EXISTS idx_provider_op_log_created_at ON provider_operation_log(created_at DESC);

-- ─── 7. RLS Policies — all tables are admin-only ──────────────────────────────
ALTER TABLE trust_scores            ENABLE ROW LEVEL SECURITY;
ALTER TABLE trust_score_history     ENABLE ROW LEVEL SECURITY;
ALTER TABLE treasury_decisions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE treasury_inventory_offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_api_keys       ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_operation_log  ENABLE ROW LEVEL SECURITY;

-- Users can read their own trust score
CREATE POLICY "users_own_trust_score" ON trust_scores
  FOR SELECT USING (auth.uid() = user_id);

-- Admins have full access to all tables (via service role key on server)
-- Service role bypasses RLS, so no additional admin policies needed.

-- ─── 8. Updated_at trigger for provider_api_keys ──────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_provider_api_keys_updated_at ON provider_api_keys;
CREATE TRIGGER set_provider_api_keys_updated_at
  BEFORE UPDATE ON provider_api_keys
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
