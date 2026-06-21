-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 019: Vendor Rate Approval Workflow
--
-- When a vendor submits a new rate via Telegram, it now lands in a PENDING
-- state rather than being applied to live trades immediately.
-- The admin must review and approve, reject, or override it before it affects
-- the round-robin vendor-dispatch engine.
--
-- Schema changes:
--   vendors.pending_rate_ngn_per_usd      — rate submitted but not yet approved
--   vendors.pending_rate_submitted_at     — when the pending rate was submitted
--   vendors.pending_rate_history_id       — FK to the vendor_rate_history row
--
--   vendor_rate_history.status            — pending | approved | rejected | overridden
--   vendor_rate_history.approved_by       — admin user who actioned it
--   vendor_rate_history.actioned_at       — when the admin actioned it
--   vendor_rate_history.admin_notes       — optional admin comment
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE vendors
  ADD COLUMN IF NOT EXISTS pending_rate_ngn_per_usd   NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS pending_rate_submitted_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pending_rate_history_id    UUID;  -- set after history row inserted

ALTER TABLE vendor_rate_history
  ADD COLUMN IF NOT EXISTS status       TEXT NOT NULL DEFAULT 'approved'
    CHECK (status IN ('pending', 'approved', 'rejected', 'overridden')),
  ADD COLUMN IF NOT EXISTS approved_by  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS actioned_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS admin_notes  TEXT;

-- Backfill existing history rows as approved (they were applied directly)
UPDATE vendor_rate_history SET status = 'approved' WHERE status IS NULL OR status = 'approved';

-- Index for the admin dashboard: find all pending rate submissions quickly
CREATE INDEX IF NOT EXISTS idx_vendors_pending_rate
  ON vendors (pending_rate_submitted_at DESC)
  WHERE pending_rate_ngn_per_usd IS NOT NULL;

-- Index for rate history by status
CREATE INDEX IF NOT EXISTS idx_rate_history_status
  ON vendor_rate_history (vendor_id, status, created_at DESC);

-- ── Helper: approve a pending vendor rate ─────────────────────────────────────
-- Sets preferred_rate to the pending value, clears pending fields,
-- marks the history row as approved. Called by admin server function.
CREATE OR REPLACE FUNCTION approve_vendor_rate(
  p_vendor_id UUID,
  p_admin_id  UUID,
  p_notes     TEXT DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_pending_rate     NUMERIC(10,2);
  v_history_id       UUID;
BEGIN
  SELECT pending_rate_ngn_per_usd, pending_rate_history_id
  INTO v_pending_rate, v_history_id
  FROM vendors
  WHERE id = p_vendor_id;

  IF v_pending_rate IS NULL THEN
    RAISE EXCEPTION 'No pending rate for vendor %', p_vendor_id;
  END IF;

  -- Apply rate
  UPDATE vendors SET
    preferred_rate_ngn_per_usd  = v_pending_rate,
    rate_last_updated_at        = now(),
    pending_rate_ngn_per_usd    = NULL,
    pending_rate_submitted_at   = NULL,
    pending_rate_history_id     = NULL
  WHERE id = p_vendor_id;

  -- Mark history row approved
  IF v_history_id IS NOT NULL THEN
    UPDATE vendor_rate_history SET
      status      = 'approved',
      approved_by = p_admin_id,
      actioned_at = now(),
      admin_notes = p_notes
    WHERE id = v_history_id;
  END IF;
END;
$$;

-- ── Helper: reject a pending vendor rate ──────────────────────────────────────
CREATE OR REPLACE FUNCTION reject_vendor_rate(
  p_vendor_id UUID,
  p_admin_id  UUID,
  p_notes     TEXT DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_history_id UUID;
BEGIN
  SELECT pending_rate_history_id INTO v_history_id FROM vendors WHERE id = p_vendor_id;

  UPDATE vendors SET
    pending_rate_ngn_per_usd  = NULL,
    pending_rate_submitted_at = NULL,
    pending_rate_history_id   = NULL
  WHERE id = p_vendor_id;

  IF v_history_id IS NOT NULL THEN
    UPDATE vendor_rate_history SET
      status      = 'rejected',
      approved_by = p_admin_id,
      actioned_at = now(),
      admin_notes = p_notes
    WHERE id = v_history_id;
  END IF;
END;
$$;
