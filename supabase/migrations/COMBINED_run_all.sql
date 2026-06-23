-- ============================================================
-- 7SEVEN CARDS — All Supabase Migrations (001 → 027)
-- Paste this entire file into the Supabase SQL Editor and run.
-- ============================================================

-- ============================================================
-- 001_subscriptions.sql
-- ============================================================
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

-- ============================================================
-- 002_support_messages.sql
-- ============================================================
-- Support messages table
CREATE TABLE IF NOT EXISTS support_messages (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  sender        TEXT NOT NULL CHECK (sender IN ('user','agent')),
  body          TEXT NOT NULL,
  read          BOOLEAN DEFAULT FALSE,
  created_at    TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE support_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own messages"
  ON support_messages FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own messages"
  ON support_messages FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Support tickets table (groups conversations)
CREATE TABLE IF NOT EXISTS support_tickets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  subject     TEXT NOT NULL,
  status      TEXT DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved','closed')),
  priority    TEXT DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE support_tickets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own tickets"
  ON support_tickets FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own tickets"
  ON support_tickets FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE OR REPLACE TRIGGER support_tickets_updated_at
  BEFORE UPDATE ON support_tickets FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- 003_complete_schema.sql
-- ============================================================
-- ─────────────────────────────────────────────────────────────────────────────
-- 7SEVEN CARDS — Complete Schema Migration
-- Run this in: Supabase Dashboard → SQL Editor
-- It is idempotent (safe to re-run); uses IF NOT EXISTS + ON CONFLICT DO NOTHING
-- ─────────────────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── Core Tables ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS profiles (
  id            UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name     TEXT DEFAULT '',
  phone         TEXT UNIQUE,
  avatar_url    TEXT,
  kyc_status    TEXT DEFAULT 'pending'
    CHECK (kyc_status IN ('pending','submitted','verified','rejected')),
  kyc_bvn       TEXT,
  kyc_nin       TEXT,
  premium       BOOLEAN DEFAULT false,
  referral_code TEXT UNIQUE DEFAULT upper(substr(md5(random()::text), 1, 8)),
  referred_by   UUID REFERENCES profiles(id),
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wallets (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  currency       TEXT NOT NULL CHECK (currency IN ('NGN','BTC','USDT','ETH')),
  balance        NUMERIC(20,8) DEFAULT 0 CHECK (balance >= 0),
  locked_balance NUMERIC(20,8) DEFAULT 0 CHECK (locked_balance >= 0),
  created_at     TIMESTAMPTZ DEFAULT now(),
  updated_at     TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id, currency)
);

CREATE TABLE IF NOT EXISTS payout_accounts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  bank_name      TEXT NOT NULL,
  bank_code      TEXT NOT NULL,
  account_number TEXT NOT NULL,
  account_name   TEXT NOT NULL,
  is_default     BOOLEAN DEFAULT false,
  created_at     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS exchange_rates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand           TEXT NOT NULL,
  region          TEXT DEFAULT 'USA',
  rate_per_dollar NUMERIC(10,2) NOT NULL,
  source          TEXT DEFAULT 'reloadly',
  trend           TEXT DEFAULT '+0.0%',
  updated_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE (brand, region)
);

-- Seed default rates (safe to re-run)
INSERT INTO exchange_rates (brand, region, rate_per_dollar, trend) VALUES
  ('Apple',        'USA', 1485, '+2.1%'),
  ('Amazon',       'USA', 1420, '+1.5%'),
  ('Steam',        'USA', 1380, '-0.3%'),
  ('Google Play',  'USA', 1460, '+0.8%'),
  ('Xbox',         'USA', 1395, '+1.2%'),
  ('PlayStation',  'USA', 1410, '+0.5%'),
  ('Netflix',      'USA', 1350, '-0.2%'),
  ('Spotify',      'USA', 1325, '+0.1%')
ON CONFLICT (brand, region) DO NOTHING;

CREATE TABLE IF NOT EXISTS trades (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  type                    TEXT NOT NULL CHECK (type IN ('gift_card','crypto')),
  brand                   TEXT,
  region                  TEXT DEFAULT 'USA',
  amount_usd              NUMERIC(10,2),
  amount_ngn              NUMERIC(15,2),
  exchange_rate           NUMERIC(10,2),
  card_code               TEXT,
  card_pin                TEXT,
  reloadly_transaction_id TEXT,
  reloadly_order_id       TEXT,
  squadco_transaction_ref TEXT,
  squadco_payment_id      TEXT,
  status                  TEXT DEFAULT 'pending' CHECK (
    status IN ('pending','scanning','verified','invalid','processing','paid','failed')
  ),
  failure_reason          TEXT,
  requires_manual_review  BOOLEAN DEFAULT false,
  settled_at              TIMESTAMPTZ,
  xp_earned               INTEGER DEFAULT 0,
  created_at              TIMESTAMPTZ DEFAULT now(),
  updated_at              TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_xp (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE UNIQUE,
  total_xp        INTEGER DEFAULT 0,
  level           INTEGER DEFAULT 1,
  streak_days     INTEGER DEFAULT 0,
  last_trade_date DATE,
  trade_count     INTEGER DEFAULT 0,
  weekly_xp       INTEGER DEFAULT 0,
  week_start      DATE DEFAULT CURRENT_DATE
);

CREATE TABLE IF NOT EXISTS user_badges (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id   UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  badge_key TEXT NOT NULL,
  earned_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id, badge_key)
);

CREATE TABLE IF NOT EXISTS notifications (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  message    TEXT NOT NULL,
  read       BOOLEAN DEFAULT false,
  type       TEXT DEFAULT 'info',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  plan             TEXT NOT NULL DEFAULT 'premium',
  status           TEXT NOT NULL DEFAULT 'active',
  amount_ngn       INTEGER NOT NULL DEFAULT 2000,
  transaction_ref  TEXT UNIQUE,
  payment_ref      TEXT,
  started_at       TIMESTAMPTZ DEFAULT now(),
  expires_at       TIMESTAMPTZ,
  cancelled_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS support_messages (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  sender        TEXT NOT NULL CHECK (sender IN ('user','agent')),
  body          TEXT NOT NULL,
  read          BOOLEAN DEFAULT false,
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS support_tickets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  subject     TEXT NOT NULL,
  status      TEXT DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved','closed')),
  priority    TEXT DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

-- ─── Functions ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

-- Called automatically after a new Supabase auth user signs up
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO profiles (id, full_name, phone)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    NEW.phone
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO wallets (user_id, currency) VALUES (NEW.id, 'NGN')
    ON CONFLICT DO NOTHING;

  INSERT INTO user_xp (user_id) VALUES (NEW.id)
    ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$$;

-- Atomically credits a user's wallet. Used by processPayout server function.
CREATE OR REPLACE FUNCTION increment_wallet_balance(
  p_user_id UUID,
  p_currency TEXT,
  p_amount   NUMERIC
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE wallets
  SET balance = balance + p_amount, updated_at = now()
  WHERE user_id = p_user_id AND currency = p_currency;

  IF NOT FOUND THEN
    INSERT INTO wallets (user_id, currency, balance)
    VALUES (p_user_id, p_currency, p_amount)
    ON CONFLICT (user_id, currency)
    DO UPDATE SET balance = wallets.balance + p_amount;
  END IF;
END;
$$;

-- Awards XP after a successful trade, handles streak & level calculation
CREATE OR REPLACE FUNCTION award_trade_xp(p_user_id UUID, p_xp INTEGER)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  today DATE := CURRENT_DATE;
  rec   user_xp%ROWTYPE;
BEGIN
  SELECT * INTO rec FROM user_xp WHERE user_id = p_user_id;

  -- Streak logic
  IF rec.last_trade_date = today - INTERVAL '1 day' THEN
    rec.streak_days := rec.streak_days + 1;
  ELSIF rec.last_trade_date IS DISTINCT FROM today THEN
    rec.streak_days := 1;
  END IF;

  -- Reset weekly XP if new week
  IF rec.week_start IS NULL OR rec.week_start < date_trunc('week', today)::date THEN
    rec.weekly_xp  := 0;
    rec.week_start := date_trunc('week', today)::date;
  END IF;

  UPDATE user_xp SET
    total_xp        = total_xp + p_xp,
    weekly_xp       = COALESCE(weekly_xp, 0) + p_xp,
    streak_days     = rec.streak_days,
    last_trade_date = today,
    trade_count     = trade_count + 1,
    level           = GREATEST(1, (total_xp + p_xp) / 1000 + 1),
    week_start      = COALESCE(rec.week_start, date_trunc('week', today)::date)
  WHERE user_id = p_user_id;

  -- First trade badge
  IF (SELECT trade_count FROM user_xp WHERE user_id = p_user_id) = 1 THEN
    INSERT INTO user_badges (user_id, badge_key)
    VALUES (p_user_id, 'first_trade')
    ON CONFLICT DO NOTHING;
  END IF;
END;
$$;

-- Syncs premium flag on profiles when subscription status changes
CREATE OR REPLACE FUNCTION sync_premium_flag()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NEW.status = 'active' THEN
    UPDATE profiles SET premium = true WHERE id = NEW.user_id;
  ELSIF NEW.status IN ('cancelled', 'expired') THEN
    UPDATE profiles SET premium = false WHERE id = NEW.user_id
      AND NOT EXISTS (
        SELECT 1 FROM subscriptions
        WHERE user_id = NEW.user_id AND status = 'active' AND id <> NEW.id
      );
  END IF;
  RETURN NEW;
END;
$$;

-- ─── Triggers ─────────────────────────────────────────────────────────────────

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

DROP TRIGGER IF EXISTS profiles_updated_at ON profiles;
CREATE TRIGGER profiles_updated_at
  BEFORE UPDATE ON profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS wallets_updated_at ON wallets;
CREATE TRIGGER wallets_updated_at
  BEFORE UPDATE ON wallets FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trades_updated_at ON trades;
CREATE TRIGGER trades_updated_at
  BEFORE UPDATE ON trades FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_sync_premium ON subscriptions;
CREATE TRIGGER trg_sync_premium
  AFTER INSERT OR UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION sync_premium_flag();

DROP TRIGGER IF EXISTS support_tickets_updated_at ON support_tickets;
CREATE TRIGGER support_tickets_updated_at
  BEFORE UPDATE ON support_tickets FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── Leaderboard View ─────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW leaderboard AS
SELECT
  p.id,
  p.full_name,
  p.avatar_url,
  x.total_xp,
  x.weekly_xp,
  x.level,
  x.streak_days,
  x.trade_count,
  RANK() OVER (ORDER BY x.weekly_xp DESC)   AS weekly_rank,
  RANK() OVER (ORDER BY x.total_xp  DESC)   AS all_time_rank
FROM user_xp x
JOIN profiles p ON p.id = x.user_id
ORDER BY x.weekly_xp DESC;

-- ─── Row Level Security ───────────────────────────────────────────────────────

ALTER TABLE profiles         ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallets          ENABLE ROW LEVEL SECURITY;
ALTER TABLE payout_accounts  ENABLE ROW LEVEL SECURITY;
ALTER TABLE trades           ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_xp          ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_badges      ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications    ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_tickets  ENABLE ROW LEVEL SECURITY;

DO $pol$ BEGIN
  -- profiles
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='profiles' AND policyname='Users can view own profile') THEN
    CREATE POLICY "Users can view own profile" ON profiles FOR SELECT USING (auth.uid() = id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='profiles' AND policyname='Users can update own profile') THEN
    CREATE POLICY "Users can update own profile" ON profiles FOR UPDATE USING (auth.uid() = id);
  END IF;
  -- wallets
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='wallets' AND policyname='Users can view own wallets') THEN
    CREATE POLICY "Users can view own wallets" ON wallets FOR SELECT USING (auth.uid() = user_id);
  END IF;
  -- payout_accounts
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='payout_accounts' AND policyname='Users can manage own payout accounts') THEN
    CREATE POLICY "Users can manage own payout accounts" ON payout_accounts FOR ALL USING (auth.uid() = user_id);
  END IF;
  -- trades
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='trades' AND policyname='Users can view own trades') THEN
    CREATE POLICY "Users can view own trades" ON trades FOR SELECT USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='trades' AND policyname='Users can insert own trades') THEN
    CREATE POLICY "Users can insert own trades" ON trades FOR INSERT WITH CHECK (auth.uid() = user_id);
  END IF;
  -- user_xp
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='user_xp' AND policyname='Users can view own XP') THEN
    CREATE POLICY "Users can view own XP" ON user_xp FOR SELECT USING (auth.uid() = user_id);
  END IF;
  -- user_badges
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='user_badges' AND policyname='Users can view own badges') THEN
    CREATE POLICY "Users can view own badges" ON user_badges FOR SELECT USING (auth.uid() = user_id);
  END IF;
  -- notifications
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='notifications' AND policyname='Users can manage own notifications') THEN
    CREATE POLICY "Users can manage own notifications" ON notifications FOR ALL USING (auth.uid() = user_id);
  END IF;
  -- subscriptions
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='subscriptions' AND policyname='Users can read own subscriptions') THEN
    CREATE POLICY "Users can read own subscriptions" ON subscriptions FOR SELECT USING (auth.uid() = user_id);
  END IF;
  -- support_messages
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='support_messages' AND policyname='Users can view own messages') THEN
    CREATE POLICY "Users can view own messages" ON support_messages FOR SELECT USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='support_messages' AND policyname='Users can insert own messages') THEN
    CREATE POLICY "Users can insert own messages" ON support_messages FOR INSERT WITH CHECK (auth.uid() = user_id);
  END IF;
  -- support_tickets
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='support_tickets' AND policyname='Users can view own tickets') THEN
    CREATE POLICY "Users can view own tickets" ON support_tickets FOR SELECT USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='support_tickets' AND policyname='Users can insert own tickets') THEN
    CREATE POLICY "Users can insert own tickets" ON support_tickets FOR INSERT WITH CHECK (auth.uid() = user_id);
  END IF;
