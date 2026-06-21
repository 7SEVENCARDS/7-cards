-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 021 — Third-party API tenancy layer
--
-- Enables external trading companies to use 7SEVEN's vendor network and
-- support staff as pure infrastructure. They submit gift cards → we verify
-- + dispatch to vendors → they receive webhooks on every status change.
--
-- Auth model: SHA-256-hashed Bearer tokens stored in api_keys.
-- Tenant isolation: api_tenant_trades + api_tenant_support_tickets join tables.
-- All API server calls use the service role key (bypasses RLS).
-- App-level admin policies are added for the admin dashboard.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. api_tenants ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS api_tenants (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT        NOT NULL,
  contact_email    TEXT        NOT NULL,
  status           TEXT        NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'suspended', 'terminated')),
  plan             TEXT        NOT NULL DEFAULT 'free'
                     CHECK (plan IN ('free', 'pro', 'enterprise')),
  rate_limit_rpm   INTEGER     NOT NULL DEFAULT 60,
  notes            TEXT,
  created_by       UUID        REFERENCES auth.users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT api_tenants_email_unique UNIQUE (contact_email)
);

-- ── 2. api_keys ───────────────────────────────────────────────────────────────
-- Keys are stored as SHA-256 hashes; plaintext is shown exactly once.
CREATE TABLE IF NOT EXISTS api_keys (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID        NOT NULL REFERENCES api_tenants(id) ON DELETE CASCADE,
  key_hash       TEXT        NOT NULL,          -- SHA-256(sk_live_...)
  key_prefix     TEXT        NOT NULL,          -- first 16 chars shown in UI
  label          TEXT        NOT NULL DEFAULT 'default',
  last_used_at   TIMESTAMPTZ,
  revoked_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT api_keys_hash_unique UNIQUE (key_hash)
);

CREATE INDEX IF NOT EXISTS idx_api_keys_tenant
  ON api_keys(tenant_id) WHERE revoked_at IS NULL;

-- ── 3. api_webhook_endpoints ──────────────────────────────────────────────────
-- TPOs register HTTPS URLs. We sign each delivery with HMAC-SHA256.
CREATE TABLE IF NOT EXISTS api_webhook_endpoints (
  id              UUID      PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID      NOT NULL REFERENCES api_tenants(id) ON DELETE CASCADE,
  url             TEXT      NOT NULL,
  events          TEXT[]    NOT NULL DEFAULT '{}',
  signing_secret  TEXT      NOT NULL,          -- whsec_... (shown once at creation)
  is_active       BOOLEAN   NOT NULL DEFAULT TRUE,
  failure_count   INTEGER   NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_api_webhook_endpoints_tenant
  ON api_webhook_endpoints(tenant_id) WHERE is_active = TRUE;

-- ── 4. api_webhook_deliveries ─────────────────────────────────────────────────
-- Delivery log with retry tracking. Retry schedule: 0s, 30s, 2m, 10m (max 4 attempts).
CREATE TABLE IF NOT EXISTS api_webhook_deliveries (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint_id      UUID        NOT NULL REFERENCES api_webhook_endpoints(id) ON DELETE CASCADE,
  event_type       TEXT        NOT NULL,
  payload          JSONB       NOT NULL,
  attempt_count    INTEGER     NOT NULL DEFAULT 0,
  last_attempt_at  TIMESTAMPTZ,
  last_status_code INTEGER,
  last_response    TEXT,
  delivered_at     TIMESTAMPTZ,             -- non-null = successfully delivered
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_api_webhook_deliveries_endpoint
  ON api_webhook_deliveries(endpoint_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_api_webhook_deliveries_pending
  ON api_webhook_deliveries(endpoint_id)
  WHERE delivered_at IS NULL AND attempt_count < 4;

-- ── 5. api_tenant_trades ──────────────────────────────────────────────────────
-- Links trades to the tenant that submitted them + stores the TPO's customer ref.
-- Trades themselves use a shared API_GATEWAY_USER_ID profile (see SETUP.md).
CREATE TABLE IF NOT EXISTS api_tenant_trades (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID        NOT NULL REFERENCES api_tenants(id) ON DELETE CASCADE,
  trade_id      UUID        NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
  customer_ref  TEXT,                       -- TPO's own reference for their customer
  batch_ref     TEXT,                       -- TPO's batch reference (for batch submits)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT api_tenant_trades_unique UNIQUE (tenant_id, trade_id)
);

CREATE INDEX IF NOT EXISTS idx_api_tenant_trades_tenant
  ON api_tenant_trades(tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_api_tenant_trades_customer
  ON api_tenant_trades(tenant_id, customer_ref) WHERE customer_ref IS NOT NULL;

-- ── 6. api_tenant_support_tickets ────────────────────────────────────────────
-- Links support tickets to the tenant that opened them on behalf of a customer.
CREATE TABLE IF NOT EXISTS api_tenant_support_tickets (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID        NOT NULL REFERENCES api_tenants(id) ON DELETE CASCADE,
  ticket_id      UUID        NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  customer_ref   TEXT,
  customer_name  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT api_tenant_tickets_unique UNIQUE (tenant_id, ticket_id)
);

CREATE INDEX IF NOT EXISTS idx_api_tenant_tickets_tenant
  ON api_tenant_support_tickets(tenant_id, created_at DESC);

-- ── 7. RLS ────────────────────────────────────────────────────────────────────
-- The Express API server always uses the service role key (bypasses RLS).
-- We only add authenticated policies for admin read access.

ALTER TABLE api_tenants              ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_webhook_endpoints    ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_webhook_deliveries   ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_tenant_trades        ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_tenant_support_tickets ENABLE ROW LEVEL SECURITY;

-- Service role has full access (used by api-server Express app)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'api_tenants' AND policyname = 'service_role_api_tenants'
  ) THEN
    CREATE POLICY service_role_api_tenants
      ON api_tenants FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'api_keys' AND policyname = 'service_role_api_keys'
  ) THEN
    CREATE POLICY service_role_api_keys
      ON api_keys FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'api_webhook_endpoints' AND policyname = 'service_role_api_webhooks'
  ) THEN
    CREATE POLICY service_role_api_webhooks
      ON api_webhook_endpoints FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'api_webhook_deliveries' AND policyname = 'service_role_api_deliveries'
  ) THEN
    CREATE POLICY service_role_api_deliveries
      ON api_webhook_deliveries FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'api_tenant_trades' AND policyname = 'service_role_tenant_trades'
  ) THEN
    CREATE POLICY service_role_tenant_trades
      ON api_tenant_trades FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'api_tenant_support_tickets' AND policyname = 'service_role_tenant_tickets'
  ) THEN
    CREATE POLICY service_role_tenant_tickets
      ON api_tenant_support_tickets FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Admin read policies (for admin dashboard server functions)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'api_tenants' AND policyname = 'admin_read_api_tenants'
  ) THEN
    CREATE POLICY admin_read_api_tenants
      ON api_tenants FOR SELECT TO authenticated
      USING (
        EXISTS (
          SELECT 1 FROM profiles
          WHERE profiles.id = auth.uid() AND profiles.role = 'admin'
        )
      );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'api_keys' AND policyname = 'admin_read_api_keys'
  ) THEN
    CREATE POLICY admin_read_api_keys
      ON api_keys FOR SELECT TO authenticated
      USING (
        EXISTS (
          SELECT 1 FROM profiles
          WHERE profiles.id = auth.uid() AND profiles.role = 'admin'
        )
      );
  END IF;
