-- ============================================================
-- 7SEVEN CARDS — All Supabase Migrations (001 → 014)
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