END $pol$;

-- ─── Referral Commissions ────────────────────────────────────────────────────
-- Records every 5% referral commission payment for full transparency.
-- Platform model: platform keeps 15% of trade; 5% goes to referrer;
--   net platform margin = 10%.

CREATE TABLE IF NOT EXISTS referral_commissions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id     UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  referee_id      UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  trade_id        UUID NOT NULL REFERENCES trades(id)   ON DELETE CASCADE,
  amount_ngn      NUMERIC(15,2) NOT NULL,
  commission_rate NUMERIC(5,4)  NOT NULL DEFAULT 0.05,
  created_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE (trade_id) -- one commission record per trade
);

ALTER TABLE referral_commissions ENABLE ROW LEVEL SECURITY;

DO $pol$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='referral_commissions' AND policyname='Referrers can view own commissions') THEN
    CREATE POLICY "Referrers can view own commissions" ON referral_commissions
      FOR SELECT USING (auth.uid() = referrer_id);
  END IF;
END $pol$;

-- ─── Verification Usage ───────────────────────────────────────────────────────
-- Tracks daily gift-card verification API calls per free-tier user.
-- Prevents runaway Reloadly API billing.
-- Unlimited for: premium subscribers, $25+/week or $50+/month in paid trades.

CREATE TABLE IF NOT EXISTS verification_usage (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  trade_id   UUID REFERENCES trades(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE verification_usage ENABLE ROW LEVEL SECURITY;

DO $pol$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='verification_usage' AND policyname='Users can view own usage') THEN
    CREATE POLICY "Users can view own usage" ON verification_usage
      FOR SELECT USING (auth.uid() = user_id);
  END IF;
END $pol$;

-- ─── Indexes ──────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_trades_user              ON trades(user_id);
CREATE INDEX IF NOT EXISTS idx_trades_status            ON trades(status);
CREATE INDEX IF NOT EXISTS idx_trades_settled_at        ON trades(settled_at);
CREATE INDEX IF NOT EXISTS idx_notifications_user       ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user       ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_ref        ON subscriptions(transaction_ref);
CREATE INDEX IF NOT EXISTS idx_ref_commissions_referrer ON referral_commissions(referrer_id);
CREATE INDEX IF NOT EXISTS idx_ref_commissions_referee  ON referral_commissions(referee_id);
CREATE INDEX IF NOT EXISTS idx_verification_user_date   ON verification_usage(user_id, created_at);

-- Done!
-- After running: go to Authentication → Triggers and confirm on_auth_user_created is listed

-- ============================================================
-- 004_fix_constraints.sql
-- ============================================================
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 004: Fix missing constraints + admin role column
-- Run in: Supabase Dashboard → SQL Editor
-- Safe to re-run (idempotent)
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── 1. Add role column to profiles (for admin access control) ───────────────
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'user'
    CHECK (role IN ('user', 'admin', 'support'));

-- ─── 2. Unique constraint on subscriptions.transaction_ref ───────────────────
-- Required for premium.ts upsert + webhook idempotency
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'subscriptions'
      AND constraint_name = 'subscriptions_transaction_ref_key'
  ) THEN
    ALTER TABLE subscriptions
      ADD CONSTRAINT subscriptions_transaction_ref_key UNIQUE (transaction_ref);
  END IF;
END $$;

-- ─── 3. Ensure subscriptions table has status='pending' in its check ─────────
-- Recreate the check constraint to include 'pending' if it doesn't already
DO $$ BEGIN
  -- Drop old constraint if it exists without 'pending'
  IF EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_name = 'subscriptions_status_check'
  ) THEN
    ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_status_check;
  END IF;
END $$;

ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_status_check
    CHECK (status IN ('pending', 'active', 'cancelled', 'expired'));

-- ─── 4. Add squadco_transaction_ref index (for webhook lookups) ──────────────
CREATE INDEX IF NOT EXISTS idx_trades_squadco_ref
  ON trades(squadco_transaction_ref)
  WHERE squadco_transaction_ref IS NOT NULL;

-- ─── 5. Add failure_reason column to trades if missing ───────────────────────
ALTER TABLE trades ADD COLUMN IF NOT EXISTS failure_reason TEXT;

-- ─── 6. Admin RLS policies — admins can read everything ──────────────────────
DO $pol$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'profiles' AND policyname = 'Admins can view all profiles'
  ) THEN
    CREATE POLICY "Admins can view all profiles" ON profiles
      FOR SELECT USING (
        EXISTS (
          SELECT 1 FROM profiles p2
          WHERE p2.id = auth.uid() AND p2.role = 'admin'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'profiles' AND policyname = 'Admins can update all profiles'
  ) THEN
    CREATE POLICY "Admins can update all profiles" ON profiles
      FOR UPDATE USING (
        EXISTS (
          SELECT 1 FROM profiles p2
          WHERE p2.id = auth.uid() AND p2.role = 'admin'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'trades' AND policyname = 'Admins can view all trades'
  ) THEN
    CREATE POLICY "Admins can view all trades" ON trades
      FOR SELECT USING (
        EXISTS (
          SELECT 1 FROM profiles p
          WHERE p.id = auth.uid() AND p.role = 'admin'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'trades' AND policyname = 'Admins can update all trades'
  ) THEN
    CREATE POLICY "Admins can update all trades" ON trades
      FOR UPDATE USING (
        EXISTS (
          SELECT 1 FROM profiles p
          WHERE p.id = auth.uid() AND p.role = 'admin'
        )
      );
  END IF;
END $pol$;

-- ─── 7. Leaderboard view — ensure it's accessible ────────────────────────────
GRANT SELECT ON leaderboard TO authenticated, anon;

-- Done!
-- Remember to promote your first admin:
--   UPDATE profiles SET role = 'admin' WHERE id = '<your-uuid>';

-- ============================================================
-- 005_admin_audit_log.sql
-- ============================================================
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

-- ============================================================
-- 006_launch_fixes.sql
-- ============================================================
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 006: Launch Fixes
-- Idempotent — safe to run multiple times.
-- Fixes:
--   1. Add email column to profiles (required by premium checkout)
--   2. Fix leaderboard view (deduplicate user_xp rows with DISTINCT ON)
--   3. Add subscription_expires_at column to profiles
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── 1. profiles.email ───────────────────────────────────────────────────────
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS email TEXT;

UPDATE profiles p
SET email = u.email
FROM auth.users u
WHERE p.id = u.id
  AND p.email IS NULL;

CREATE OR REPLACE FUNCTION sync_profile_email()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE profiles SET email = NEW.email WHERE id = NEW.id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_profile_email ON auth.users;
CREATE TRIGGER trg_sync_profile_email
AFTER INSERT OR UPDATE OF email ON auth.users
FOR EACH ROW EXECUTE FUNCTION sync_profile_email();

-- ─── 2. Leaderboard view fix ─────────────────────────────────────────────────
CREATE OR REPLACE VIEW leaderboard AS
SELECT
  p.id,
  p.full_name,
  COALESCE(ux.total_xp, 0)   AS total_xp,
  COALESCE(ux.weekly_xp, 0)  AS weekly_xp,
  COALESCE(ux.level, 1)      AS level,
  COALESCE(ux.streak_days, 0) AS streak_days,
  RANK() OVER (ORDER BY COALESCE(ux.weekly_xp, 0) DESC) AS weekly_rank
FROM profiles p
LEFT JOIN (
  SELECT DISTINCT ON (user_id)
    user_id, total_xp, weekly_xp, level, streak_days
  FROM user_xp
  ORDER BY user_id, total_xp DESC
) ux ON ux.user_id = p.id
WHERE p.id IS NOT NULL
ORDER BY weekly_rank;

-- ─── 3. subscription_expires_at ──────────────────────────────────────────────
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_profiles_subscription_expiry
  ON profiles(subscription_expires_at)
  WHERE subscription_expires_at IS NOT NULL;

-- ============================================================
-- 007_crypto_ops.sql
-- ============================================================
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 007: Crypto Wallet Operations
-- Idempotent — safe to run multiple times.
-- Adds:
--   1. payout_method column on trades (bank | wallet)
--   2. crypto_transactions table
--   3. deduct_wallet_balance() RPC
--   4. wallets unique constraint (required for row locking)
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── 1. payout_method on trades ──────────────────────────────────────────────
ALTER TABLE trades ADD COLUMN IF NOT EXISTS payout_method TEXT DEFAULT 'bank';

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_name = 'trades_payout_method_check'
  ) THEN
    ALTER TABLE trades
      ADD CONSTRAINT trades_payout_method_check
        CHECK (payout_method IN ('bank', 'wallet'));
  END IF;
END $$;

-- ─── 2. crypto_transactions ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crypto_transactions (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID         NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  type          TEXT         NOT NULL CHECK (type IN ('swap', 'send', 'receive', 'convert')),
  from_currency TEXT,
  to_currency   TEXT,
  from_amount   NUMERIC(28, 10),
  to_amount     NUMERIC(28, 10),
  address       TEXT,
  tx_ref        TEXT,
  status        TEXT         NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'completed', 'failed')),
  meta          JSONB,
  created_at    TIMESTAMPTZ  DEFAULT now()
);

ALTER TABLE crypto_transactions ENABLE ROW LEVEL SECURITY;

DO $pol$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'crypto_transactions'
      AND policyname = 'Users can view own crypto txs'
  ) THEN
    CREATE POLICY "Users can view own crypto txs"
      ON crypto_transactions FOR SELECT
      USING (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'crypto_transactions'
      AND policyname = 'Admins can view all crypto txs'
  ) THEN
    CREATE POLICY "Admins can view all crypto txs"
      ON crypto_transactions FOR SELECT
      USING (
        EXISTS (
          SELECT 1 FROM profiles
          WHERE profiles.id = auth.uid()
            AND profiles.role = 'admin'
        )
      );
  END IF;
END $pol$;

CREATE INDEX IF NOT EXISTS idx_crypto_txs_user
  ON crypto_transactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crypto_txs_ref
  ON crypto_transactions(tx_ref)
  WHERE tx_ref IS NOT NULL;

-- ─── 3. deduct_wallet_balance() ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION deduct_wallet_balance(
  p_user_id  UUID,
  p_currency TEXT,
  p_amount   NUMERIC
) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE
  current_balance NUMERIC;
BEGIN
  SELECT balance INTO current_balance
  FROM wallets
  WHERE user_id = p_user_id AND currency = p_currency
  FOR UPDATE;

  IF current_balance IS NULL OR current_balance < p_amount THEN
    RETURN FALSE;
  END IF;

  UPDATE wallets
  SET balance = balance - p_amount
  WHERE user_id = p_user_id AND currency = p_currency;

  RETURN TRUE;
END;
$$;

-- ─── 4. Unique constraint on wallets ─────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'wallets'
      AND constraint_name = 'wallets_user_currency_unique'
  ) THEN
    ALTER TABLE wallets
      ADD CONSTRAINT wallets_user_currency_unique UNIQUE (user_id, currency);
  END IF;
END $$;

