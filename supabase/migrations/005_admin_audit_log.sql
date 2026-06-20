-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 005: Admin Audit Log
-- Immutable record of every admin write action for accountability & forensics.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id    UUID        NOT NULL REFERENCES profiles(id) ON DELETE SET NULL,
  action      TEXT        NOT NULL,   -- e.g. 'kyc_approve', 'rate_update', 'credit_wallet'
  target_id   TEXT,                   -- UUID of affected user / trade / entity (nullable)
  meta        JSONB,                  -- arbitrary action-specific context
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Admins can insert only; no updates or deletes (immutability)
ALTER TABLE admin_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can insert audit rows"
  ON admin_audit_log FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
        AND profiles.role = 'admin'
    )
  );

CREATE POLICY "Admins can read audit log"
  ON admin_audit_log FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
        AND profiles.role = 'admin'
    )
  );

-- Index for common query patterns
CREATE INDEX IF NOT EXISTS idx_audit_admin_id  ON admin_audit_log (admin_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action    ON admin_audit_log (action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_target_id ON admin_audit_log (target_id, created_at DESC);
