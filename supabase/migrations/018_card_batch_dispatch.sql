-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 018: Multi-Card Batch Dispatch
--
-- When a user submits N gift cards at once, each card becomes an independent
-- trade. The batch-dispatch engine distributes cards across DIFFERENT vendors
-- using round-robin rotation to reduce single-vendor exposure risk.
--
-- Dispatch strategies:
--   round_robin  — card[i] goes to vendor[i % total_vendors]
--   sequential   — only 1 vendor available; cards are queued and dispatched
--                  one at a time (next dispatches only after current completes)
--
-- Each trade records which batch it belongs to and its position within the
-- batch so the admin can reconstruct the full submission in order.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Batch metadata table ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS card_submission_batches (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  brand             TEXT         NOT NULL,
  amount_usd        NUMERIC(10,2) NOT NULL,
  exchange_rate     NUMERIC(10,4) NOT NULL,
  total_cards       INT          NOT NULL CHECK (total_cards >= 1),
  verified_cards    INT          NOT NULL DEFAULT 0,
  dispatched_cards  INT          NOT NULL DEFAULT 0,
  failed_cards      INT          NOT NULL DEFAULT 0,
  queued_cards      INT          NOT NULL DEFAULT 0,
  status            TEXT         NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing', 'completed', 'partial_failed', 'failed')),
  payout_method     TEXT         NOT NULL DEFAULT 'bank'
    CHECK (payout_method IN ('bank', 'wallet')),
  dispatch_strategy TEXT         NOT NULL DEFAULT 'round_robin'
    CHECK (dispatch_strategy IN ('round_robin', 'sequential')),
  vendor_count      INT          NOT NULL DEFAULT 0, -- vendors available at dispatch time
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);

ALTER TABLE card_submission_batches ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_read_own_batches"
  ON card_submission_batches FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "admin_read_all_batches"
  ON card_submission_batches FOR SELECT
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'));

CREATE INDEX IF NOT EXISTS idx_batches_user ON card_submission_batches (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_batches_status ON card_submission_batches (status, created_at DESC);

-- ── Link trades to their batch ─────────────────────────────────────────────────
ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS batch_id       UUID REFERENCES card_submission_batches(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS batch_position INT,     -- 1-based position in the batch
  ADD COLUMN IF NOT EXISTS batch_queued   BOOLEAN NOT NULL DEFAULT FALSE,
  -- For direct (non-broadcast) vendor assignment in batch dispatch:
  ADD COLUMN IF NOT EXISTS direct_vendor_id UUID REFERENCES vendors(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_trades_batch ON trades (batch_id, batch_position) WHERE batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_trades_direct_vendor ON trades (direct_vendor_id) WHERE direct_vendor_id IS NOT NULL;

-- ── Update batch status when a trade changes ───────────────────────────────────
-- Called after each trade in a batch changes status so the batch row stays current.
CREATE OR REPLACE FUNCTION sync_batch_status(p_batch_id UUID) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_total       INT;
  v_verified    INT;
  v_dispatched  INT;
  v_failed      INT;
  v_queued      INT;
  v_new_status  TEXT;
BEGIN
  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE status IN ('verified','processing','paid','escrow')),
    COUNT(*) FILTER (WHERE direct_vendor_id IS NOT NULL AND NOT batch_queued),
    COUNT(*) FILTER (WHERE status IN ('invalid','failed')),
    COUNT(*) FILTER (WHERE batch_queued = TRUE)
  INTO v_total, v_verified, v_dispatched, v_failed, v_queued
  FROM trades
  WHERE batch_id = p_batch_id;

  IF v_failed = v_total THEN
    v_new_status := 'failed';
  ELSIF (v_dispatched + v_failed) = v_total THEN
    IF v_failed > 0 THEN v_new_status := 'partial_failed';
    ELSE v_new_status := 'completed'; END IF;
  ELSE
    v_new_status := 'processing';
  END IF;

  UPDATE card_submission_batches
  SET
    verified_cards   = v_verified,
    dispatched_cards = v_dispatched,
    failed_cards     = v_failed,
    queued_cards     = v_queued,
    status           = v_new_status,
    updated_at       = now()
  WHERE id = p_batch_id;
END;
$$;

-- ── Helper: get the next queued trade in a sequential batch ───────────────────
-- Called by webhook/cron after a sequential-batch trade is marked completed.
-- Returns the next trade_id to dispatch, or NULL if none.
CREATE OR REPLACE FUNCTION get_next_queued_batch_trade(p_batch_id UUID)
RETURNS UUID LANGUAGE sql STABLE AS $$
  SELECT id
  FROM trades
  WHERE batch_id = p_batch_id
    AND batch_queued = TRUE
    AND status = 'verified'
  ORDER BY batch_position ASC
  LIMIT 1;
$$;