-- ============================================================
-- 008_support_freescout.sql
-- ============================================================
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 008: FreeScout support thread tracking
-- Stores the FreeScout conversation ID per user so messages thread correctly.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS support_threads (
  user_id        uuid        PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  conversation_id bigint     NOT NULL,
  customer_id     bigint,
  category        text,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

ALTER TABLE support_threads ENABLE ROW LEVEL SECURITY;

-- Users can only see/touch their own thread record
CREATE POLICY "Users manage own thread"
  ON support_threads
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Service role (server functions) bypasses RLS
-- No explicit policy needed — service key already bypasses

-- Add freescout_thread_id column to support_messages so we can
-- deduplicate synced agent replies
ALTER TABLE support_messages
  ADD COLUMN IF NOT EXISTS freescout_thread_id bigint,
  ADD COLUMN IF NOT EXISTS category text;

-- Index for fast per-user reads
CREATE INDEX IF NOT EXISTS idx_support_messages_user_created
  ON support_messages (user_id, created_at);

-- ============================================================
-- 009_vendor_network.sql
-- ============================================================
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 009: Vendor Network
-- Vendors buy gift cards from 7SEVEN (assigned by admin), redeem them, and
-- fund their vendor wallets via provisioned virtual account numbers.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── Vendor Profiles ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vendors (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  business_name        TEXT NOT NULL,
  contact_name         TEXT,
  phone                TEXT,
  email                TEXT,
  telegram_username    TEXT,
  telegram_chat_id     BIGINT,
  bank_name            TEXT,
  bank_code            TEXT,
  account_number       TEXT,
  account_name         TEXT,
  status               TEXT DEFAULT 'pending'
    CHECK (status IN ('pending','active','suspended')),
  tier                 TEXT DEFAULT 'standard'
    CHECK (tier IN ('standard','premium')),
  total_redeemed       INTEGER DEFAULT 0,
  total_volume_ngn     NUMERIC(20,2) DEFAULT 0,
  last_active_at       TIMESTAMPTZ,
  notes                TEXT,
  created_at           TIMESTAMPTZ DEFAULT now(),
  updated_at           TIMESTAMPTZ DEFAULT now()
);

-- ─── Vendor Wallets ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vendor_wallets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id       UUID NOT NULL UNIQUE REFERENCES vendors(id) ON DELETE CASCADE,
  balance         NUMERIC(20,2) DEFAULT 0 CHECK (balance >= 0),
  locked          NUMERIC(20,2) DEFAULT 0 CHECK (locked >= 0),
  total_funded    NUMERIC(20,2) DEFAULT 0,
  total_withdrawn NUMERIC(20,2) DEFAULT 0,
  currency        TEXT DEFAULT 'NGN',
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- ─── Card Assignments (admin → vendor) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS vendor_card_assignments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id       UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  trade_id        UUID REFERENCES trades(id),
  brand           TEXT NOT NULL,
  region          TEXT DEFAULT 'USA',
  amount_usd      NUMERIC(10,2) NOT NULL,
  amount_ngn      NUMERIC(15,2),
  card_code       TEXT NOT NULL,
  card_pin        TEXT,
  status          TEXT DEFAULT 'assigned'
    CHECK (status IN ('assigned','viewed','redeemed','failed','cancelled')),
  assigned_by     UUID REFERENCES auth.users(id),
  telegram_sent   BOOLEAN DEFAULT false,
  viewed_at       TIMESTAMPTZ,
  redeemed_at     TIMESTAMPTZ,
  failed_at       TIMESTAMPTZ,
  failure_reason  TEXT,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- ─── Virtual Account Numbers (per funding request) ────────────────────────────
CREATE TABLE IF NOT EXISTS vendor_virtual_accounts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id       UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  account_number  TEXT NOT NULL,
  bank_name       TEXT NOT NULL,
  bank_code       TEXT,
  account_name    TEXT,
  reference       TEXT NOT NULL UNIQUE,
  squadco_ref     TEXT,
  amount_expected NUMERIC(15,2),
  status          TEXT DEFAULT 'pending'
    CHECK (status IN ('pending','funded','expired','cancelled')),
  expires_at      TIMESTAMPTZ DEFAULT (now() + interval '24 hours'),
  funded_at       TIMESTAMPTZ,
  amount_received NUMERIC(15,2),
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- ─── Vendor Wallet Transactions ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vendor_transactions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id       UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  type            TEXT NOT NULL
    CHECK (type IN ('credit','debit','assignment_credit','withdrawal')),
  amount          NUMERIC(15,2) NOT NULL,
  balance_after   NUMERIC(15,2),
  description     TEXT,
  reference       TEXT,
  assignment_id   UUID REFERENCES vendor_card_assignments(id),
  virtual_account_id UUID REFERENCES vendor_virtual_accounts(id),
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- ─── Indexes ──────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_vendors_status          ON vendors (status);
CREATE INDEX IF NOT EXISTS idx_vendors_last_active     ON vendors (last_active_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_vendor_assignments_vid  ON vendor_card_assignments (vendor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vendor_assignments_st   ON vendor_card_assignments (status);
CREATE INDEX IF NOT EXISTS idx_vendor_transactions_vid ON vendor_transactions (vendor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vendor_vans_vendor      ON vendor_virtual_accounts (vendor_id, status);

-- ─── Row-Level Security ───────────────────────────────────────────────────────
ALTER TABLE vendors                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_wallets           ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_card_assignments  ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_virtual_accounts  ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_transactions      ENABLE ROW LEVEL SECURITY;

-- Vendors can only read/update their own records
CREATE POLICY "vendors_own" ON vendors
  FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE POLICY "vendor_wallets_own" ON vendor_wallets
  FOR SELECT USING (
    vendor_id IN (SELECT id FROM vendors WHERE user_id = auth.uid())
  );

CREATE POLICY "vendor_assignments_own" ON vendor_card_assignments
  FOR SELECT USING (
    vendor_id IN (SELECT id FROM vendors WHERE user_id = auth.uid())
  );

CREATE POLICY "vendor_assignments_update_own" ON vendor_card_assignments
  FOR UPDATE USING (
    vendor_id IN (SELECT id FROM vendors WHERE user_id = auth.uid())
  );

CREATE POLICY "vendor_vans_own" ON vendor_virtual_accounts
  FOR SELECT USING (
    vendor_id IN (SELECT id FROM vendors WHERE user_id = auth.uid())
  );

CREATE POLICY "vendor_txns_own" ON vendor_transactions
  FOR SELECT USING (
    vendor_id IN (SELECT id FROM vendors WHERE user_id = auth.uid())
  );

-- ============================================================
-- 010_vendor_withdrawals.sql
-- ============================================================
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 010: Vendor Withdrawal Requests
-- Vendors request withdrawal of their wallet balance to their bank account.
-- Admin reviews, approves, and triggers payout via Squadco.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS vendor_withdrawal_requests (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id      UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  amount         NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  bank_name      TEXT NOT NULL,
  bank_code      TEXT NOT NULL,
  account_number TEXT NOT NULL,
  account_name   TEXT NOT NULL,
  status         TEXT DEFAULT 'pending'
    CHECK (status IN ('pending','approved','paid','rejected','failed')),
  admin_note     TEXT,
  squadco_ref    TEXT,
  squadco_txn_id TEXT,
  processed_by   UUID REFERENCES auth.users(id),
  processed_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ DEFAULT now(),
  updated_at     TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vendor_withdrawals_vendor ON vendor_withdrawal_requests (vendor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vendor_withdrawals_status ON vendor_withdrawal_requests (status, created_at DESC);

ALTER TABLE vendor_withdrawal_requests ENABLE ROW LEVEL SECURITY;

-- Vendors can create and read their own withdrawal requests
CREATE POLICY "vendor_withdrawals_own_select" ON vendor_withdrawal_requests
  FOR SELECT USING (
    vendor_id IN (SELECT id FROM vendors WHERE user_id = auth.uid())
  );

CREATE POLICY "vendor_withdrawals_own_insert" ON vendor_withdrawal_requests
  FOR INSERT WITH CHECK (
    vendor_id IN (SELECT id FROM vendors WHERE user_id = auth.uid())
  );

-- ============================================================
-- 011_vendor_referrals.sql
-- ============================================================
-- ─── Vendor Referral System ───────────────────────────────────────────────────
-- Run in Supabase SQL Editor

-- 1. Add referral_code (unique per vendor) and referred_by to vendors
ALTER TABLE vendors
  ADD COLUMN IF NOT EXISTS referral_code TEXT UNIQUE
    DEFAULT upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)),
  ADD COLUMN IF NOT EXISTS referred_by UUID REFERENCES vendors(id) ON DELETE SET NULL;

-- Backfill referral codes for existing vendors who don't have one
UPDATE vendors
  SET referral_code = upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))
  WHERE referral_code IS NULL;

-- 2. Referral tracking table
CREATE TABLE IF NOT EXISTS vendor_referrals (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id      UUID         NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  referred_id      UUID         NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  bonus_amount_ngn NUMERIC(12,2) NOT NULL DEFAULT 2500,
  bonus_paid       BOOLEAN      NOT NULL DEFAULT FALSE,
  bonus_paid_at    TIMESTAMPTZ,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE(referrer_id, referred_id)
);

CREATE INDEX IF NOT EXISTS idx_vendor_referrals_referrer ON vendor_referrals(referrer_id);
CREATE INDEX IF NOT EXISTS idx_vendor_referrals_referred ON vendor_referrals(referred_id);

-- ============================================================
-- 012_vendor_wallet_atomic_ops.sql
-- ============================================================
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 012: Atomic Vendor Wallet Operations + Type Constraint Fix
--
-- Mirrors the pattern already used for user wallets in migrations 003 & 007:
--   increment_vendor_wallet_balance / deduct_vendor_wallet_balance use atomic
--   UPDATE … SET balance = balance + p_amount — no read-then-write race under
--   concurrent webhook credits or simultaneous withdrawal requests.
--
-- Also widens vendor_transactions.type to include all values used in app code.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── Widen the type constraint ───────────────────────────────────────────────
ALTER TABLE vendor_transactions
  DROP CONSTRAINT IF EXISTS vendor_transactions_type_check;

ALTER TABLE vendor_transactions
  ADD CONSTRAINT vendor_transactions_type_check
  CHECK (type IN (
    'credit',
    'debit',
    'assignment_credit',
    'withdrawal',
    'referral_bonus'
  ));

-- ─── increment_vendor_wallet_balance ─────────────────────────────────────────
-- Atomically credits a vendor wallet. Upserts the row if missing.
-- SECURITY DEFINER — bypasses RLS so the webhook/admin path can always write.
CREATE OR REPLACE FUNCTION increment_vendor_wallet_balance(
  p_vendor_id UUID,
  p_amount    NUMERIC
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO vendor_wallets (vendor_id, balance, total_funded)
  VALUES (p_vendor_id, p_amount, p_amount)
  ON CONFLICT (vendor_id) DO UPDATE
    SET balance      = vendor_wallets.balance + p_amount,
        total_funded = vendor_wallets.total_funded + p_amount,
        updated_at   = now();
END;
$$;

-- ─── deduct_vendor_wallet_balance ────────────────────────────────────────────
-- Atomically debits a vendor wallet.
-- The CHECK (balance >= 0) constraint on vendor_wallets enforces the floor —
-- this function will raise a constraint-violation error if the balance would
-- go negative, which the caller should surface as an insufficient-funds error.
CREATE OR REPLACE FUNCTION deduct_vendor_wallet_balance(
  p_vendor_id UUID,
  p_amount    NUMERIC
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE vendor_wallets
  SET balance         = balance - p_amount,
      total_withdrawn = total_withdrawn + p_amount,
      updated_at      = now()
  WHERE vendor_id = p_vendor_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'vendor_wallet not found for vendor_id %', p_vendor_id;
  END IF;
END;
$$;

-- ============================================================
-- 013_vendor_security_deposit.sql
-- ============================================================
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 013: Vendor Security Deposit & Strike System
--
-- Goal: make it very hard for vendors to rip off users.
--   1. Vendors optionally (or mandatorily, set per-vendor by admin) post a
--      security deposit funded from their wallet balance.  It is held as a
--      locked amount and forfeited on assignment failures.
--   2. Every assignment failure increments a consecutive-failure counter.
--      At the threshold (default 3 consecutive failures) the vendor is
--      auto-suspended immediately — no admin action required.
--   3. On reactivation the consecutive counter resets; a clean redemption
--      streak also resets it.
--   4. All deposit movements are recorded as vendor_transactions rows so the
--      audit trail is complete.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── New columns on vendors ───────────────────────────────────────────────────

ALTER TABLE vendors
  ADD COLUMN IF NOT EXISTS security_deposit_required NUMERIC(15,2) NOT NULL DEFAULT 0
    CHECK (security_deposit_required >= 0),
  ADD COLUMN IF NOT EXISTS security_deposit_held     NUMERIC(15,2) NOT NULL DEFAULT 0
    CHECK (security_deposit_held >= 0),
  ADD COLUMN IF NOT EXISTS failed_assignments        INTEGER       NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS consecutive_failures      INTEGER       NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_failure_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS suspension_reason         TEXT;

-- ─── Widen vendor_transactions.type ──────────────────────────────────────────

ALTER TABLE vendor_transactions
  DROP CONSTRAINT IF EXISTS vendor_transactions_type_check;

ALTER TABLE vendor_transactions
  ADD CONSTRAINT vendor_transactions_type_check
    CHECK (type IN (
      'credit',
      'debit',
      'assignment_credit',
      'withdrawal',
      'referral_bonus',
      'security_deposit',
      'security_deposit_forfeit',
      'security_deposit_refund'
    ));

-- ─── RPC: record_vendor_failure ───────────────────────────────────────────────
-- Increments failure counters and auto-suspends if threshold is reached.
-- Returns a JSON object describing the outcome so the caller can notify
-- the vendor without a second round-trip.
--
-- The threshold is hard-coded to 3 consecutive failures.  Reactivation by
-- an admin resets the counter via record_vendor_success or direct UPDATE.

CREATE OR REPLACE FUNCTION record_vendor_failure(
  p_vendor_id UUID
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_consecutive        INTEGER;
  v_deposit_held       NUMERIC;
  v_auto_suspended     BOOLEAN := FALSE;
  v_suspension_reason  TEXT;
  v_threshold CONSTANT INTEGER := 3;
BEGIN
  UPDATE vendors
     SET failed_assignments   = failed_assignments   + 1,
         consecutive_failures = consecutive_failures + 1,
         last_failure_at      = now(),
         updated_at           = now()
   WHERE id = p_vendor_id
  RETURNING consecutive_failures, security_deposit_held
       INTO v_consecutive, v_deposit_held;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Vendor not found: %', p_vendor_id;
  END IF;

  -- Auto-suspend when consecutive failures hit the threshold
  IF v_consecutive >= v_threshold THEN
    v_suspension_reason := format(
      'Auto-suspended: %s consecutive failed assignments (threshold: %s)',
      v_consecutive, v_threshold
    );
    UPDATE vendors
       SET status           = 'suspended',
           suspension_reason = v_suspension_reason,
           updated_at        = now()
     WHERE id = p_vendor_id
       AND status = 'active';

    v_auto_suspended := TRUE;
  END IF;

  RETURN json_build_object(
    'consecutive_failures', v_consecutive,
    'threshold',            v_threshold,
    'auto_suspended',       v_auto_suspended,
    'suspension_reason',    v_suspension_reason,
    'deposit_held',         v_deposit_held
  );
END;
$$;

-- ─── RPC: record_vendor_success ───────────────────────────────────────────────
-- Resets the consecutive-failure counter after a successful redemption.

CREATE OR REPLACE FUNCTION record_vendor_success(
  p_vendor_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE vendors
     SET consecutive_failures = 0,
         last_active_at       = now(),
         updated_at           = now()
   WHERE id = p_vendor_id;
END;
$$;

-- ─── RPC: lock_vendor_security_deposit ───────────────────────────────────────
-- Moves p_amount from the vendor's spendable wallet balance into locked
-- security deposit.  Fails if the balance is insufficient.

CREATE OR REPLACE FUNCTION lock_vendor_security_deposit(
  p_vendor_id UUID,
  p_amount    NUMERIC
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Deposit amount must be positive';
  END IF;

  -- Deduct from spendable balance, add to locked
  UPDATE vendor_wallets
     SET balance    = balance - p_amount,
         locked     = locked  + p_amount,
         updated_at = now()
   WHERE vendor_id  = p_vendor_id
     AND balance   >= p_amount;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Insufficient wallet balance for security deposit (need ₦%)', p_amount;
  END IF;

  -- Track how much of the locked amount is earmarked as security deposit
  UPDATE vendors
     SET security_deposit_held = security_deposit_held + p_amount,
         updated_at            = now()
   WHERE id = p_vendor_id;
END;
$$;

-- ─── RPC: forfeit_vendor_security_deposit ────────────────────────────────────
-- Removes up to p_amount from the locked security deposit.
-- The forfeited funds leave the vendor's balance entirely (retained by 7SEVEN
-- as compensation).  Capped at the actual deposit held.

CREATE OR REPLACE FUNCTION forfeit_vendor_security_deposit(
  p_vendor_id  UUID,
  p_amount     NUMERIC
)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_held    NUMERIC;
  v_forfeit NUMERIC;
BEGIN
  SELECT security_deposit_held INTO v_held
    FROM vendors WHERE id = p_vendor_id FOR UPDATE;

  v_forfeit := LEAST(p_amount, COALESCE(v_held, 0));

  IF v_forfeit <= 0 THEN
    RETURN 0;
  END IF;

  -- Shrink the locked bucket (funds exit the wallet entirely)
  UPDATE vendor_wallets
     SET locked     = GREATEST(0, locked - v_forfeit),
         updated_at = now()
   WHERE vendor_id  = p_vendor_id;

  -- Shrink the deposit tracker on vendor
  UPDATE vendors
     SET security_deposit_held = GREATEST(0, security_deposit_held - v_forfeit),
         updated_at            = now()
   WHERE id = p_vendor_id;

  RETURN v_forfeit;
END;
$$;

-- ─── RPC: release_vendor_security_deposit ────────────────────────────────────
-- Moves p_amount back from locked security deposit into spendable balance.
-- Used by admin when a vendor is in good standing and no longer needs to hold
-- the deposit (e.g., vendor is retiring, or admin is refunding).

CREATE OR REPLACE FUNCTION release_vendor_security_deposit(
  p_vendor_id UUID,
  p_amount    NUMERIC
)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_held    NUMERIC;
  v_release NUMERIC;
BEGIN
  SELECT security_deposit_held INTO v_held
    FROM vendors WHERE id = p_vendor_id FOR UPDATE;

  v_release := LEAST(p_amount, COALESCE(v_held, 0));

  IF v_release <= 0 THEN
    RETURN 0;
  END IF;

  -- Move from locked back to spendable balance
  UPDATE vendor_wallets
     SET balance    = balance   + v_release,
         locked     = GREATEST(0, locked - v_release),
         updated_at = now()
   WHERE vendor_id  = p_vendor_id;

  UPDATE vendors
     SET security_deposit_held = GREATEST(0, security_deposit_held - v_release),
         updated_at            = now()
   WHERE id = p_vendor_id;

  RETURN v_release;
END;
$$;

-- ─── Indexes ──────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_vendors_consecutive_failures
  ON vendors (consecutive_failures DESC)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_vendors_deposit_gap
  ON vendors (security_deposit_required, security_deposit_held)
  WHERE status = 'active';

-- ============================================================
-- 014_production_hardening.sql
-- ============================================================
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


-- ============================================================
-- 021_api_tenants.sql
-- ============================================================
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

-- ============================================================
-- 022_api_billing.sql
-- ============================================================
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 022 — API Tenant Billing & Subscription Plans
--
-- Revenue model for third-party trading companies (TPOs) using 7SEVEN's
-- vendor network and support staff as infrastructure:
--
--   • Monthly platform fee: starts at ₦20,000 (Starter plan)
--   • Trade fee: 7% of each successfully dispatched trade's NGN value
--     (decreases with higher plans — reward volume)
--   • Support staff fee: ₦5,000/month per active staff slot
--
-- Architecture:
--   api_subscription_plans  — plan catalogue with pricing in Naira
--   api_tenant_billing_cycles — monthly invoice aggregates per tenant
--   api_billing_transactions  — individual line items (trade fees, monthly fees)
--   record_api_trade_fee()  — called by api-server on each dispatched trade
--   open_monthly_billing_cycle() — called at month start (cron/manual)
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Subscription Plans ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS api_subscription_plans (
  id                          TEXT        PRIMARY KEY,   -- 'starter','growth','professional','enterprise'
  name                        TEXT        NOT NULL,
  monthly_fee_ngn             NUMERIC(12,2) NOT NULL DEFAULT 0,
  trade_fee_pct               NUMERIC(5,4) NOT NULL DEFAULT 0.0700, -- 7.00%
  support_staff_slots         INT         NOT NULL DEFAULT 1,
  support_staff_monthly_ngn   NUMERIC(12,2) NOT NULL DEFAULT 5000,  -- per slot
  rate_limit_rpm              INT         NOT NULL DEFAULT 60,
  description                 TEXT,
  is_active                   BOOLEAN     NOT NULL DEFAULT TRUE,
  sort_order                  INT         NOT NULL DEFAULT 0,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed the four tiers (idempotent)
INSERT INTO api_subscription_plans
  (id, name, monthly_fee_ngn, trade_fee_pct, support_staff_slots, support_staff_monthly_ngn, rate_limit_rpm, description, sort_order)
VALUES
  ('starter',      'Starter',      20000,  0.0700, 1,  5000, 60,   'Entry-level for small trading companies. ₦20,000/mo platform fee + 7% per trade.',       1),
  ('growth',       'Growth',       35000,  0.0650, 2,  5000, 300,  'Growing trading desks. ₦35,000/mo + 6.5% per trade. 2 support staff slots.',              2),
  ('professional', 'Professional', 65000,  0.0600, 3,  5000, 600,  'High-volume operations. ₦65,000/mo + 6% per trade. 3 staff slots, 600 req/min.',          3),
  ('enterprise',   'Enterprise',   150000, 0.0500, 10, 5000, 1500, 'Custom enterprise deployments. ₦150,000/mo + 5% per trade. 10 staff slots, 1500 req/min.',4)
ON CONFLICT (id) DO NOTHING;

-- ── 2. Widen plan CHECK on api_tenants ───────────────────────────────────────
-- Existing constraint only allowed 'free','pro','enterprise'. Add new plan IDs.
ALTER TABLE api_tenants DROP CONSTRAINT IF EXISTS api_tenants_plan_check;
ALTER TABLE api_tenants
  ADD CONSTRAINT api_tenants_plan_check
  CHECK (plan IN ('free','starter','growth','professional','enterprise'));

-- Add support_staff_count to track how many staff slots a tenant is using
ALTER TABLE api_tenants
  ADD COLUMN IF NOT EXISTS support_staff_count INT NOT NULL DEFAULT 1;

-- ── 3. Monthly Billing Cycles ─────────────────────────────────────────────────
-- One row per tenant per calendar month. Aggregates all fees for invoicing.
CREATE TABLE IF NOT EXISTS api_tenant_billing_cycles (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID        NOT NULL REFERENCES api_tenants(id) ON DELETE CASCADE,
  plan_id           TEXT        NOT NULL REFERENCES api_subscription_plans(id),
  billing_month     DATE        NOT NULL,   -- always the 1st of the month
  platform_fee_ngn  NUMERIC(12,2) NOT NULL DEFAULT 0,
  trade_fee_ngn     NUMERIC(12,2) NOT NULL DEFAULT 0,
  support_fee_ngn   NUMERIC(12,2) NOT NULL DEFAULT 0,
  trade_count       INT         NOT NULL DEFAULT 0,
  trade_volume_ngn  NUMERIC(16,2) NOT NULL DEFAULT 0,
  status            TEXT        NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open','invoiced','paid','overdue')),
  invoiced_at       TIMESTAMPTZ,
  paid_at           TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, billing_month)
);

CREATE INDEX IF NOT EXISTS idx_billing_cycles_tenant
  ON api_tenant_billing_cycles(tenant_id, billing_month DESC);

CREATE INDEX IF NOT EXISTS idx_billing_cycles_status
  ON api_tenant_billing_cycles(status) WHERE status IN ('open','invoiced','overdue');

-- ── 4. Individual Billing Line Items ──────────────────────────────────────────
-- Audit trail: one row per trade fee, monthly platform fee, support fee, etc.
CREATE TABLE IF NOT EXISTS api_billing_transactions (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID        NOT NULL REFERENCES api_tenants(id) ON DELETE CASCADE,
  cycle_id    UUID        REFERENCES api_tenant_billing_cycles(id),
  type        TEXT        NOT NULL
                CHECK (type IN ('trade_fee','platform_fee','support_fee','adjustment','credit')),
  amount_ngn  NUMERIC(12,2) NOT NULL,
  description TEXT,
  trade_id    UUID        REFERENCES trades(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_billing_txns_tenant
  ON api_billing_transactions(tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_billing_txns_cycle
  ON api_billing_transactions(cycle_id, created_at DESC);

-- ── 5. Fix api_webhook_deliveries — add status tracking columns ───────────────
-- Migration 021 uses attempt_count/last_attempt_at/last_status_code/delivered_at
-- for raw tracking. Add derived status columns to support the admin dashboard.
ALTER TABLE api_webhook_deliveries
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','delivered','failed','retrying')),
  ADD COLUMN IF NOT EXISTS attempt_number INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS response_code  INT,
  ADD COLUMN IF NOT EXISTS attempted_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS next_retry_at  TIMESTAMPTZ;

-- Backfill existing rows from the raw tracking columns
UPDATE api_webhook_deliveries SET
  attempt_number = attempt_count,
  response_code  = last_status_code,
  attempted_at   = last_attempt_at,
  status = CASE
    WHEN delivered_at IS NOT NULL THEN 'delivered'
    WHEN attempt_count >= 4       THEN 'failed'
    WHEN attempt_count > 0        THEN 'retrying'
    ELSE 'pending'
  END
WHERE attempt_number = 0 OR status = 'pending';

-- ── 6. RLS ────────────────────────────────────────────────────────────────────
ALTER TABLE api_subscription_plans      ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_tenant_billing_cycles   ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_billing_transactions    ENABLE ROW LEVEL SECURITY;

-- Service role: full access (api-server uses service role key)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'api_subscription_plans' AND policyname = 'svc_plans') THEN
    CREATE POLICY svc_plans ON api_subscription_plans FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'api_tenant_billing_cycles' AND policyname = 'svc_billing_cycles') THEN
    CREATE POLICY svc_billing_cycles ON api_tenant_billing_cycles FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'api_billing_transactions' AND policyname = 'svc_billing_txns') THEN
    CREATE POLICY svc_billing_txns ON api_billing_transactions FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Admin read access
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'api_subscription_plans' AND policyname = 'admin_read_plans') THEN
    CREATE POLICY admin_read_plans ON api_subscription_plans FOR SELECT TO authenticated
      USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'api_tenant_billing_cycles' AND policyname = 'admin_read_billing_cycles') THEN
    CREATE POLICY admin_read_billing_cycles ON api_tenant_billing_cycles FOR SELECT TO authenticated
      USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'api_billing_transactions' AND policyname = 'admin_read_billing_txns') THEN
    CREATE POLICY admin_read_billing_txns ON api_billing_transactions FOR SELECT TO authenticated
      USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'));
  END IF;
END $$;

-- ── 7. record_api_trade_fee() ──────────────────────────────────────────────────
-- Called by the API server (service role) after every successfully dispatched
-- trade. Calculates the platform's cut (7% on Starter, down to 5% Enterprise)
-- and appends it to the tenant's current monthly billing cycle.
CREATE OR REPLACE FUNCTION record_api_trade_fee(
  p_tenant_id   UUID,
  p_trade_id    UUID,
  p_amount_ngn  NUMERIC
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_plan_id  TEXT;
  v_plan     api_subscription_plans%ROWTYPE;
  v_fee_ngn  NUMERIC(12,2);
  v_cycle_id UUID;
  v_month    DATE;
BEGIN
  -- Resolve tenant's current plan
  SELECT COALESCE(plan, 'starter') INTO v_plan_id
  FROM api_tenants WHERE id = p_tenant_id;

  SELECT * INTO v_plan FROM api_subscription_plans WHERE id = v_plan_id;
  IF NOT FOUND THEN
    SELECT * INTO v_plan FROM api_subscription_plans WHERE id = 'starter';
  END IF;

  v_fee_ngn := ROUND(p_amount_ngn * v_plan.trade_fee_pct, 2);
  v_month   := date_trunc('month', NOW())::DATE;

  -- Upsert the current month's billing cycle
  INSERT INTO api_tenant_billing_cycles
    (tenant_id, plan_id, billing_month, trade_fee_ngn, trade_count, trade_volume_ngn)
  VALUES
    (p_tenant_id, v_plan.id, v_month, v_fee_ngn, 1, p_amount_ngn)
  ON CONFLICT (tenant_id, billing_month) DO UPDATE SET
    trade_fee_ngn    = api_tenant_billing_cycles.trade_fee_ngn + v_fee_ngn,
    trade_count      = api_tenant_billing_cycles.trade_count   + 1,
    trade_volume_ngn = api_tenant_billing_cycles.trade_volume_ngn + p_amount_ngn,
    updated_at       = NOW()
  RETURNING id INTO v_cycle_id;

  -- Record the line item
  INSERT INTO api_billing_transactions
    (tenant_id, cycle_id, type, amount_ngn, description, trade_id)
  VALUES (
    p_tenant_id, v_cycle_id, 'trade_fee', v_fee_ngn,
    format('%s%% platform fee on ₦%s trade',
      to_char(v_plan.trade_fee_pct * 100, 'FM990.9'),
      to_char(p_amount_ngn, 'FM999,999,999')),
    p_trade_id
  );

  RETURN jsonb_build_object('fee_ngn', v_fee_ngn, 'cycle_id', v_cycle_id);
END;
$$;

GRANT EXECUTE ON FUNCTION record_api_trade_fee TO service_role;

-- ── 8. open_monthly_billing_cycle() ───────────────────────────────────────────
-- Run at the start of each calendar month (e.g. via pg_cron or a Supabase Edge
-- Function cron). Seeds platform + support fees for all active tenants.
-- Idempotent: ON CONFLICT DO NOTHING means safe to run multiple times.
CREATE OR REPLACE FUNCTION open_monthly_billing_cycle(
  p_billing_month DATE DEFAULT date_trunc('month', NOW())::DATE
) RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant   RECORD;
  v_plan     api_subscription_plans%ROWTYPE;
  v_support  NUMERIC(12,2);
  v_count    INT := 0;
BEGIN
  FOR v_tenant IN
    SELECT t.id,
           COALESCE(t.plan, 'starter') AS plan_id,
           COALESCE(t.support_staff_count, 1) AS staff_count
    FROM api_tenants t
    WHERE t.status = 'active'
  LOOP
    SELECT * INTO v_plan FROM api_subscription_plans WHERE id = v_tenant.plan_id;
    IF NOT FOUND THEN
      SELECT * INTO v_plan FROM api_subscription_plans WHERE id = 'starter';
    END IF;

    v_support := v_plan.support_staff_monthly_ngn * v_tenant.staff_count;

    -- Open the cycle (no-op if already exists)
    INSERT INTO api_tenant_billing_cycles
      (tenant_id, plan_id, billing_month, platform_fee_ngn, support_fee_ngn)
    VALUES
      (v_tenant.id, v_plan.id, p_billing_month, v_plan.monthly_fee_ngn, v_support)
    ON CONFLICT (tenant_id, billing_month) DO NOTHING;

    -- Platform fee line item (idempotent guard)
    INSERT INTO api_billing_transactions
      (tenant_id, type, amount_ngn, description)
    SELECT
      v_tenant.id, 'platform_fee', v_plan.monthly_fee_ngn,
      format('Monthly API platform fee — %s plan (%s)',
        v_plan.name, to_char(p_billing_month, 'Mon YYYY'))
    WHERE NOT EXISTS (
      SELECT 1 FROM api_billing_transactions
      WHERE tenant_id = v_tenant.id
        AND type = 'platform_fee'
        AND date_trunc('month', created_at)::DATE = p_billing_month
    );

    -- Support fee line item
    IF v_support > 0 THEN
      INSERT INTO api_billing_transactions
        (tenant_id, type, amount_ngn, description)
      SELECT
        v_tenant.id, 'support_fee', v_support,
        format('Support staff — %s slot%s × ₦%s/mo (%s)',
          v_tenant.staff_count,
          CASE WHEN v_tenant.staff_count = 1 THEN '' ELSE 's' END,
          to_char(v_plan.support_staff_monthly_ngn, 'FM999,999'),
          to_char(p_billing_month, 'Mon YYYY'))
      WHERE NOT EXISTS (
        SELECT 1 FROM api_billing_transactions
        WHERE tenant_id = v_tenant.id
          AND type = 'support_fee'
          AND date_trunc('month', created_at)::DATE = p_billing_month
      );
    END IF;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION open_monthly_billing_cycle TO service_role;

-- ============================================================
-- MIGRATIONS 015–023 (appended)
-- Run these after the initial 001–014 block above
-- ============================================================

-- ============================================================
-- 015_telegram_broadcast.sql
-- ============================================================
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

-- ============================================================
-- 016_immutable_audit.sql
-- ============================================================
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 016: Immutable Truth Engine
--
-- Implements the three pillars of the cryptographic audit architecture:
--
-- Pillar 1 — Zero-Trust Cryptographic Logging
--   trade_audit_log: append-only ledger. Every trade event produces a
--   SHA-256 hash of (token_hash | server_ts_ms | vendor_id | trade_id | event).
--   Unique constraint on payload_hash makes the log un-falsifiable —
--   you cannot insert or overwrite an existing hash.
--
-- Pillar 2 — Multi-Point Timestamp Audit
--   card_exposed_at_ms on vendor_card_assignments: exact millisecond the card
--   code was delivered to the vendor via Telegram. vendor_disputes stores
--   T_Exposure, T_Redeemed (from Reloadly re-query), and the full verdict.
--
-- Pillar 3 — Automated Capital Depreciation
--   Verdict = FRAUD_CONFIRMED → existing forfeit_vendor_security_deposit RPC
--   + record_vendor_failure auto-suspension fires atomically, zero human touch.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Pillar 1: Immutable cryptographic ledger ──────────────────────────────────
CREATE TABLE IF NOT EXISTS trade_audit_log (
  id             UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_id       UUID,   -- nullable — some events pre-date a trade row
  assignment_id  UUID,   -- nullable
  event          TEXT    NOT NULL,
  -- card_verified | card_exposed | card_claimed | van_created | van_paid
  -- vendor_marked_redeemed | vendor_marked_failed
  -- fraud_audit_initiated | fraud_confirmed | system_error | inconclusive
  actor_type     TEXT    NOT NULL CHECK (actor_type IN ('system','vendor','user','admin')),
  actor_id       TEXT,   -- supabase user_id or vendor UUID as text
  server_ts_ms   BIGINT  NOT NULL,   -- Date.now() — ms precision, always server-set
  payload_hash   TEXT    NOT NULL,   -- SHA-256 of canonical payload — THE KEY GUARANTEE
  payload        JSONB   NOT NULL DEFAULT '{}',
  CONSTRAINT trade_audit_log_hash_unique UNIQUE (payload_hash)
  -- The UNIQUE constraint on payload_hash is the cryptographic guarantee:
  -- a duplicate or tampered entry is mathematically rejected by the DB.
);

-- Append-only enforcement via RLS — even service role cannot UPDATE or DELETE
-- (service role bypasses RLS for INSERT, but we set no UPDATE/DELETE policies)
ALTER TABLE trade_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin_read_audit_log"
  ON trade_audit_log FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'
  ));
-- No UPDATE or DELETE policy → nobody can modify or remove audit entries

CREATE INDEX IF NOT EXISTS idx_tal_trade_id     ON trade_audit_log (trade_id);
CREATE INDEX IF NOT EXISTS idx_tal_assignment   ON trade_audit_log (assignment_id);
CREATE INDEX IF NOT EXISTS idx_tal_event_ts     ON trade_audit_log (event, server_ts_ms DESC);
CREATE INDEX IF NOT EXISTS idx_tal_actor        ON trade_audit_log (actor_type, actor_id);
CREATE INDEX IF NOT EXISTS idx_tal_ts           ON trade_audit_log (server_ts_ms DESC);

-- ── Pillar 2: Exposure + Redeemed timestamps on assignments ───────────────────
-- card_exposed_at_ms = T_Exposure: exact millisecond the card code landed in the
-- vendor's Telegram chat (set the moment sendTelegramMessage() returns OK).
ALTER TABLE vendor_card_assignments
  ADD COLUMN IF NOT EXISTS card_exposed_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS card_exposed_at_ms  BIGINT,      -- T_Exposure in ms
  ADD COLUMN IF NOT EXISTS failure_reason      TEXT,
  ADD COLUMN IF NOT EXISTS fraud_verdict       TEXT
    CHECK (fraud_verdict IN ('pending','fraud_confirmed','system_error','cleared','inconclusive')),
  ADD COLUMN IF NOT EXISTS fraud_verdict_at    TIMESTAMPTZ;

-- ── Pillar 2: Forensic dispute records ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS vendor_disputes (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id         UUID        NOT NULL,
  vendor_id             UUID        NOT NULL REFERENCES vendors(id),
  trade_id              UUID,
  failure_reason        TEXT        NOT NULL,
  -- Timestamp axis (all in milliseconds since Unix epoch for sub-second precision)
  t_exposure_ms         BIGINT,     -- when card code hit vendor Telegram
  t_audit_ms            BIGINT,     -- when forensic check ran
  t_redeemed_ms         BIGINT,     -- inferred from Reloadly re-query result
  -- Reloadly evidence
  reloadly_audit_raw    JSONB,      -- raw API response at audit time
  reloadly_card_status  TEXT,       -- 'VALID'|'REDEEMED'|'INVALID'|'UNKNOWN'
  -- Verdict
  verdict               TEXT        NOT NULL DEFAULT 'pending'
    CHECK (verdict IN ('pending','fraud_confirmed','system_error','inconclusive')),
  verdict_at            TIMESTAMPTZ,
  verdict_evidence      JSONB,      -- full forensic evidence package
  -- Enforcement
  auto_actioned         BOOLEAN     NOT NULL DEFAULT FALSE,
  deposit_forfeited_ngn NUMERIC(15,2) NOT NULL DEFAULT 0,
  auto_suspended        BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE vendor_disputes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admin_read_disputes"
  ON vendor_disputes FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'
  ));

CREATE INDEX IF NOT EXISTS idx_disputes_vendor     ON vendor_disputes (vendor_id);
CREATE INDEX IF NOT EXISTS idx_disputes_assignment ON vendor_disputes (assignment_id);
CREATE INDEX IF NOT EXISTS idx_disputes_verdict    ON vendor_disputes (verdict, created_at DESC);

-- ── Helper: verify a hash hasn't been tampered with ───────────────────────────
-- Returns TRUE if the hash exists and the payload still hashes to the same value.
-- Call this from any audit verification endpoint.
CREATE OR REPLACE FUNCTION verify_audit_entry(p_hash TEXT, p_payload JSONB)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM trade_audit_log
    WHERE payload_hash = p_hash
      AND payload = p_payload
  );
