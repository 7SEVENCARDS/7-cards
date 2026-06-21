-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 015: Telegram-first vendor broadcast flow
-- Adds: vendor_trade_broadcasts, vendor_broadcast_messages,
--       card_pin on trades, VAN columns on vendor_card_assignments,
--       atomic claim function.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Store card PIN on trades so broadcast can carry it ────────────────────
ALTER TABLE trades ADD COLUMN IF NOT EXISTS card_pin TEXT;

-- ── 2. VAN-per-assignment columns on vendor_card_assignments ─────────────────
ALTER TABLE vendor_card_assignments ADD COLUMN IF NOT EXISTS trade_id UUID REFERENCES trades(id) ON DELETE SET NULL;
ALTER TABLE vendor_card_assignments ADD COLUMN IF NOT EXISTS claimed_via_telegram BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE vendor_card_assignments ADD COLUMN IF NOT EXISTS van_account_number TEXT;
ALTER TABLE vendor_card_assignments ADD COLUMN IF NOT EXISTS van_bank_name TEXT;
ALTER TABLE vendor_card_assignments ADD COLUMN IF NOT EXISTS van_amount_ngn NUMERIC(15,2);
ALTER TABLE vendor_card_assignments ADD COLUMN IF NOT EXISTS van_paid BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE vendor_card_assignments ADD COLUMN IF NOT EXISTS van_paid_at TIMESTAMPTZ;
ALTER TABLE vendor_card_assignments ADD COLUMN IF NOT EXISTS van_squad_ref TEXT;
ALTER TABLE vendor_card_assignments ADD COLUMN IF NOT EXISTS van_squad_account_id TEXT;
ALTER TABLE vendor_card_assignments ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE vendor_card_assignments ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ;

-- ── 3. payout_method already used in code, ensure it exists ─────────────────
ALTER TABLE trades ADD COLUMN IF NOT EXISTS payout_method TEXT
  CHECK (payout_method IN ('bank', 'wallet', 'vendor'));

-- ── 4. vendor_trade_broadcasts — one row per trade broadcast ─────────────────
CREATE TABLE IF NOT EXISTS vendor_trade_broadcasts (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_id             UUID        NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
  brand                TEXT        NOT NULL,
  amount_usd           NUMERIC(10,2) NOT NULL,
  amount_ngn           NUMERIC(15,2) NOT NULL,
  status               TEXT        NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','claimed','expired','cancelled')),
  claimed_by_vendor_id UUID        REFERENCES vendors(id),
  assignment_id        UUID,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at           TIMESTAMPTZ,
  expires_at           TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '15 minutes',
  CONSTRAINT vtb_trade_id_unique UNIQUE (trade_id)
);

CREATE INDEX IF NOT EXISTS idx_vtb_status_expires
  ON vendor_trade_broadcasts (status, expires_at);
CREATE INDEX IF NOT EXISTS idx_vtb_trade_id
  ON vendor_trade_broadcasts (trade_id);

-- ── 5. vendor_broadcast_messages — one row per Telegram message sent ─────────
CREATE TABLE IF NOT EXISTS vendor_broadcast_messages (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  broadcast_id        UUID        NOT NULL REFERENCES vendor_trade_broadcasts(id) ON DELETE CASCADE,
  vendor_id           UUID        NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  telegram_message_id BIGINT,
  sent_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vbm_broadcast_id ON vendor_broadcast_messages (broadcast_id);

-- ── 6. Atomic broadcast-claim function ───────────────────────────────────────
-- Returns (claimed BOOLEAN, assignment_id UUID).
-- Uses FOR UPDATE SKIP LOCKED to guarantee only the first caller succeeds.
CREATE OR REPLACE FUNCTION claim_vendor_broadcast(
  p_broadcast_id UUID,
  p_vendor_id    UUID
)
RETURNS TABLE (claimed BOOLEAN, out_assignment_id UUID)
LANGUAGE plpgsql
AS $$
DECLARE
  v_trade_id     UUID;
  v_brand        TEXT;
  v_amount_usd   NUMERIC;
  v_amount_ngn   NUMERIC;
  v_card_code    TEXT;
  v_card_pin     TEXT;
  v_assignment_id UUID;
BEGIN
  -- Lock exactly one pending, non-expired broadcast row.
  -- SKIP LOCKED means a concurrent caller gets nothing and returns claimed=false.
  SELECT b.trade_id, b.brand, b.amount_usd, b.amount_ngn
  INTO   v_trade_id, v_brand, v_amount_usd, v_amount_ngn
  FROM   vendor_trade_broadcasts b
  WHERE  b.id = p_broadcast_id
    AND  b.status = 'pending'
    AND  b.expires_at > now()
  FOR UPDATE SKIP LOCKED;

  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, NULL::UUID;
    RETURN;
  END IF;

  -- Pull card details from the trade
  SELECT t.card_code, t.card_pin
  INTO   v_card_code, v_card_pin
  FROM   trades t
  WHERE  t.id = v_trade_id;

  -- Create the assignment
  INSERT INTO vendor_card_assignments (
    vendor_id, trade_id, brand, amount_usd, amount_ngn,
    card_code, card_pin, status, claimed_via_telegram
  ) VALUES (
    p_vendor_id, v_trade_id, v_brand, v_amount_usd, v_amount_ngn,
    v_card_code, v_card_pin, 'assigned', TRUE
  )
  RETURNING id INTO v_assignment_id;

  -- Mark broadcast as claimed
  UPDATE vendor_trade_broadcasts SET
    status               = 'claimed',
    claimed_by_vendor_id = p_vendor_id,
    claimed_at           = now(),
    assignment_id        = v_assignment_id
  WHERE id = p_broadcast_id;

  RETURN QUERY SELECT TRUE, v_assignment_id;
END;
$$;

-- ── 7. Helper: expire stale broadcasts (called by cron or on-demand) ─────────
CREATE OR REPLACE FUNCTION expire_stale_broadcasts()
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE v_count INTEGER;
BEGIN
  UPDATE vendor_trade_broadcasts
  SET status = 'expired'
  WHERE status = 'pending' AND expires_at <= now();
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
