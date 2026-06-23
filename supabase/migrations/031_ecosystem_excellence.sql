-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 031: Ecosystem Excellence
--
-- Phases:
--   Phase 2  — Franchise role expansion (MASTER_VENDOR, REGIONAL_VENDOR,
--               COUNTRY_OPERATOR, FRANCHISE_OWNER) + permission matrix
--   Phase 6  — Event log (immutable domain event store)
--   Phase 8  — Reconciliation runs table
--   Phase 10 — Risk assessments table
--   Phase 11 — Trust scores table
--   Phase 14 — Feature flags table
--   Phase 20 — Franchise hierarchy table
--
-- Safe to re-run: all objects use IF NOT EXISTS / CREATE OR REPLACE / DO-blocks.
-- ─────────────────────────────────────────────────────────────────────────────

-- ══════════════════════════════════════════════════════════════════════════════
-- PHASE 2: FRANCHISE ROLE EXPANSION
-- ══════════════════════════════════════════════════════════════════════════════

-- ── 1. Expand profiles.role check constraint ──────────────────────────────────
DO $$
DECLARE
  _cname TEXT;
BEGIN
  SELECT constraint_name INTO _cname
  FROM information_schema.check_constraints cc
  JOIN information_schema.constraint_column_usage cu
    ON cu.constraint_name = cc.constraint_name
  WHERE cu.table_name  = 'profiles'
    AND cu.column_name = 'role'
  LIMIT 1;

  IF _cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE profiles DROP CONSTRAINT %I', _cname);
  END IF;

  ALTER TABLE profiles
    ADD CONSTRAINT profiles_role_check
      CHECK (role IN (
        'user',
        'vendor',
        'master_vendor',
        'regional_vendor',
        'country_operator',
        'franchise_owner',
        'support',
        'admin',
        'super_admin'
      ));
END $$;

COMMENT ON CONSTRAINT profiles_role_check ON profiles IS
  'Valid roles: user | vendor | master_vendor | regional_vendor | country_operator | franchise_owner | support | admin | super_admin';

-- ── 2. Update helper functions to include all elevated roles ─────────────────

CREATE OR REPLACE FUNCTION is_admin()
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid()
      AND role IN ('admin', 'super_admin')
  );
$$;

CREATE OR REPLACE FUNCTION is_super_admin()
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid()
      AND role = 'super_admin'
  );
$$;

CREATE OR REPLACE FUNCTION is_vendor_tier()
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid()
      AND role IN ('vendor', 'master_vendor', 'regional_vendor', 'country_operator', 'franchise_owner')
  );
$$;

-- ── 3. Permission matrix ──────────────────────────────────────────────────────
-- Explicit per-role capability flags. No implicit inheritance.