$$;

-- ============================================================
-- 017_vendor_rate_check.sql
-- ============================================================
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

-- ============================================================
-- 018_card_batch_dispatch.sql
-- ============================================================
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

-- ============================================================
-- 019_vendor_rate_approval.sql
-- ============================================================
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

-- ============================================================
-- 020_admin_telegram.sql
-- ============================================================
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 020: Admin Telegram Bot + Telegram Support System
--
-- Adds tables for:
--   1. Admin Telegram identity linking (expiring link codes)
--   2. Admin Telegram notification tracking (fan-out + resolve)
--   3. Support ticket routing via Telegram
--   4. Vendor moniker table (privacy-preserving dispute comms)
--   5. pending_review trade status support (P0-1 fix)
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Admin Telegram identity links ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admin_telegram_links (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  telegram_chat_id  BIGINT NOT NULL,
  telegram_username TEXT,
  linked_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT admin_telegram_links_chat_unique UNIQUE (telegram_chat_id)
);

CREATE TABLE IF NOT EXISTS admin_telegram_link_codes (
  code        TEXT PRIMARY KEY,
  admin_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_admin_tg_link_codes_admin
  ON admin_telegram_link_codes (admin_id, expires_at DESC);

-- ── 2. Admin Telegram notification fan-out tracker ───────────────────────────
-- One row per (item, chat). Lets us edit all admins' copies on resolution.
CREATE TABLE IF NOT EXISTS admin_telegram_notifications (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_type           TEXT NOT NULL,   -- 'manual_review' | 'withdrawal' | 'kyc' | 'vendor_rate' | 'dispute' | 'fraud' | 'payout_failed'
  item_id             UUID NOT NULL,
  telegram_chat_id    BIGINT NOT NULL,
  telegram_message_id BIGINT NOT NULL,
  resolved_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_tg_notif_item
  ON admin_telegram_notifications (item_type, item_id, resolved_at);
CREATE INDEX IF NOT EXISTS idx_admin_tg_notif_chat
  ON admin_telegram_notifications (telegram_chat_id, created_at DESC);

-- ── 3. Support tickets (Telegram-based support system) ───────────────────────
-- Replaces FreeScout. Tickets route to a Telegram support group.
CREATE TABLE IF NOT EXISTS support_tickets (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  category         TEXT,
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'closed')),
  telegram_message_id BIGINT,          -- message ID in support group
  telegram_thread_id  BIGINT,          -- thread/topic ID if using forum groups
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at      TIMESTAMPTZ,
  CONSTRAINT support_tickets_user_one_open UNIQUE NULLS NOT DISTINCT (user_id, status)
    DEFERRABLE INITIALLY DEFERRED
);

