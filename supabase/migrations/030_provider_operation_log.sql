-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 030: Provider Operation Log
-- Immutable audit trail for every identity and payment gateway call.
-- Records provider used, latency, failover events, success/failure.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS provider_operation_log (
  id            BIGSERIAL    PRIMARY KEY,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),

  -- Which gateway and provider handled the call
  gateway       TEXT         NOT NULL CHECK (gateway IN ('identity', 'payment')),
  provider      TEXT         NOT NULL,   -- 'mono', 'dojah', 'squad', etc.
  operation     TEXT         NOT NULL,   -- 'verifyBVN', 'initiatePayout', etc.

  -- Tracing
  request_id    TEXT         NOT NULL,   -- UUID per gateway call
  reference     TEXT,                    -- trade_id, bvn, account_number, etc.
  user_id       UUID         REFERENCES auth.users(id) ON DELETE SET NULL,

  -- Result
  success       BOOLEAN      NOT NULL,
  failover      BOOLEAN      NOT NULL DEFAULT false,
  latency_ms    INTEGER      NOT NULL,
  error_message TEXT
);

-- Immutable — no updates or deletes allowed
CREATE OR REPLACE RULE provider_operation_log_no_update AS
  ON UPDATE TO provider_operation_log DO INSTEAD NOTHING;

CREATE OR REPLACE RULE provider_operation_log_no_delete AS
  ON DELETE TO provider_operation_log DO INSTEAD NOTHING;

-- Indexes for dashboard queries
CREATE INDEX IF NOT EXISTS idx_pol_gateway_provider  ON provider_operation_log (gateway, provider);
CREATE INDEX IF NOT EXISTS idx_pol_created_at        ON provider_operation_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pol_user_id           ON provider_operation_log (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pol_failover          ON provider_operation_log (failover) WHERE failover = true;
CREATE INDEX IF NOT EXISTS idx_pol_operation         ON provider_operation_log (operation);

-- RLS: only service role can insert; admins can read via server functions
ALTER TABLE provider_operation_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_full_access"
  ON provider_operation_log
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ── Provider health monitoring view ───────────────────────────────────────────
-- Returns per-provider stats for the last 24h: success rate, avg latency,
-- failover count. Used by admin dashboard provider status panel.

CREATE OR REPLACE VIEW v_provider_health AS
SELECT
  gateway,
  provider,
  operation,
  COUNT(*)                                                    AS total_calls,
  COUNT(*) FILTER (WHERE success)                             AS successful,
  COUNT(*) FILTER (WHERE NOT success)                         AS failed,
  COUNT(*) FILTER (WHERE failover)                            AS failover_calls,
  ROUND(
    COUNT(*) FILTER (WHERE success)::NUMERIC / NULLIF(COUNT(*), 0) * 100, 1
  )                                                           AS success_rate_pct,
  ROUND(AVG(latency_ms))                                      AS avg_latency_ms,
  MAX(latency_ms)                                             AS max_latency_ms,
  MIN(created_at)                                             AS window_start,
  MAX(created_at)                                             AS window_end
FROM provider_operation_log
WHERE created_at > now() - INTERVAL '24 hours'
GROUP BY gateway, provider, operation
ORDER BY gateway, provider, operation;

-- ── Recent failover events view ───────────────────────────────────────────────
CREATE OR REPLACE VIEW v_recent_failovers AS
SELECT
  id,
  created_at,
  gateway,
  provider,
  operation,
  reference,
  latency_ms,
  error_message
FROM provider_operation_log
WHERE failover = true
  AND created_at > now() - INTERVAL '7 days'
ORDER BY created_at DESC
LIMIT 200;