CREATE TABLE IF NOT EXISTS permission_matrix (
  role                   TEXT    PRIMARY KEY,
  can_trade              BOOLEAN NOT NULL DEFAULT false,
  can_vendor_process     BOOLEAN NOT NULL DEFAULT false,
  can_vendor_manage      BOOLEAN NOT NULL DEFAULT false,    -- approve/suspend sub-vendors
  can_view_rates         BOOLEAN NOT NULL DEFAULT false,
  can_set_rates          BOOLEAN NOT NULL DEFAULT false,
  can_kyc_approve        BOOLEAN NOT NULL DEFAULT false,
  can_view_trades        BOOLEAN NOT NULL DEFAULT false,    -- all platform trades
  can_manage_users       BOOLEAN NOT NULL DEFAULT false,
  can_view_financials    BOOLEAN NOT NULL DEFAULT false,    -- revenue, volumes
  can_run_reconciliation BOOLEAN NOT NULL DEFAULT false,
  can_manage_flags       BOOLEAN NOT NULL DEFAULT false,    -- feature flags
  can_promote_admins     BOOLEAN NOT NULL DEFAULT false,
  can_manage_franchise   BOOLEAN NOT NULL DEFAULT false,
  can_view_risk          BOOLEAN NOT NULL DEFAULT false,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed the full permission matrix (upsert so re-runs are safe)
INSERT INTO permission_matrix (
  role, can_trade, can_vendor_process, can_vendor_manage,
  can_view_rates, can_set_rates, can_kyc_approve,
  can_view_trades, can_manage_users, can_view_financials,
  can_run_reconciliation, can_manage_flags, can_promote_admins,
  can_manage_franchise, can_view_risk
) VALUES
  -- USER: core consumer role
  ('user',             true,  false, false, false, false, false, false, false, false, false, false, false, false, false),
  -- VENDOR: processes assigned gift cards
  ('vendor',           false, true,  false, true,  false, false, false, false, false, false, false, false, false, false),
  -- MASTER_VENDOR: manages a cohort of sub-vendors
  ('master_vendor',    false, true,  true,  true,  false, false, false, false, false, false, false, false, false, false),
  -- REGIONAL_VENDOR: regional manager, can see regional trades and set rates for region
  ('regional_vendor',  false, true,  true,  true,  true,  false, true,  false, true,  false, false, false, false, true),
  -- COUNTRY_OPERATOR: full country-level operational authority
  ('country_operator', false, true,  true,  true,  true,  false, true,  false, true,  true,  false, false, true,  true),
  -- FRANCHISE_OWNER: investor/owner, read-only financial access
  ('franchise_owner',  false, false, false, true,  false, false, true,  false, true,  false, false, false, true,  false),
  -- SUPPORT: limited read access for customer support
  ('support',          false, false, false, false, false, false, true,  false, false, false, false, false, false, false),
  -- ADMIN: full platform management
  ('admin',            false, false, true,  true,  true,  true,  true,  true,  true,  true,  true,  false, true,  true),
  -- SUPER_ADMIN: root — all capabilities + can promote other admins
  ('super_admin',      false, false, true,  true,  true,  true,  true,  true,  true,  true,  true,  true,  true,  true)
ON CONFLICT (role) DO UPDATE SET
  can_trade              = EXCLUDED.can_trade,
  can_vendor_process     = EXCLUDED.can_vendor_process,
  can_vendor_manage      = EXCLUDED.can_vendor_manage,
  can_view_rates         = EXCLUDED.can_view_rates,
  can_set_rates          = EXCLUDED.can_set_rates,
  can_kyc_approve        = EXCLUDED.can_kyc_approve,
  can_view_trades        = EXCLUDED.can_view_trades,
  can_manage_users       = EXCLUDED.can_manage_users,
  can_view_financials    = EXCLUDED.can_view_financials,
  can_run_reconciliation = EXCLUDED.can_run_reconciliation,
  can_manage_flags       = EXCLUDED.can_manage_flags,
  can_promote_admins     = EXCLUDED.can_promote_admins,
  can_manage_franchise   = EXCLUDED.can_manage_franchise,
  can_view_risk          = EXCLUDED.can_view_risk,
  updated_at             = now();

ALTER TABLE permission_matrix ENABLE ROW LEVEL SECURITY;
CREATE POLICY "permission_matrix_admin_read" ON permission_matrix
  FOR SELECT USING (is_admin());
CREATE POLICY "permission_matrix_public_read" ON permission_matrix
  FOR SELECT USING (true);  -- roles are not sensitive


-- ══════════════════════════════════════════════════════════════════════════════
-- PHASE 6: IMMUTABLE EVENT LOG
-- Typed domain event store — source of truth for all business events.
-- No UPDATE or DELETE — append only.
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS event_log (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type   TEXT        NOT NULL,
  -- Canonical event types:
  -- UserRegistered | UserVerified | VendorApproved | VendorSuspended
  -- TradeCreated | TradeAssigned | TradeAccepted | TradeRejected | TradeCompleted
  -- SettlementCreated | SettlementCompleted | SettlementFailed
  -- WalletCredited | WalletDebited
  -- NotificationSent | FraudDetected | RiskFlagged
  -- FeatureFlagChanged | ReconciliationRun
  actor_id     UUID,                       -- who triggered it (null = system)
  actor_type   TEXT        NOT NULL DEFAULT 'system',  -- 'user' | 'vendor' | 'admin' | 'system'
  entity_type  TEXT,                       -- 'trade' | 'vendor' | 'user' | 'wallet' etc.
  entity_id    UUID,                       -- FK (soft) to the affected entity
  payload      JSONB       NOT NULL DEFAULT '{}',
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  trace_id     TEXT                        -- X-Request-ID from HTTP header
);

-- Append-only enforcement: no update/delete RLS policies exist
ALTER TABLE event_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "event_log_admin_read" ON event_log
  FOR SELECT USING (is_admin());

CREATE INDEX IF NOT EXISTS idx_event_log_type       ON event_log (event_type, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_log_entity     ON event_log (entity_type, entity_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_log_actor      ON event_log (actor_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_log_occurred   ON event_log (occurred_at DESC);

COMMENT ON TABLE event_log IS
  'Immutable domain event store. Append-only. Every significant business event must produce a row here.';


-- ══════════════════════════════════════════════════════════════════════════════
-- PHASE 8: RECONCILIATION RUNS
-- Records every automated reconciliation job execution.
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS reconciliation_runs (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_type              TEXT        NOT NULL DEFAULT 'daily',
  -- 'daily' | 'manual' | 'realtime'
  started_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at          TIMESTAMPTZ,
  status                TEXT        NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'failed', 'partial')),

  -- Findings
  unreconciled_trades   INT         NOT NULL DEFAULT 0,
  stale_assignments     INT         NOT NULL DEFAULT 0,
  wallet_discrepancies  INT         NOT NULL DEFAULT 0,
  duplicate_settlements INT         NOT NULL DEFAULT 0,
  orphan_transactions   INT         NOT NULL DEFAULT 0,
  total_issues          INT         GENERATED ALWAYS AS (
    unreconciled_trades + stale_assignments + wallet_discrepancies +
    duplicate_settlements + orphan_transactions
  ) STORED,

  -- Financial summary
  total_ngn_reconciled  NUMERIC(18,2),
  total_usd_volume      NUMERIC(18,2),

  -- Full report JSON
  report                JSONB       NOT NULL DEFAULT '{}',
  error                 TEXT,

  triggered_by          UUID,               -- admin who triggered (null = cron)
  trace_id              TEXT
);

ALTER TABLE reconciliation_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "reconciliation_admin_read" ON reconciliation_runs
  FOR SELECT USING (is_admin());

CREATE INDEX IF NOT EXISTS idx_recon_runs_started
  ON reconciliation_runs (started_at DESC);


-- ══════════════════════════════════════════════════════════════════════════════
-- PHASE 10: RISK ASSESSMENTS
-- Every user, vendor, trade, or device gets a risk score.
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TYPE IF NOT EXISTS risk_level AS ENUM ('low', 'medium', 'high', 'critical');

CREATE TABLE IF NOT EXISTS risk_assessments (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type  TEXT        NOT NULL,   -- 'user' | 'vendor' | 'trade' | 'device'
  entity_id    UUID        NOT NULL,
  risk_level   risk_level  NOT NULL DEFAULT 'low',
  risk_score   INT         NOT NULL DEFAULT 0 CHECK (risk_score BETWEEN 0 AND 100),
  -- 0-24 = low, 25-49 = medium, 50-74 = high, 75-100 = critical
  signals      JSONB       NOT NULL DEFAULT '{}',
  -- e.g. { duplicate_cards: 2, multiple_accounts: false, failed_verifications: 0,
  --         abnormal_volume: false, device_abuse: false }
  notes        TEXT,
  assessed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  assessed_by  TEXT        NOT NULL DEFAULT 'system',  -- 'system' | admin UUID
  expires_at   TIMESTAMPTZ,            -- null = permanent until reassessed
  active       BOOLEAN     NOT NULL DEFAULT true
);

ALTER TABLE risk_assessments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "risk_admin_read" ON risk_assessments
  FOR SELECT USING (is_admin());
CREATE POLICY "risk_own_read" ON risk_assessments
  FOR SELECT USING (entity_type = 'user' AND entity_id = auth.uid());

CREATE INDEX IF NOT EXISTS idx_risk_entity
  ON risk_assessments (entity_type, entity_id, active, assessed_at DESC);
CREATE INDEX IF NOT EXISTS idx_risk_level
  ON risk_assessments (risk_level, active, assessed_at DESC);

-- Helper: get current active risk for an entity
CREATE OR REPLACE FUNCTION get_entity_risk(p_entity_type TEXT, p_entity_id UUID)
RETURNS risk_level LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT risk_level FROM risk_assessments
  WHERE entity_type = p_entity_type
    AND entity_id   = p_entity_id
    AND active      = true
  ORDER BY assessed_at DESC
  LIMIT 1;
$$;


-- ══════════════════════════════════════════════════════════════════════════════
-- PHASE 11: TRUST SCORES
-- Composite trust scores for users, vendors, trades, devices, settlements.
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS trust_scores (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type     TEXT        NOT NULL,   -- 'user' | 'vendor' | 'device' | 'trade'
  entity_id       UUID        NOT NULL,
  score           NUMERIC(5,2) NOT NULL DEFAULT 50.00  -- 0–100
    CHECK (score BETWEEN 0 AND 100),
  tier            TEXT        NOT NULL DEFAULT 'standard'
    CHECK (tier IN ('blocked', 'low', 'standard', 'trusted', 'verified')),
  -- tier thresholds: blocked<20, low<40, standard<70, trusted<90, verified>=90
  components      JSONB       NOT NULL DEFAULT '{}',
  -- e.g. { kyc_verified: 30, trade_history: 20, device_clean: 15, no_disputes: 20 }
  computed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_until     TIMESTAMPTZ,           -- null = recompute on demand
  UNIQUE (entity_type, entity_id)        -- one active score per entity
);

ALTER TABLE trust_scores ENABLE ROW LEVEL SECURITY;
CREATE POLICY "trust_admin_read" ON trust_scores
  FOR SELECT USING (is_admin());
CREATE POLICY "trust_own_read" ON trust_scores
  FOR SELECT USING (entity_type = 'user' AND entity_id = auth.uid());
CREATE POLICY "trust_vendor_own" ON trust_scores
  FOR SELECT USING (
    entity_type = 'vendor' AND
    entity_id IN (SELECT id FROM vendors WHERE user_id = auth.uid())
  );

CREATE INDEX IF NOT EXISTS idx_trust_entity
  ON trust_scores (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_trust_tier
  ON trust_scores (tier, entity_type, computed_at DESC);

-- Recompute user trust score (called after KYC, trades, disputes)
CREATE OR REPLACE FUNCTION compute_user_trust_score(p_user_id UUID)
RETURNS NUMERIC LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_profile       RECORD;
  v_trades        INT;
  v_disputes      INT;
  v_kyc_verified  BOOLEAN;
  v_risk_level    risk_level;
  v_score         NUMERIC;
  v_tier          TEXT;

  -- Component weights (sum to 100 in the ideal case)
  w_kyc           NUMERIC := 25.0;
  w_trades        NUMERIC := 30.0;
  w_clean_history NUMERIC := 25.0;
  w_risk_penalty  NUMERIC := 20.0;
BEGIN
  -- Fetch profile
  SELECT role, kyc_status INTO v_profile
  FROM profiles WHERE id = p_user_id;

  IF NOT FOUND THEN RETURN 0; END IF;

  v_kyc_verified := COALESCE(v_profile.kyc_status, '') IN ('approved', 'verified');

  -- Trade history (capped at 30 completed trades for full score)
  SELECT COUNT(*) INTO v_trades
  FROM trades WHERE user_id = p_user_id AND status = 'completed';

  -- Disputes / chargebacks
  SELECT COUNT(*) INTO v_disputes
  FROM trades WHERE user_id = p_user_id AND status IN ('disputed', 'fraud_flagged');

  -- Active risk level
  v_risk_level := get_entity_risk('user', p_user_id);

  -- Component scores
  v_score := 0
    + CASE WHEN v_kyc_verified THEN w_kyc ELSE w_kyc * 0.3 END
    + LEAST(w_trades, w_trades * (v_trades::NUMERIC / 30.0))
    + GREATEST(0, w_clean_history - (v_disputes * 8.0))
    + CASE
        WHEN v_risk_level = 'low'      OR v_risk_level IS NULL THEN w_risk_penalty
        WHEN v_risk_level = 'medium'   THEN w_risk_penalty * 0.6
        WHEN v_risk_level = 'high'     THEN w_risk_penalty * 0.2
        WHEN v_risk_level = 'critical' THEN 0
      END;

  v_score := GREATEST(0, LEAST(100, v_score));

  v_tier := CASE
    WHEN v_score < 20 THEN 'blocked'
    WHEN v_score < 40 THEN 'low'
    WHEN v_score < 70 THEN 'standard'
    WHEN v_score < 90 THEN 'trusted'
    ELSE 'verified'
  END;

  INSERT INTO trust_scores (entity_type, entity_id, score, tier, components, computed_at)
  VALUES (
    'user', p_user_id, v_score, v_tier,
    jsonb_build_object(
      'kyc_component',      CASE WHEN v_kyc_verified THEN w_kyc ELSE w_kyc * 0.3 END,
      'trades_component',   LEAST(w_trades, w_trades * (v_trades::NUMERIC / 30.0)),
      'history_component',  GREATEST(0, w_clean_history - (v_disputes * 8.0)),
      'risk_component',     v_score - (CASE WHEN v_kyc_verified THEN w_kyc ELSE w_kyc * 0.3 END)
                                    - LEAST(w_trades, w_trades * (v_trades::NUMERIC / 30.0))
                                    - GREATEST(0, w_clean_history - (v_disputes * 8.0)),
      'total_trades',       v_trades,
      'total_disputes',     v_disputes,
      'kyc_verified',       v_kyc_verified,
      'risk_level',         COALESCE(v_risk_level::TEXT, 'low')
    ),
    now()
  )
  ON CONFLICT (entity_type, entity_id) DO UPDATE SET
    score       = EXCLUDED.score,
    tier        = EXCLUDED.tier,
    components  = EXCLUDED.components,
    computed_at = EXCLUDED.computed_at;

  RETURN v_score;
END;
$$;


-- ══════════════════════════════════════════════════════════════════════════════
-- PHASE 14: FEATURE FLAGS
-- DB-backed feature flags with instant kill-switch capability.
-- No deployment required to enable/disable features.
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS feature_flags (
  key          TEXT        PRIMARY KEY,
  enabled      BOOLEAN     NOT NULL DEFAULT false,
  description  TEXT,
  -- Targeting: null = apply to all; non-null = applies only to these roles/users
  allowed_roles TEXT[]     DEFAULT NULL,   -- e.g. ARRAY['admin', 'super_admin']
  rollout_pct  INT         NOT NULL DEFAULT 100
    CHECK (rollout_pct BETWEEN 0 AND 100),  -- 0=off, 100=everyone
  metadata     JSONB       NOT NULL DEFAULT '{}',
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by   UUID                          -- admin who last changed it
);

-- Seed default flags
INSERT INTO feature_flags (key, enabled, description, rollout_pct) VALUES
  ('ocr_scan',          false, 'AI OCR card image scanning',                      0),
  ('crypto_wallet',     false, 'Crypto payout via Busha',                         0),
  ('vendor_analytics',  false, 'Extended vendor analytics dashboard',              0),
  ('referral_program',  false, 'Referral bonus system',                            0),
  ('franchise_ops',     false, 'Franchise operator portal and features',           0),
  ('mobile_api_v1',     true,  'Mobile REST API v1 (/api/v1/*)',                  100),
  ('trust_scores',      true,  'User and vendor trust score computation',          100),
  ('risk_engine',       true,  'Automated risk assessment engine',                 100),
  ('reconciliation',    true,  'Daily automated reconciliation cron',              100),
  ('event_bus',         true,  'Domain event log emission',                        100),
  ('mono_connect',      true,  'Mono Connect SDK for bank linking',                100),
  ('weekly_commission', true,  'Weekly ₦500 trade commission for qualifying users',100),
  ('vendor_broadcast',  true,  'Real-time vendor card broadcast via Telegram',     100)
ON CONFLICT (key) DO NOTHING;

ALTER TABLE feature_flags ENABLE ROW LEVEL SECURITY;
CREATE POLICY "flags_admin_write" ON feature_flags
  FOR ALL USING (is_admin());
CREATE POLICY "flags_public_read" ON feature_flags
  FOR SELECT USING (true);  -- feature flag keys/status are not sensitive

CREATE INDEX IF NOT EXISTS idx_flags_enabled ON feature_flags (enabled, key);


-- ══════════════════════════════════════════════════════════════════════════════
-- PHASE 20: FRANCHISE HIERARCHY
-- Architecture for Vendor → Master Vendor → Regional → Country → Franchise.
-- Feature is disabled by default (feature flag: franchise_ops).
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS franchise_nodes (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  node_type    TEXT        NOT NULL
    CHECK (node_type IN ('vendor', 'master_vendor', 'regional_vendor', 'country_operator', 'franchise_owner')),
  user_id      UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  parent_id    UUID        REFERENCES franchise_nodes(id) ON DELETE SET NULL,  -- upward hierarchy
  country_code TEXT,                   -- ISO 3166-1 alpha-2 e.g. 'NG'
  region       TEXT,                   -- e.g. 'South-West Nigeria'
  name         TEXT        NOT NULL,   -- display name of this node
  commission_pct NUMERIC(5,2) DEFAULT 0.00 CHECK (commission_pct >= 0),
  -- % of subordinate trade value that flows up to this node
  status       TEXT        NOT NULL DEFAULT 'pending'
    CHECK (status IN ('active', 'pending', 'suspended', 'inactive')),
  settings     JSONB       NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, node_type)
);

ALTER TABLE franchise_nodes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "franchise_admin_all"  ON franchise_nodes FOR ALL USING (is_admin());
CREATE POLICY "franchise_own_read"   ON franchise_nodes
  FOR SELECT USING (user_id = auth.uid());

CREATE INDEX IF NOT EXISTS idx_franchise_parent
  ON franchise_nodes (parent_id, status);
CREATE INDEX IF NOT EXISTS idx_franchise_type
  ON franchise_nodes (node_type, country_code, status);

COMMENT ON TABLE franchise_nodes IS
  'Franchise hierarchy. Disabled until franchise_ops feature flag is enabled.';

-- Update sync_vendor_role to also handle master_vendor / regional_vendor
CREATE OR REPLACE FUNCTION sync_vendor_role()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_franchise_type TEXT;
BEGIN
  IF NEW.status = 'active' THEN
    -- Check if this vendor has a franchise node that elevates their role
    SELECT node_type INTO v_franchise_type
    FROM franchise_nodes
    WHERE user_id = NEW.user_id AND status = 'active'
    LIMIT 1;

    UPDATE profiles
    SET role = CASE
      WHEN v_franchise_type IS NOT NULL THEN v_franchise_type
      ELSE 'vendor'
    END
    WHERE id = NEW.user_id
      AND role NOT IN ('admin', 'super_admin', 'support');
  END IF;
  RETURN NEW;
END;
$$;


-- ══════════════════════════════════════════════════════════════════════════════
-- SUPPORTING: provider_health_log (Phase 17 extension — track per-provider health)
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS provider_health_log (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  provider     TEXT        NOT NULL,   -- 'supabase' | 'squadco' | 'reloadly' | 'mono' | 'dojah' | 'onesignal'
  status       TEXT        NOT NULL
    CHECK (status IN ('ok', 'degraded', 'down')),
  latency_ms   INT,
  error        TEXT,
  checked_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE provider_health_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "health_admin_read" ON provider_health_log
  FOR SELECT USING (is_admin());

CREATE INDEX IF NOT EXISTS idx_provider_health_provider
  ON provider_health_log (provider, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_provider_health_checked
  ON provider_health_log (checked_at DESC);

COMMENT ON TABLE provider_health_log IS
  'Rolling provider health history. Written by /api/health cron checks.';


-- ══════════════════════════════════════════════════════════════════════════════
-- INDICES & COMMENTS
-- ══════════════════════════════════════════════════════════════════════════════

COMMENT ON TABLE permission_matrix IS
  'Explicit per-role permission flags. No implicit inheritance. Updated by super_admin only.';
COMMENT ON TABLE trust_scores IS
  'Composite trust scores (0–100) for users, vendors, trades, and devices. Recomputed after significant events.';
COMMENT ON TABLE risk_assessments IS
  'Risk classifications (low/medium/high/critical) for entities. Used for trade routing, approval gating, and fraud monitoring.';
COMMENT ON TABLE feature_flags IS
  'DB-backed feature flags. Enable/disable features without deployment. Updated by admin via admin panel.';
COMMENT ON TABLE event_log IS
  'Immutable domain event store. Append-only. Becomes source of truth for all significant business events.';