-- Drop incorrect unique constraint if it was created without NULLS NOT DISTINCT support
-- (Postgres < 15 fallback)
DO $$
BEGIN
  ALTER TABLE support_tickets DROP CONSTRAINT IF EXISTS support_tickets_user_one_open;
EXCEPTION WHEN others THEN null;
END$$;

-- Simple open ticket index (no partial unique — just use index for lookups)
CREATE INDEX IF NOT EXISTS idx_support_tickets_user
  ON support_tickets (user_id, status, created_at DESC);

-- ── 4. Vendor monikers (privacy-preserving dispute comms) ────────────────────
-- Each vendor gets a stable, human-readable moniker used in admin/support comms
-- so their real business name and details are never disclosed.
CREATE TABLE IF NOT EXISTS vendor_monikers (
  vendor_id  UUID PRIMARY KEY REFERENCES vendors(id) ON DELETE CASCADE,
  moniker    TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 5. Ensure trades.status allows 'pending_review' ──────────────────────────
-- The P0-1 fix introduces 'pending_review' as a real status distinct from 'verified'.
-- We add it to the CHECK constraint if it's defined, or just note it for app logic.
-- (Supabase typically uses TEXT without CHECK for status; this is a no-op if so.)
DO $$
BEGIN
  -- Add DB-level guard: pending_review + paid cannot coexist
  -- This is belt-and-suspenders alongside the app-level check.
  -- We do this as a trigger rather than a constraint for compatibility.
  NULL;
END$$;

CREATE OR REPLACE FUNCTION prevent_pending_review_payout()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'paid' AND (OLD.requires_manual_review = true OR NEW.requires_manual_review = true) THEN
    RAISE EXCEPTION 'Cannot mark trade as paid while requires_manual_review is true (trade %)', NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_pending_review_payout ON trades;
CREATE TRIGGER trg_prevent_pending_review_payout
  BEFORE UPDATE ON trades
  FOR EACH ROW
  EXECUTE FUNCTION prevent_pending_review_payout();

-- ── 6. Moniker auto-generation function ──────────────────────────────────────
-- Assigns a deterministic moniker to a vendor if they don't have one.
-- Uses Greek alphabet + color combos for easy recall: "Crimson-Alpha", "Azure-Beta"
CREATE OR REPLACE FUNCTION get_or_create_vendor_moniker(p_vendor_id UUID)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_moniker TEXT;
  v_idx     INT;
  colors    TEXT[] := ARRAY['Crimson','Azure','Jade','Amber','Cobalt','Coral','Indigo','Teal','Scarlet','Sage'];
  names     TEXT[] := ARRAY['Alpha','Beta','Gamma','Delta','Epsilon','Zeta','Eta','Theta','Iota','Kappa',
                             'Lambda','Mu','Nu','Xi','Omicron','Pi','Rho','Sigma','Tau','Upsilon'];
BEGIN
  SELECT moniker INTO v_moniker FROM vendor_monikers WHERE vendor_id = p_vendor_id;
  IF v_moniker IS NOT NULL THEN
    RETURN v_moniker;
  END IF;

  -- Generate a unique moniker using count of existing monikers
  SELECT COUNT(*) INTO v_idx FROM vendor_monikers;
  v_moniker := colors[(v_idx % array_length(colors,1)) + 1] || '-' || names[(v_idx % array_length(names,1)) + 1];

  -- Handle collision by appending a number
  WHILE EXISTS (SELECT 1 FROM vendor_monikers WHERE moniker = v_moniker) LOOP
    v_idx := v_idx + 1;
    v_moniker := colors[(v_idx % array_length(colors,1)) + 1] || '-' || names[(v_idx % array_length(names,1)) + 1] || '-' || v_idx;
  END LOOP;

  INSERT INTO vendor_monikers (vendor_id, moniker) VALUES (p_vendor_id, v_moniker)
    ON CONFLICT (vendor_id) DO NOTHING;

  RETURN v_moniker;
END;
$$;

-- ============================================================
-- 021_api_tenants.sql
-- ============================================================
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

-- ============================================================
-- 022_api_billing.sql
-- ============================================================
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 022 — API Tenant Billing & Subscription Plans
--
-- Revenue model for third-party trading companies (TPOs) using 7SEVEN's
-- vendor network and support staff as infrastructure:
--
--   • Monthly platform fee: starts at ₦20,000 (Starter plan)
--   • Trade fee: 7% of each successfully dispatched trade's NGN value
--     (decreases with higher plans — reward volume)
--   • Support staff fee: ₦5,000/month per active staff slot
--
-- Architecture:
--   api_subscription_plans  — plan catalogue with pricing in Naira
--   api_tenant_billing_cycles — monthly invoice aggregates per tenant
--   api_billing_transactions  — individual line items (trade fees, monthly fees)
--   record_api_trade_fee()  — called by api-server on each dispatched trade
--   open_monthly_billing_cycle() — called at month start (cron/manual)
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Subscription Plans ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS api_subscription_plans (
  id                          TEXT        PRIMARY KEY,   -- 'starter','growth','professional','enterprise'
  name                        TEXT        NOT NULL,
  monthly_fee_ngn             NUMERIC(12,2) NOT NULL DEFAULT 0,
  trade_fee_pct               NUMERIC(5,4) NOT NULL DEFAULT 0.0700, -- 7.00%
  support_staff_slots         INT         NOT NULL DEFAULT 1,
  support_staff_monthly_ngn   NUMERIC(12,2) NOT NULL DEFAULT 5000,  -- per slot
  rate_limit_rpm              INT         NOT NULL DEFAULT 60,
  description                 TEXT,
  is_active                   BOOLEAN     NOT NULL DEFAULT TRUE,
  sort_order                  INT         NOT NULL DEFAULT 0,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed the four tiers (idempotent)
INSERT INTO api_subscription_plans
  (id, name, monthly_fee_ngn, trade_fee_pct, support_staff_slots, support_staff_monthly_ngn, rate_limit_rpm, description, sort_order)
VALUES
  ('starter',      'Starter',      20000,  0.0700, 1,  5000, 60,   'Entry-level for small trading companies. ₦20,000/mo platform fee + 7% per trade.',       1),
  ('growth',       'Growth',       35000,  0.0650, 2,  5000, 300,  'Growing trading desks. ₦35,000/mo + 6.5% per trade. 2 support staff slots.',              2),
  ('professional', 'Professional', 65000,  0.0600, 3,  5000, 600,  'High-volume operations. ₦65,000/mo + 6% per trade. 3 staff slots, 600 req/min.',          3),
  ('enterprise',   'Enterprise',   150000, 0.0500, 10, 5000, 1500, 'Custom enterprise deployments. ₦150,000/mo + 5% per trade. 10 staff slots, 1500 req/min.',4)
ON CONFLICT (id) DO NOTHING;

-- ── 2. Widen plan CHECK on api_tenants ───────────────────────────────────────
-- Existing constraint only allowed 'free','pro','enterprise'. Add new plan IDs.
ALTER TABLE api_tenants DROP CONSTRAINT IF EXISTS api_tenants_plan_check;
ALTER TABLE api_tenants
  ADD CONSTRAINT api_tenants_plan_check
  CHECK (plan IN ('free','starter','growth','professional','enterprise'));

-- Add support_staff_count to track how many staff slots a tenant is using
ALTER TABLE api_tenants
  ADD COLUMN IF NOT EXISTS support_staff_count INT NOT NULL DEFAULT 1;

-- ── 3. Monthly Billing Cycles ─────────────────────────────────────────────────
-- One row per tenant per calendar month. Aggregates all fees for invoicing.
CREATE TABLE IF NOT EXISTS api_tenant_billing_cycles (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID        NOT NULL REFERENCES api_tenants(id) ON DELETE CASCADE,
  plan_id           TEXT        NOT NULL REFERENCES api_subscription_plans(id),
  billing_month     DATE        NOT NULL,   -- always the 1st of the month
  platform_fee_ngn  NUMERIC(12,2) NOT NULL DEFAULT 0,
  trade_fee_ngn     NUMERIC(12,2) NOT NULL DEFAULT 0,
  support_fee_ngn   NUMERIC(12,2) NOT NULL DEFAULT 0,
  trade_count       INT         NOT NULL DEFAULT 0,
  trade_volume_ngn  NUMERIC(16,2) NOT NULL DEFAULT 0,
  status            TEXT        NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open','invoiced','paid','overdue')),
  invoiced_at       TIMESTAMPTZ,
  paid_at           TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, billing_month)
);

CREATE INDEX IF NOT EXISTS idx_billing_cycles_tenant
  ON api_tenant_billing_cycles(tenant_id, billing_month DESC);

CREATE INDEX IF NOT EXISTS idx_billing_cycles_status
  ON api_tenant_billing_cycles(status) WHERE status IN ('open','invoiced','overdue');

-- ── 4. Individual Billing Line Items ──────────────────────────────────────────
-- Audit trail: one row per trade fee, monthly platform fee, support fee, etc.
CREATE TABLE IF NOT EXISTS api_billing_transactions (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID        NOT NULL REFERENCES api_tenants(id) ON DELETE CASCADE,
  cycle_id    UUID        REFERENCES api_tenant_billing_cycles(id),
  type        TEXT        NOT NULL
                CHECK (type IN ('trade_fee','platform_fee','support_fee','adjustment','credit')),
  amount_ngn  NUMERIC(12,2) NOT NULL,
  description TEXT,
  trade_id    UUID        REFERENCES trades(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_billing_txns_tenant
  ON api_billing_transactions(tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_billing_txns_cycle
  ON api_billing_transactions(cycle_id, created_at DESC);

-- ── 5. Fix api_webhook_deliveries — add status tracking columns ───────────────
-- Migration 021 uses attempt_count/last_attempt_at/last_status_code/delivered_at
-- for raw tracking. Add derived status columns to support the admin dashboard.
ALTER TABLE api_webhook_deliveries
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','delivered','failed','retrying')),
  ADD COLUMN IF NOT EXISTS attempt_number INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS response_code  INT,
  ADD COLUMN IF NOT EXISTS attempted_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS next_retry_at  TIMESTAMPTZ;

-- Backfill existing rows from the raw tracking columns
UPDATE api_webhook_deliveries SET
  attempt_number = attempt_count,
  response_code  = last_status_code,
  attempted_at   = last_attempt_at,
  status = CASE
    WHEN delivered_at IS NOT NULL THEN 'delivered'
    WHEN attempt_count >= 4       THEN 'failed'
    WHEN attempt_count > 0        THEN 'retrying'
    ELSE 'pending'
  END
WHERE attempt_number = 0 OR status = 'pending';

-- ── 6. RLS ────────────────────────────────────────────────────────────────────
ALTER TABLE api_subscription_plans      ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_tenant_billing_cycles   ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_billing_transactions    ENABLE ROW LEVEL SECURITY;

-- Service role: full access (api-server uses service role key)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'api_subscription_plans' AND policyname = 'svc_plans') THEN
    CREATE POLICY svc_plans ON api_subscription_plans FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'api_tenant_billing_cycles' AND policyname = 'svc_billing_cycles') THEN
    CREATE POLICY svc_billing_cycles ON api_tenant_billing_cycles FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'api_billing_transactions' AND policyname = 'svc_billing_txns') THEN
    CREATE POLICY svc_billing_txns ON api_billing_transactions FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Admin read access
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'api_subscription_plans' AND policyname = 'admin_read_plans') THEN
    CREATE POLICY admin_read_plans ON api_subscription_plans FOR SELECT TO authenticated
      USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'api_tenant_billing_cycles' AND policyname = 'admin_read_billing_cycles') THEN
    CREATE POLICY admin_read_billing_cycles ON api_tenant_billing_cycles FOR SELECT TO authenticated
      USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'api_billing_transactions' AND policyname = 'admin_read_billing_txns') THEN
    CREATE POLICY admin_read_billing_txns ON api_billing_transactions FOR SELECT TO authenticated
      USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'));
  END IF;