END $$;

-- ── 8. DB functions ───────────────────────────────────────────────────────────

-- provision_api_tenant: admin-only, creates tenant + hashed API key in one TX.
-- Returns plaintext key (shown ONCE — never stored).
-- Requires pgcrypto extension (already enabled in Supabase).
CREATE OR REPLACE FUNCTION provision_api_tenant(
  p_name          TEXT,
  p_contact_email TEXT,
  p_created_by    UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id  UUID;
  v_key_plain  TEXT;
  v_key_prefix TEXT;
  v_key_hash   TEXT;
BEGIN
  -- Admin guard
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = p_created_by AND role = 'admin'
  ) THEN
    RAISE EXCEPTION 'forbidden: admin only';
  END IF;

  INSERT INTO api_tenants (name, contact_email, created_by)
  VALUES (p_name, p_contact_email, p_created_by)
  RETURNING id INTO v_tenant_id;

  -- Generate key: sk_live_ + 32 lowercase hex chars = 40 chars total
  v_key_plain  := 'sk_live_' || encode(gen_random_bytes(16), 'hex');
  v_key_prefix := left(v_key_plain, 16);       -- e.g. sk_live_a3f9...
  v_key_hash   := encode(digest(v_key_plain, 'sha256'), 'hex');

  INSERT INTO api_keys (tenant_id, key_hash, key_prefix, label)
  VALUES (v_tenant_id, v_key_hash, v_key_prefix, 'default');

  RETURN jsonb_build_object(
    'tenant_id',  v_tenant_id,
    'api_key',    v_key_plain,     -- plaintext — shown once, never stored again
    'key_prefix', v_key_prefix
  );
END;
$$;

GRANT EXECUTE ON FUNCTION provision_api_tenant TO authenticated;

-- rotate_api_key: revoke old key, issue new one atomically.
CREATE OR REPLACE FUNCTION rotate_api_key(
  p_tenant_id UUID,
  p_key_id    UUID,
  p_admin_id  UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_key_plain  TEXT;
  v_key_prefix TEXT;
  v_key_hash   TEXT;
  v_new_id     UUID;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = p_admin_id AND role = 'admin'
  ) THEN
    RAISE EXCEPTION 'forbidden: admin only';
  END IF;

  UPDATE api_keys
  SET revoked_at = NOW()
  WHERE id = p_key_id AND tenant_id = p_tenant_id AND revoked_at IS NULL;

  v_key_plain  := 'sk_live_' || encode(gen_random_bytes(16), 'hex');
  v_key_prefix := left(v_key_plain, 16);
  v_key_hash   := encode(digest(v_key_plain, 'sha256'), 'hex');

  INSERT INTO api_keys (tenant_id, key_hash, key_prefix, label)
  VALUES (p_tenant_id, v_key_hash, v_key_prefix, 'rotated')
  RETURNING id INTO v_new_id;

  RETURN jsonb_build_object(
    'key_id',     v_new_id,
    'api_key',    v_key_plain,
    'key_prefix', v_key_prefix
  );
END;
$$;

GRANT EXECUTE ON FUNCTION rotate_api_key TO authenticated;

-- suspend / unsuspend tenant
CREATE OR REPLACE FUNCTION set_tenant_status(
  p_tenant_id UUID,
  p_status    TEXT,
  p_admin_id  UUID
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = p_admin_id AND role = 'admin'
  ) THEN
    RAISE EXCEPTION 'forbidden: admin only';
  END IF;

  IF p_status NOT IN ('active', 'suspended', 'terminated') THEN
    RAISE EXCEPTION 'invalid status';
  END IF;

  UPDATE api_tenants SET status = p_status WHERE id = p_tenant_id;
END;
$$;

GRANT EXECUTE ON FUNCTION set_tenant_status TO authenticated;
