-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 022 — API Tenant Billing & Subscription Plans
--
-- Revenue model for third-party trading companies (TPOs) using 7SEVEN's
-- vendor network and support staff as infrastructure:
--
--   • Monthly platform fee: starts at ₦20,000 (Starter plan)
--   • Trade fee: 7% of each successfully dispatched trade's NGN value
--     (decreases with higher plans — reward volume)
--   • Support staff fee: ₦5,000/month per active staff slot
--
-- Architecture:
--   api_subscription_plans  — plan catalogue with pricing in Naira
--   api_tenant_billing_cycles — monthly invoice aggregates per tenant
--   api_billing_transactions  — individual line items (trade fees, monthly fees)
--   record_api_trade_fee()  — called by api-server on each dispatched trade
--   open_monthly_billing_cycle() — called at month start (cron/manual)
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Subscription Plans ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS api_subscription_plans (
  id                          TEXT        PRIMARY KEY,   -- 'starter','growth','professional','enterprise'
  name                        TEXT        NOT NULL,
  monthly_fee_ngn             NUMERIC(12,2) NOT NULL DEFAULT 0,
  trade_fee_pct               NUMERIC(5,4) NOT NULL DEFAULT 0.0700, -- 7.00%
  support_staff_slots         INT         NOT NULL DEFAULT 1,
  support_staff_monthly_ngn   NUMERIC(12,2) NOT NULL DEFAULT 5000,  -- per slot
  rate_limit_rpm              INT         NOT NULL DEFAULT 60,
  description                 TEXT,
  is_active                   BOOLEAN     NOT NULL DEFAULT TRUE,
  sort_order                  INT         NOT NULL DEFAULT 0,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed the four tiers (idempotent)
INSERT INTO api_subscription_plans
  (id, name, monthly_fee_ngn, trade_fee_pct, support_staff_slots, support_staff_monthly_ngn, rate_limit_rpm, description, sort_order)
VALUES
  ('starter',      'Starter',      20000,  0.0700, 1,  5000, 60,   'Entry-level for small trading companies. ₦20,000/mo platform fee + 7% per trade.',       1),
  ('growth',       'Growth',       35000,  0.0650, 2,  5000, 300,  'Growing trading desks. ₦35,000/mo + 6.5% per trade. 2 support staff slots.',              2),
  ('professional', 'Professional', 65000,  0.0600, 3,  5000, 600,  'High-volume operations. ₦65,000/mo + 6% per trade. 3 staff slots, 600 req/min.',          3),
  ('enterprise',   'Enterprise',   150000, 0.0500, 10, 5000, 1500, 'Custom enterprise deployments. ₦150,000/mo + 5% per trade. 10 staff slots, 1500 req/min.',4)
ON CONFLICT (id) DO NOTHING;

-- ── 2. Widen plan CHECK on api_tenants ───────────────────────────────────────
-- Existing constraint only allowed 'free','pro','enterprise'. Add new plan IDs.
ALTER TABLE api_tenants DROP CONSTRAINT IF EXISTS api_tenants_plan_check;
ALTER TABLE api_tenants
  ADD CONSTRAINT api_tenants_plan_check
  CHECK (plan IN ('free','starter','growth','professional','enterprise'));

-- Add support_staff_count to track how many staff slots a tenant is using
ALTER TABLE api_tenants
  ADD COLUMN IF NOT EXISTS support_staff_count INT NOT NULL DEFAULT 1;

-- ── 3. Monthly Billing Cycles ─────────────────────────────────────────────────
-- One row per tenant per calendar month. Aggregates all fees for invoicing.
CREATE TABLE IF NOT EXISTS api_tenant_billing_cycles (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID        NOT NULL REFERENCES api_tenants(id) ON DELETE CASCADE,
  plan_id           TEXT        NOT NULL REFERENCES api_subscription_plans(id),
  billing_month     DATE        NOT NULL,   -- always the 1st of the month
  platform_fee_ngn  NUMERIC(12,2) NOT NULL DEFAULT 0,
  trade_fee_ngn     NUMERIC(12,2) NOT NULL DEFAULT 0,
  support_fee_ngn   NUMERIC(12,2) NOT NULL DEFAULT 0,
  trade_count       INT         NOT NULL DEFAULT 0,
  trade_volume_ngn  NUMERIC(16,2) NOT NULL DEFAULT 0,
  status            TEXT        NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open','invoiced','paid','overdue')),
  invoiced_at       TIMESTAMPTZ,
  paid_at           TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, billing_month)
);

CREATE INDEX IF NOT EXISTS idx_billing_cycles_tenant
  ON api_tenant_billing_cycles(tenant_id, billing_month DESC);