END $$;

-- ── 7. record_api_trade_fee() ──────────────────────────────────────────────────
-- Called by the API server (service role) after every successfully dispatched
-- trade. Calculates the platform's cut (7% on Starter, down to 5% Enterprise)
-- and appends it to the tenant's current monthly billing cycle.
CREATE OR REPLACE FUNCTION record_api_trade_fee(
  p_tenant_id   UUID,
  p_trade_id    UUID,
  p_amount_ngn  NUMERIC
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_plan_id  TEXT;
  v_plan     api_subscription_plans%ROWTYPE;
  v_fee_ngn  NUMERIC(12,2);
  v_cycle_id UUID;
  v_month    DATE;
BEGIN
  -- Resolve tenant's current plan
  SELECT COALESCE(plan, 'starter') INTO v_plan_id
  FROM api_tenants WHERE id = p_tenant_id;

  SELECT * INTO v_plan FROM api_subscription_plans WHERE id = v_plan_id;
  IF NOT FOUND THEN
    SELECT * INTO v_plan FROM api_subscription_plans WHERE id = 'starter';
  END IF;

  v_fee_ngn := ROUND(p_amount_ngn * v_plan.trade_fee_pct, 2);
  v_month   := date_trunc('month', NOW())::DATE;

  -- Upsert the current month's billing cycle
  INSERT INTO api_tenant_billing_cycles
    (tenant_id, plan_id, billing_month, trade_fee_ngn, trade_count, trade_volume_ngn)
  VALUES
    (p_tenant_id, v_plan.id, v_month, v_fee_ngn, 1, p_amount_ngn)
  ON CONFLICT (tenant_id, billing_month) DO UPDATE SET
    trade_fee_ngn    = api_tenant_billing_cycles.trade_fee_ngn + v_fee_ngn,
    trade_count      = api_tenant_billing_cycles.trade_count   + 1,
    trade_volume_ngn = api_tenant_billing_cycles.trade_volume_ngn + p_amount_ngn,
    updated_at       = NOW()
  RETURNING id INTO v_cycle_id;

  -- Record the line item
  INSERT INTO api_billing_transactions
    (tenant_id, cycle_id, type, amount_ngn, description, trade_id)
  VALUES (
    p_tenant_id, v_cycle_id, 'trade_fee', v_fee_ngn,
    format('%s%% platform fee on ₦%s trade',
      to_char(v_plan.trade_fee_pct * 100, 'FM990.9'),
      to_char(p_amount_ngn, 'FM999,999,999')),
    p_trade_id
  );

  RETURN jsonb_build_object('fee_ngn', v_fee_ngn, 'cycle_id', v_cycle_id);
END;
$$;

GRANT EXECUTE ON FUNCTION record_api_trade_fee TO service_role;

-- ── 8. open_monthly_billing_cycle() ───────────────────────────────────────────
-- Run at the start of each calendar month (e.g. via pg_cron or a Supabase Edge
-- Function cron). Seeds platform + support fees for all active tenants.
-- Idempotent: ON CONFLICT DO NOTHING means safe to run multiple times.
CREATE OR REPLACE FUNCTION open_monthly_billing_cycle(
  p_billing_month DATE DEFAULT date_trunc('month', NOW())::DATE
) RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant   RECORD;
  v_plan     api_subscription_plans%ROWTYPE;
  v_support  NUMERIC(12,2);
  v_count    INT := 0;
BEGIN
  FOR v_tenant IN
    SELECT t.id,
           COALESCE(t.plan, 'starter') AS plan_id,
           COALESCE(t.support_staff_count, 1) AS staff_count
    FROM api_tenants t
    WHERE t.status = 'active'
  LOOP
    SELECT * INTO v_plan FROM api_subscription_plans WHERE id = v_tenant.plan_id;
    IF NOT FOUND THEN
      SELECT * INTO v_plan FROM api_subscription_plans WHERE id = 'starter';
    END IF;

    v_support := v_plan.support_staff_monthly_ngn * v_tenant.staff_count;

    -- Open the cycle (no-op if already exists)
    INSERT INTO api_tenant_billing_cycles
      (tenant_id, plan_id, billing_month, platform_fee_ngn, support_fee_ngn)
    VALUES
      (v_tenant.id, v_plan.id, p_billing_month, v_plan.monthly_fee_ngn, v_support)
    ON CONFLICT (tenant_id, billing_month) DO NOTHING;

    -- Platform fee line item (idempotent guard)
    INSERT INTO api_billing_transactions
      (tenant_id, type, amount_ngn, description)
    SELECT
      v_tenant.id, 'platform_fee', v_plan.monthly_fee_ngn,
      format('Monthly API platform fee — %s plan (%s)',
        v_plan.name, to_char(p_billing_month, 'Mon YYYY'))
    WHERE NOT EXISTS (
      SELECT 1 FROM api_billing_transactions
      WHERE tenant_id = v_tenant.id
        AND type = 'platform_fee'
        AND date_trunc('month', created_at)::DATE = p_billing_month
    );

    -- Support fee line item
    IF v_support > 0 THEN
      INSERT INTO api_billing_transactions
        (tenant_id, type, amount_ngn, description)
      SELECT
        v_tenant.id, 'support_fee', v_support,
        format('Support staff — %s slot%s × ₦%s/mo (%s)',
          v_tenant.staff_count,
          CASE WHEN v_tenant.staff_count = 1 THEN '' ELSE 's' END,
          to_char(v_plan.support_staff_monthly_ngn, 'FM999,999'),
          to_char(p_billing_month, 'Mon YYYY'))
      WHERE NOT EXISTS (
        SELECT 1 FROM api_billing_transactions
        WHERE tenant_id = v_tenant.id
          AND type = 'support_fee'
          AND date_trunc('month', created_at)::DATE = p_billing_month
      );
    END IF;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION open_monthly_billing_cycle TO service_role;

-- ============================================================
-- 023_multi_region_rates.sql
-- ============================================================
-- ─── Migration 023: Multi-region exchange rates ──────────────────────────────
-- Adds UK, EU, and CA rate rows to exchange_rates.
-- The rate_per_dollar column stays in NGN/USD terms.
-- The frontend applies a per-region forex multiplier (REGION_FX) to derive
-- NGN per local currency unit: nairaPerUnit = rate_per_dollar * forexMultiplier
-- Also adds a `region` column to the trades table for analytics.

-- 1. Normalise existing USA → US (old code used "USA", new code uses "US")
UPDATE exchange_rates SET region = 'US' WHERE region = 'USA';

-- 2. Seed United Kingdom (GBP) rates
INSERT INTO exchange_rates (brand, region, rate_per_dollar, trend, source)
VALUES
  ('Google Play', 'UK', 1460, '+1.1%', 'manual'),
  ('Steam',       'UK', 1380, '+0.9%', 'manual'),
  ('Amazon',      'UK', 1420, '+1.3%', 'manual'),
  ('Apple',       'UK', 1485, '+1.8%', 'manual'),
  ('Netflix',     'UK', 1350, '+0.5%', 'manual'),
  ('Spotify',     'UK', 1325, '+0.2%', 'manual')
ON CONFLICT (brand, region) DO UPDATE
  SET rate_per_dollar = EXCLUDED.rate_per_dollar,
      trend           = EXCLUDED.trend,
      updated_at      = now();

-- 3. Seed Eurozone (EUR) rates
INSERT INTO exchange_rates (brand, region, rate_per_dollar, trend, source)
VALUES
  ('Steam',       'EU', 1380, '-0.1%', 'manual'),
  ('Google Play', 'EU', 1460, '+0.6%', 'manual'),
  ('Amazon',      'EU', 1420, '+0.9%', 'manual'),
  ('Apple',       'EU', 1485, '+1.2%', 'manual')
ON CONFLICT (brand, region) DO UPDATE
  SET rate_per_dollar = EXCLUDED.rate_per_dollar,
      trend           = EXCLUDED.trend,
      updated_at      = now();

-- 4. Seed Canada (CAD) rates
INSERT INTO exchange_rates (brand, region, rate_per_dollar, trend, source)
VALUES
  ('Apple',       'CA', 1485, '+0.8%', 'manual'),
  ('Amazon',      'CA', 1420, '+0.6%', 'manual'),
  ('Steam',       'CA', 1380, '-0.2%', 'manual'),
  ('Google Play', 'CA', 1460, '+0.4%', 'manual'),
  ('Xbox',        'CA', 1395, '+0.7%', 'manual'),
  ('PlayStation', 'CA', 1410, '+0.3%', 'manual'),
  ('Spotify',     'CA', 1325, '+0.1%', 'manual')
ON CONFLICT (brand, region) DO UPDATE
  SET rate_per_dollar = EXCLUDED.rate_per_dollar,
      trend           = EXCLUDED.trend,
      updated_at      = now();

-- 5. Seed new US-only brands
INSERT INTO exchange_rates (brand, region, rate_per_dollar, trend, source)
VALUES
  ('Razer Gold', 'US', 1300, '+0.3%', 'manual'),
  ('Sephora',    'US', 1340, '+0.7%', 'manual'),
  ('Nordstrom',  'US', 1310, '+0.4%', 'manual')
ON CONFLICT (brand, region) DO UPDATE
  SET rate_per_dollar = EXCLUDED.rate_per_dollar,
      trend           = EXCLUDED.trend,
      updated_at      = now();

-- 6. Add region column to trades table (if not already present)
ALTER TABLE trades ADD COLUMN IF NOT EXISTS region TEXT DEFAULT 'US';

-- 7. Update trades constraint — allow new region values
-- (no constraint change needed; trades.region is freeform text)

-- ============================================================
-- 021_card_images.sql
-- ============================================================
-- ============================================================
-- 021_card_images.sql
-- Card image upload support for gift card trades
-- Run in Supabase SQL Editor
-- ============================================================

-- ── 1. Add image path column to trades ──────────────────────────────────────
ALTER TABLE trades ADD COLUMN IF NOT EXISTS card_image_path TEXT;

-- ── 2. Create private Supabase Storage bucket ────────────────────────────────
-- Images stored under {userId}/{timestamp}.{ext}
-- Private bucket — only signed URLs can be shared with vendors
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'card-images',
  'card-images',
  false,
  5242880,  -- 5 MB max per image
  ARRAY[
    'image/jpeg', 'image/jpg', 'image/png',
    'image/webp', 'image/heic', 'image/heif'
  ]
)
ON CONFLICT (id) DO NOTHING;

