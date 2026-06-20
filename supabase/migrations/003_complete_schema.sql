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

-- ─── Indexes ──────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_trades_user        ON trades(user_id);
CREATE INDEX IF NOT EXISTS idx_trades_status      ON trades(status);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_ref  ON subscriptions(transaction_ref);

-- Done!
-- After running: go to Authentication → Triggers and confirm on_auth_user_created is listed