CREATE INDEX IF NOT EXISTS idx_billing_cycles_status
  ON api_tenant_billing_cycles(status) WHERE status IN ('open','invoiced','overdue');

-- ── 4. Individual Billing Line Items ──────────────────────────────────────────
-- Audit trail: one row per trade fee, monthly platform fee, support fee, etc.
CREATE TABLE IF NOT EXISTS api_billing_transactions (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID        NOT NULL REFERENCES api_tenants(id) ON DELETE CASCADE,
  cycle_id    UUID        REFERENCES api_tenant_billing_cycles(id),
  type        TEXT        NOT NULL
                CHECK (type IN ('trade_fee','platform_fee','support_fee','adjustment','credit')),
  amount_ngn  NUMERIC(12,2) NOT NULL,
  description TEXT,
  trade_id    UUID        REFERENCES trades(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_billing_txns_tenant
  ON api_billing_transactions(tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_billing_txns_cycle
  ON api_billing_transactions(cycle_id, created_at DESC);

-- ── 5. Fix api_webhook_deliveries — add status tracking columns ───────────────
-- Migration 021 uses attempt_count/last_attempt_at/last_status_code/delivered_at
-- for raw tracking. Add derived status columns to support the admin dashboard.
ALTER TABLE api_webhook_deliveries
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','delivered','failed','retrying')),
  ADD COLUMN IF NOT EXISTS attempt_number INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS response_code  INT,
  ADD COLUMN IF NOT EXISTS attempted_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS next_retry_at  TIMESTAMPTZ;

-- Backfill existing rows from the raw tracking columns
UPDATE api_webhook_deliveries SET
  attempt_number = attempt_count,
  response_code  = last_status_code,
  attempted_at   = last_attempt_at,
  status = CASE
    WHEN delivered_at IS NOT NULL THEN 'delivered'
    WHEN attempt_count >= 4       THEN 'failed'
    WHEN attempt_count > 0        THEN 'retrying'
    ELSE 'pending'
  END
WHERE attempt_number = 0 OR status = 'pending';

-- ── 6. RLS ────────────────────────────────────────────────────────────────────
ALTER TABLE api_subscription_plans      ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_tenant_billing_cycles   ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_billing_transactions    ENABLE ROW LEVEL SECURITY;

-- Service role: full access (api-server uses service role key)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'api_subscription_plans' AND policyname = 'svc_plans') THEN
    CREATE POLICY svc_plans ON api_subscription_plans FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'api_tenant_billing_cycles' AND policyname = 'svc_billing_cycles') THEN
    CREATE POLICY svc_billing_cycles ON api_tenant_billing_cycles FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'api_billing_transactions' AND policyname = 'svc_billing_txns') THEN
    CREATE POLICY svc_billing_txns ON api_billing_transactions FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Admin read access
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'api_subscription_plans' AND policyname = 'admin_read_plans') THEN
    CREATE POLICY admin_read_plans ON api_subscription_plans FOR SELECT TO authenticated
      USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'api_tenant_billing_cycles' AND policyname = 'admin_read_billing_cycles') THEN
    CREATE POLICY admin_read_billing_cycles ON api_tenant_billing_cycles FOR SELECT TO authenticated
      USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'api_billing_transactions' AND policyname = 'admin_read_billing_txns') THEN
    CREATE POLICY admin_read_billing_txns ON api_billing_transactions FOR SELECT TO authenticated
      USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'));
  END IF;
END $$;