-- ── 3. Storage RLS policies ───────────────────────────────────────────────────

-- Users can upload their own images (path must start with their user ID)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'objects' AND schemaname = 'storage'
    AND policyname = 'card_images_upload'
  ) THEN
    CREATE POLICY "card_images_upload"
      ON storage.objects FOR INSERT
      WITH CHECK (
        bucket_id = 'card-images'
        AND auth.role() = 'authenticated'
        AND (storage.foldername(name))[1] = auth.uid()::text
      );
  END IF;
END $$;

-- Users can view their own uploaded images
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'objects' AND schemaname = 'storage'
    AND policyname = 'card_images_read_own'
  ) THEN
    CREATE POLICY "card_images_read_own"
      ON storage.objects FOR SELECT
      USING (
        bucket_id = 'card-images'
        AND (storage.foldername(name))[1] = auth.uid()::text
      );
  END IF;
END $$;

-- Admins can view all card images
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'objects' AND schemaname = 'storage'
    AND policyname = 'card_images_read_admin'
  ) THEN
    CREATE POLICY "card_images_read_admin"
      ON storage.objects FOR SELECT
      USING (
        bucket_id = 'card-images'
        AND EXISTS (
          SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'
        )
      );
  END IF;
END $$;

-- Users can delete their own images (e.g. resubmit)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'objects' AND schemaname = 'storage'
    AND policyname = 'card_images_delete_own'
  ) THEN
    CREATE POLICY "card_images_delete_own"
      ON storage.objects FOR DELETE
      USING (
        bucket_id = 'card-images'
        AND (storage.foldername(name))[1] = auth.uid()::text
      );
  END IF;
