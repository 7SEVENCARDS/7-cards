-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 017: Vendor Rate Check System
--
-- Enables the 6-hourly Telegram rate-check flow:
--   1. Cron hits /api/cron/rate-check every 6h
--   2. Bot messages each active vendor: "Has your rate changed? YES / NO"
--   3. YES → bot asks "Send new rate (₦ per $1)"
--   4. Vendor replies with a number → saved here, admin alerted immediately
--
-- New columns on vendors:
--   preferred_rate_ngn_per_usd  — current vendor rate (₦ per $1 USD)
--   rate_last_updated_at        — when vendor last changed their rate
--   last_rate_check_sent_at     — when we last sent the rate-check ping
--   telegram_bot_state          — FSM state for multi-turn Telegram conversations
--   telegram_bot_state_at       — when state was entered (for stale-state cleanup)
--   telegram_bot_state_data     — JSON context for the current state (e.g. previous rate)
--
-- New table:
--   vendor_rate_history         — immutable log of every rate change
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE vendors
  ADD COLUMN IF NOT EXISTS preferred_rate_ngn_per_usd NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS rate_last_updated_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_rate_check_sent_at    TIMESTAMPTZ,
  -- Finite-state machine for multi-turn Telegram conversations.
  -- NULL  = idle (normal broadcast flow)
  -- rate_check_pending = we asked "has rate changed?" — awaiting YES/NO
  -- awaiting_new_rate  = vendor said YES — awaiting the numeric value
  ADD COLUMN IF NOT EXISTS telegram_bot_state      TEXT
    CHECK (telegram_bot_state IN ('rate_check_pending', 'awaiting_new_rate')),
  ADD COLUMN IF NOT EXISTS telegram_bot_state_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS telegram_bot_state_data JSONB;

-- ── Immutable rate change log ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vendor_rate_history (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id         UUID        NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  old_rate          NUMERIC(10,2),            -- null on first-ever set
  new_rate          NUMERIC(10,2) NOT NULL,
  changed_via       TEXT        NOT NULL DEFAULT 'telegram'
    CHECK (changed_via IN ('telegram', 'admin', 'portal')),
  admin_notified_at TIMESTAMPTZ,              -- set when admin alert was sent
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE vendor_rate_history ENABLE ROW LEVEL SECURITY;

-- Vendors can read their own history; admins can read all
CREATE POLICY "vendor_read_own_rate_history"
  ON vendor_rate_history FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM vendors WHERE id = vendor_id AND user_id = auth.uid())
    OR
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );

CREATE INDEX IF NOT EXISTS idx_rate_history_vendor ON vendor_rate_history (vendor_id, created_at DESC);

-- ── Auto-cleanup stale bot states ─────────────────────────────────────────────
-- If a vendor never replies, their state would be stuck forever.
-- This function resets states older than 2 hours — call it from the cron job.
CREATE OR REPLACE FUNCTION cleanup_stale_bot_states() RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE vendors
  SET
    telegram_bot_state      = NULL,
    telegram_bot_state_at   = NULL,
    telegram_bot_state_data = NULL
  WHERE
    telegram_bot_state IS NOT NULL
    AND telegram_bot_state_at < NOW() - INTERVAL '2 hours';
END;
$$;

-- ── Index for cron: finding vendors due for a rate check ──────────────────────
CREATE INDEX IF NOT EXISTS idx_vendors_rate_check
  ON vendors (last_rate_check_sent_at NULLS FIRST)
  WHERE status = 'active';