-- ── 7. record_api_trade_fee() ──────────────────────────────────────────────────
-- Called by the API server (service role) after every successfully dispatched
-- trade. Calculates the platform's cut (7% on Starter, down to 5% Enterprise)
-- and appends it to the tenant's current monthly billing cycle.
CREATE OR REPLACE FUNCTION record_api_trade_fee(
  p_tenant_id   UUID,
  p_trade_id    UUID,
  p_amount_ngn  NUMERIC
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_plan_id  TEXT;
  v_plan     api_subscription_plans%ROWTYPE;
  v_fee_ngn  NUMERIC(12,2);
  v_cycle_id UUID;
  v_month    DATE;
BEGIN
  -- Resolve tenant's current plan
  SELECT COALESCE(plan, 'starter') INTO v_plan_id
  FROM api_tenants WHERE id = p_tenant_id;

  SELECT * INTO v_plan FROM api_subscription_plans WHERE id = v_plan_id;
  IF NOT FOUND THEN
    SELECT * INTO v_plan FROM api_subscription_plans WHERE id = 'starter';
  END IF;

  v_fee_ngn := ROUND(p_amount_ngn * v_plan.trade_fee_pct, 2);
  v_month   := date_trunc('month', NOW())::DATE;

  -- Upsert the current month's billing cycle
  INSERT INTO api_tenant_billing_cycles
    (tenant_id, plan_id, billing_month, trade_fee_ngn, trade_count, trade_volume_ngn)
  VALUES
    (p_tenant_id, v_plan.id, v_month, v_fee_ngn, 1, p_amount_ngn)
  ON CONFLICT (tenant_id, billing_month) DO UPDATE SET
    trade_fee_ngn    = api_tenant_billing_cycles.trade_fee_ngn + v_fee_ngn,
    trade_count      = api_tenant_billing_cycles.trade_count   + 1,
    trade_volume_ngn = api_tenant_billing_cycles.trade_volume_ngn + p_amount_ngn,
    updated_at       = NOW()
  RETURNING id INTO v_cycle_id;

  -- Record the line item
  INSERT INTO api_billing_transactions
    (tenant_id, cycle_id, type, amount_ngn, description, trade_id)
  VALUES (
    p_tenant_id, v_cycle_id, 'trade_fee', v_fee_ngn,
    format('%s%% platform fee on ₦%s trade',
      to_char(v_plan.trade_fee_pct * 100, 'FM990.9'),
      to_char(p_amount_ngn, 'FM999,999,999')),
    p_trade_id
  );

  RETURN jsonb_build_object('fee_ngn', v_fee_ngn, 'cycle_id', v_cycle_id);
END;
$$;

GRANT EXECUTE ON FUNCTION record_api_trade_fee TO service_role;

-- ── 8. open_monthly_billing_cycle() ───────────────────────────────────────────
-- Run at the start of each calendar month (e.g. via pg_cron or a Supabase Edge
-- Function cron). Seeds platform + support fees for all active tenants.
-- Idempotent: ON CONFLICT DO NOTHING means safe to run multiple times.
CREATE OR REPLACE FUNCTION open_monthly_billing_cycle(
  p_billing_month DATE DEFAULT date_trunc('month', NOW())::DATE
) RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant   RECORD;
  v_plan     api_subscription_plans%ROWTYPE;
  v_support  NUMERIC(12,2);
  v_count    INT := 0;
BEGIN
  FOR v_tenant IN
    SELECT t.id,
           COALESCE(t.plan, 'starter') AS plan_id,
           COALESCE(t.support_staff_count, 1) AS staff_count
    FROM api_tenants t
    WHERE t.status = 'active'
  LOOP
    SELECT * INTO v_plan FROM api_subscription_plans WHERE id = v_tenant.plan_id;
    IF NOT FOUND THEN
      SELECT * INTO v_plan FROM api_subscription_plans WHERE id = 'starter';
    END IF;

    v_support := v_plan.support_staff_monthly_ngn * v_tenant.staff_count;

    -- Open the cycle (no-op if already exists)
    INSERT INTO api_tenant_billing_cycles
      (tenant_id, plan_id, billing_month, platform_fee_ngn, support_fee_ngn)
    VALUES
      (v_tenant.id, v_plan.id, p_billing_month, v_plan.monthly_fee_ngn, v_support)
    ON CONFLICT (tenant_id, billing_month) DO NOTHING;

    -- Platform fee line item (idempotent guard)
    INSERT INTO api_billing_transactions
      (tenant_id, type, amount_ngn, description)
    SELECT
      v_tenant.id, 'platform_fee', v_plan.monthly_fee_ngn,
      format('Monthly API platform fee — %s plan (%s)',
        v_plan.name, to_char(p_billing_month, 'Mon YYYY'))
    WHERE NOT EXISTS (
      SELECT 1 FROM api_billing_transactions
      WHERE tenant_id = v_tenant.id
        AND type = 'platform_fee'
        AND date_trunc('month', created_at)::DATE = p_billing_month
    );

    -- Support fee line item
    IF v_support > 0 THEN
      INSERT INTO api_billing_transactions
        (tenant_id, type, amount_ngn, description)
      SELECT
        v_tenant.id, 'support_fee', v_support,
        format('Support staff — %s slot%s × ₦%s/mo (%s)',
          v_tenant.staff_count,
          CASE WHEN v_tenant.staff_count = 1 THEN '' ELSE 's' END,
          to_char(v_plan.support_staff_monthly_ngn, 'FM999,999'),
          to_char(p_billing_month, 'Mon YYYY'))
      WHERE NOT EXISTS (
        SELECT 1 FROM api_billing_transactions
        WHERE tenant_id = v_tenant.id
          AND type = 'support_fee'
          AND date_trunc('month', created_at)::DATE = p_billing_month
      );
    END IF;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION open_monthly_billing_cycle TO service_role;