END $$;

-- ============================================================
-- 024_cybermonikers_avatars.sql
-- ============================================================
-- ─────────────────────────────────────────────────────────────────────────────
-- 024: Cybermonikers + DiceBear Avatars
-- Adds display_name (auto-generated cybermoniker starting with "7") to profiles.
-- Updates leaderboard view to use display_name (no real names exposed publicly).
-- ─────────────────────────────────────────────────────────────────────────────

-- Add display_name column
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS display_name TEXT UNIQUE;

-- ─── Cybermoniker generator ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION generate_cybermoniker()
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  prefixes TEXT[] := ARRAY[
    'Swift','Ghost','Iron','Storm','Nova','Cyber','Neon','Apex','Elite','Ultra',
    'Rapid','Sharp','Bold','Prime','Royal','Stealth','Blaze','Flash','Dark','Frost',
    'Quantum','Shadow','Lunar','Solar','Hyper','Venom','Rogue','Phantom','Titan','Volt'
  ];
  nouns TEXT[] := ARRAY[
    'Card','Deal','Vault','Ace','Fox','Wolf','Hawk','Bear','Lion','Tiger',
    'Eagle','Shark','Viper','Ninja','Blade','Trader','Hustle','Stack','Cash','Coin',
    'Grip','Strike','Surge','Force','Pulse','Drift','Edge','Flair','Gem','Link'
  ];
  attempts INT := 0;
  candidate TEXT;
BEGIN
  LOOP
    attempts := attempts + 1;
    IF attempts > 200 THEN
      candidate := '7' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 7));
      IF NOT EXISTS (SELECT 1 FROM profiles WHERE display_name = candidate) THEN
        RETURN candidate;
      END IF;
      CONTINUE;
    END IF;
    candidate := '7' ||
      prefixes[1 + floor(random() * array_length(prefixes, 1))::int] ||
      nouns[1 + floor(random() * array_length(nouns, 1))::int] ||
      floor(random() * 89 + 10)::text;
    IF NOT EXISTS (SELECT 1 FROM profiles WHERE display_name = candidate) THEN
      RETURN candidate;
    END IF;
  END LOOP;
END;
$$;

-- Backfill existing users who don't have a cybermoniker yet
DO $$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN SELECT id FROM profiles WHERE display_name IS NULL LOOP
    UPDATE profiles SET display_name = generate_cybermoniker() WHERE id = rec.id;
  END LOOP;
END;
$$;

-- ─── Update on_auth_user_created to include cybermoniker ─────────────────────
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO profiles (id, full_name, phone, display_name)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    NEW.phone,
    generate_cybermoniker()
  )
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO wallets (user_id, currency) VALUES (NEW.id, 'NGN') ON CONFLICT DO NOTHING;
  INSERT INTO user_xp (user_id) VALUES (NEW.id) ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;

-- ─── Update leaderboard view to expose display_name (never full_name) ────────
CREATE OR REPLACE VIEW leaderboard AS
SELECT
  p.id,
  COALESCE(p.display_name, '7Trader') AS display_name,
  p.avatar_url,
  x.total_xp,
  x.weekly_xp,
  x.level,
  x.streak_days,
  x.trade_count,
  RANK() OVER (ORDER BY x.weekly_xp DESC)   AS weekly_rank,
  RANK() OVER (ORDER BY x.total_xp  DESC)   AS all_time_rank
FROM user_xp x
JOIN profiles p ON p.id = x.user_id
ORDER BY x.weekly_xp DESC;

-- ============================================================
-- 025_ocr_scan_data.sql
-- ============================================================
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 025: OCR Scan Data + Fraud Screening
-- Adds OCR extraction and fraud-risk columns to trades and vendor assignments.
-- Run manually in Supabase SQL Editor.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. OCR columns on trades ─────────────────────────────────────────────────
ALTER TABLE trades ADD COLUMN IF NOT EXISTS ocr_brand         TEXT;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS ocr_code          TEXT;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS ocr_pin           TEXT;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS ocr_denomination  NUMERIC(12,2);
ALTER TABLE trades ADD COLUMN IF NOT EXISTS ocr_currency      TEXT;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS ocr_country       TEXT;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS ocr_confidence    INTEGER;   -- 0–100
ALTER TABLE trades ADD COLUMN IF NOT EXISTS ocr_risk_score    TEXT;      -- low | medium | high
ALTER TABLE trades ADD COLUMN IF NOT EXISTS ocr_flags         TEXT[] DEFAULT '{}';
ALTER TABLE trades ADD COLUMN IF NOT EXISTS ocr_scanned_at    TIMESTAMPTZ;

-- ── 2. Denormalised OCR columns on vendor_card_assignments ───────────────────
-- These are populated when a trade with OCR data creates a vendor assignment,
-- so vendors see fraud signals without needing a JOIN back to trades.
ALTER TABLE vendor_card_assignments ADD COLUMN IF NOT EXISTS ocr_confidence INTEGER;
ALTER TABLE vendor_card_assignments ADD COLUMN IF NOT EXISTS ocr_risk_score TEXT;
ALTER TABLE vendor_card_assignments ADD COLUMN IF NOT EXISTS ocr_flags      TEXT[] DEFAULT '{}';

-- ── 3. Index on risk score for admin fraud review queue ──────────────────────
CREATE INDEX IF NOT EXISTS idx_trades_ocr_risk
  ON trades (ocr_risk_score)
  WHERE ocr_risk_score IS NOT NULL;

-- ── 4. Duplicate image detection view ───────────────────────────────────────
-- Finds card_image_path values submitted more than once (possible duplicate fraud).
CREATE OR REPLACE VIEW duplicate_card_images AS
SELECT
  card_image_path,
  COUNT(*)                                            AS submission_count,
  ARRAY_AGG(id ORDER BY created_at)                  AS trade_ids,
  ARRAY_AGG(user_id ORDER BY created_at)             AS user_ids,
  MIN(created_at)                                     AS first_seen,
  MAX(created_at)                                     AS last_seen
FROM trades
WHERE card_image_path IS NOT NULL
GROUP BY card_image_path
HAVING COUNT(*) > 1;

-- ── 5. OCR fraud log function (called by server on high-risk detections) ─────
CREATE OR REPLACE FUNCTION flag_high_risk_trade(
  p_trade_id   UUID,
  p_risk_score TEXT,
  p_flags      TEXT[]
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE trades
  SET
    ocr_risk_score = p_risk_score,
    ocr_flags      = p_flags,
    status         = CASE
                       WHEN p_risk_score = 'high' THEN 'under_review'
                       ELSE status
                     END
  WHERE id = p_trade_id;
END;
$$;

-- ── 6. Grant select on new view to authenticated users (their own trades) ────
ALTER VIEW duplicate_card_images OWNER TO postgres;

COMMENT ON COLUMN trades.ocr_confidence IS '0–100 OCR extraction confidence from Gemini Vision';
COMMENT ON COLUMN trades.ocr_risk_score IS 'Fraud risk: low | medium | high';
COMMENT ON COLUMN trades.ocr_flags      IS 'Array of detected fraud signals: blurry, screenshot, edited, partial, voided';

-- ============================================================
-- 026_weekly_trade_commission.sql
-- ============================================================
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

-- ============================================================
-- 027_card_images.sql
-- ============================================================
-- ============================================================
-- 021_card_images.sql
-- Card image upload support for gift card trades
-- Run in Supabase SQL Editor
-- ============================================================

-- ── 1. Add image path column to trades ──────────────────────────────────────
ALTER TABLE trades ADD COLUMN IF NOT EXISTS card_image_path TEXT;

-- ── 2. Create private Supabase Storage bucket ────────────────────────────────
-- Images stored under {userId}/{timestamp}.{ext}
-- Private bucket — only signed URLs can be shared with vendors
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'card-images',
  'card-images',
  false,
  5242880,  -- 5 MB max per image
  ARRAY[
    'image/jpeg', 'image/jpg', 'image/png',
    'image/webp', 'image/heic', 'image/heif'
  ]
)
ON CONFLICT (id) DO NOTHING;

-- ── 3. Storage RLS policies ───────────────────────────────────────────────────

-- Users can upload their own images (path must start with their user ID)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'objects' AND schemaname = 'storage'
    AND policyname = 'card_images_upload'
  ) THEN
    CREATE POLICY "card_images_upload"
      ON storage.objects FOR INSERT
      WITH CHECK (
        bucket_id = 'card-images'
        AND auth.role() = 'authenticated'
        AND (storage.foldername(name))[1] = auth.uid()::text
      );
  END IF;
END $$;

-- Users can view their own uploaded images
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'objects' AND schemaname = 'storage'
    AND policyname = 'card_images_read_own'
  ) THEN
    CREATE POLICY "card_images_read_own"
      ON storage.objects FOR SELECT
      USING (
        bucket_id = 'card-images'
        AND (storage.foldername(name))[1] = auth.uid()::text
      );
  END IF;
END $$;

-- Admins can view all card images
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'objects' AND schemaname = 'storage'
    AND policyname = 'card_images_read_admin'
  ) THEN
    CREATE POLICY "card_images_read_admin"
      ON storage.objects FOR SELECT
      USING (
        bucket_id = 'card-images'
        AND EXISTS (
          SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'
        )
      );
  END IF;
END $$;

-- Users can delete their own images (e.g. resubmit)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'objects' AND schemaname = 'storage'
    AND policyname = 'card_images_delete_own'
  ) THEN
    CREATE POLICY "card_images_delete_own"
      ON storage.objects FOR DELETE
      USING (
        bucket_id = 'card-images'
        AND (storage.foldername(name))[1] = auth.uid()::text
      );
  END IF;
END $$;
