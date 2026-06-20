-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 014: Production Hardening
-- Safe to re-run (idempotent). All objects use IF NOT EXISTS.
--
-- Changes:
--   1. processed_webhook_events — atomic deduplication table for Squad webhooks
--   2. Missing performance indexes on hot query paths
--   3. Additional DB-level constraints for data integrity
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── 1. Webhook event deduplication ──────────────────────────────────────────
-- Prevents double-execution when Squad retries a webhook delivery.
-- Insert happens BEFORE processing; unique constraint on event_key makes the
-- INSERT fail fast if another worker already started the same event.

CREATE TABLE IF NOT EXISTS processed_webhook_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key   TEXT NOT NULL,               -- e.g. "payout:REF123:transfer.success"
  source      TEXT NOT NULL DEFAULT 'squadco',
  status      TEXT NOT NULL DEFAULT 'processing', -- processing | done | failed
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  error_msg   TEXT,
  CONSTRAINT processed_webhook_events_event_key_unique UNIQUE (event_key)
);

-- RLS: only service role can access this table
ALTER TABLE processed_webhook_events ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_webhook_events_received
  ON processed_webhook_events (received_at DESC);

-- Auto-cleanup: delete events older than 30 days (webhook replays don't
-- happen beyond 72h so 30d gives plenty of audit runway)
CREATE OR REPLACE FUNCTION cleanup_old_webhook_events() RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  DELETE FROM processed_webhook_events
  WHERE received_at < NOW() - INTERVAL '30 days';
END;
$$;

-- ─── 2. Missing performance indexes ──────────────────────────────────────────

-- trades ordered by creation time — used in admin trade list, history screens
CREATE INDEX IF NOT EXISTS idx_trades_created_at
  ON trades (created_at DESC);

-- trades by (status, created_at) — used in escrow queue and processing queries
CREATE INDEX IF NOT EXISTS idx_trades_status_created
  ON trades (status, created_at DESC);

-- vendor_card_assignments by trade_id — trade → assignment lookup
CREATE INDEX IF NOT EXISTS idx_vendor_assignments_trade_id
  ON vendor_card_assignments (trade_id);

-- notifications unread count — used on every app load
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
  ON notifications (user_id, read)
  WHERE read = false;

-- vendor_transactions by type — used in wallet reconciliation
CREATE INDEX IF NOT EXISTS idx_vendor_transactions_type
  ON vendor_transactions (vendor_id, type, created_at DESC);

-- ─── 3. Data integrity constraints ───────────────────────────────────────────

-- trades: amount_ngn must be positive when set
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'trades_amount_ngn_positive'
  ) THEN
    ALTER TABLE trades
      ADD CONSTRAINT trades_amount_ngn_positive
      CHECK (amount_ngn IS NULL OR amount_ngn > 0);
  END IF;
END;
$$;

-- trades: amount_usd must be positive when set
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'trades_amount_usd_positive'
  ) THEN
    ALTER TABLE trades
      ADD CONSTRAINT trades_amount_usd_positive
      CHECK (amount_usd IS NULL OR amount_usd > 0);
  END IF;
END;
$$;

-- wallets: balance cannot go negative (belt-and-suspenders with the RPC check)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'wallets_balance_non_negative'
  ) THEN
    ALTER TABLE wallets
      ADD CONSTRAINT wallets_balance_non_negative
      CHECK (balance >= 0);
  END IF;
END;
$$;

-- vendor_wallets: balance cannot go negative
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'vendor_wallets_balance_non_negative'
  ) THEN
    ALTER TABLE vendor_wallets
      ADD CONSTRAINT vendor_wallets_balance_non_negative
      CHECK (balance >= 0);
  END IF;
END;
$$;

-- vendor_card_assignments: amount_ngn must be positive
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'vendor_assignments_amount_positive'
  ) THEN
    ALTER TABLE vendor_card_assignments
      ADD CONSTRAINT vendor_assignments_amount_positive
      CHECK (amount_ngn IS NULL OR amount_ngn > 0);
  END IF;
END;
$$;
