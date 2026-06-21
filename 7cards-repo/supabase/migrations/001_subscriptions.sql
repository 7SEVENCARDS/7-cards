-- ─── Subscriptions table ──────────────────────────────────────────────────────
-- Run this in Supabase SQL Editor after the main schema.sql
-- (or append to schema.sql before first run)

CREATE TABLE IF NOT EXISTS subscriptions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  plan             TEXT NOT NULL DEFAULT 'premium',        -- 'premium' | 'free'
  status           TEXT NOT NULL DEFAULT 'active',         -- 'active' | 'cancelled' | 'expired'
  amount_ngn       INTEGER NOT NULL DEFAULT 2000,
  transaction_ref  TEXT UNIQUE,                            -- Squadco transaction ref
  payment_ref      TEXT,                                   -- Squadco payment ref
  started_at       TIMESTAMPTZ DEFAULT now(),
  expires_at       TIMESTAMPTZ,                            -- NULL = lifetime / manual cancel
  cancelled_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own subscriptions"
  ON subscriptions FOR SELECT USING (auth.uid() = user_id);

-- Index for fast lookup
CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_ref ON subscriptions(transaction_ref);

-- When a subscription is inserted/updated as active → flip profiles.premium = true
CREATE OR REPLACE FUNCTION sync_premium_flag()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NEW.status = 'active' THEN
    UPDATE profiles SET premium = true WHERE id = NEW.user_id;
  ELSIF NEW.status IN ('cancelled', 'expired') THEN
    -- Only un-set premium if there's no other active subscription
    UPDATE profiles SET premium = false
    WHERE id = NEW.user_id
      AND NOT EXISTS (
        SELECT 1 FROM subscriptions
        WHERE user_id = NEW.user_id AND status = 'active' AND id <> NEW.id
      );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_sync_premium
  AFTER INSERT OR UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION sync_premium_flag();
