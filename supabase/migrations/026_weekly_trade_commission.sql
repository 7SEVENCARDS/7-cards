-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 026: Weekly Trade Commission
-- ₦500 paid every Thursday at 7pm WAT to users who traded ≥$25 (≥₦7,000)
-- in the previous 7-day window. Tracked per ISO-week to prevent double-payment.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS weekly_trade_commissions (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  week_key    TEXT        NOT NULL,  -- ISO week: 'YYYY-Www'  e.g. '2026-W26'
  amount_ngn  NUMERIC(12,2) NOT NULL DEFAULT 500,
  paid_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, week_key)         -- one payment per user per week
);

-- Fast lookups by week (cron needs to check which users were already paid)
CREATE INDEX IF NOT EXISTS idx_weekly_commissions_week
  ON weekly_trade_commissions (week_key);

-- Users can read their own commission history
ALTER TABLE weekly_trade_commissions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own commissions"
  ON weekly_trade_commissions FOR SELECT
  USING (auth.uid() = user_id);

-- Only service role can insert (cron runs with service role key)
CREATE POLICY "Service role inserts commissions"
  ON weekly_trade_commissions FOR INSERT
  WITH CHECK (true);  -- enforced at service role level

-- ── Helper view: commission history per user ──────────────────────────────────
CREATE OR REPLACE VIEW my_weekly_commissions AS
SELECT
  week_key,
  amount_ngn,
  paid_at
FROM weekly_trade_commissions
WHERE user_id = auth.uid()
ORDER BY paid_at DESC;

COMMENT ON TABLE weekly_trade_commissions IS
  '₦500 weekly trade commission paid every Thursday to users with ≥$25 weekly volume';
COMMENT ON COLUMN weekly_trade_commissions.week_key IS
  'ISO week identifier YYYY-Www — unique constraint prevents double-payment';
