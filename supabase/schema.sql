-- ─────────────────────────────────────────────────────────────────────────────
-- 7SEVEN CARDS — Supabase Database Schema
-- Run this in Supabase SQL Editor: https://supabase.com → SQL Editor
-- ─────────────────────────────────────────────────────────────────────────────

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── PROFILES ─────────────────────────────────────────────────────────────────
-- Extends Supabase auth.users with app-specific fields
CREATE TABLE IF NOT EXISTS profiles (
  id            UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name     TEXT DEFAULT '',
  phone         TEXT UNIQUE,
  avatar_url    TEXT,
  kyc_status    TEXT DEFAULT 'pending' CHECK (kyc_status IN ('pending','submitted','verified','rejected')),
  kyc_bvn       TEXT,            -- stored encrypted in production
  kyc_nin       TEXT,
  premium       BOOLEAN DEFAULT false,
  referral_code TEXT UNIQUE DEFAULT upper(substr(md5(random()::text), 1, 8)),
  referred_by   UUID REFERENCES profiles(id),
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own profile"
  ON profiles FOR SELECT USING (auth.uid() = id);

CREATE POLICY "Users can update own profile"
  ON profiles FOR UPDATE USING (auth.uid() = id);

-- Auto-create profile on signup
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO profiles (id, full_name, phone)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    NEW.phone
  );
  -- Create default NGN wallet
  INSERT INTO wallets (user_id, currency) VALUES (NEW.id, 'NGN');
  -- Initialize XP record
  INSERT INTO user_xp (user_id) VALUES (NEW.id);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- ─── WALLETS ──────────────────────────────────────────────────────────────────
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

ALTER TABLE wallets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own wallets"
  ON wallets FOR SELECT USING (auth.uid() = user_id);

-- ─── PAYOUT ACCOUNTS (Bank Accounts) ─────────────────────────────────────────
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

ALTER TABLE payout_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own payout accounts"
  ON payout_accounts FOR ALL USING (auth.uid() = user_id);

-- ─── EXCHANGE RATES ───────────────────────────────────────────────────────────
-- Cached rates, refreshed by server via Reloadly + Busha
CREATE TABLE IF NOT EXISTS exchange_rates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand           TEXT NOT NULL,    -- 'Apple', 'Amazon', etc.
  region          TEXT DEFAULT 'USA',
  rate_per_dollar NUMERIC(10,2) NOT NULL,
  source          TEXT DEFAULT 'reloadly', -- 'reloadly' | 'manual'
  trend           TEXT DEFAULT '+0.0%',
  updated_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE (brand, region)
);

-- No RLS — rates are public
-- Seed default rates (will be overwritten by Reloadly API on first fetch)
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

-- ─── TRADES ───────────────────────────────────────────────────────────────────
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
  -- Reloadly
  reloadly_transaction_id TEXT,
  reloadly_order_id       TEXT,
  -- Squadco
  squadco_transaction_ref TEXT,
  squadco_payment_id      TEXT,
  -- Status machine: pending → scanning → verified | invalid → processing → paid | failed
  status                  TEXT DEFAULT 'pending' CHECK (
    status IN ('pending','scanning','verified','invalid','processing','paid','failed')
  ),
  failure_reason          TEXT,
  settled_at              TIMESTAMPTZ,
  xp_earned               INTEGER DEFAULT 0,
  created_at              TIMESTAMPTZ DEFAULT now(),
  updated_at              TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE trades ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own trades"
  ON trades FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own trades"
  ON trades FOR INSERT WITH CHECK (auth.uid() = user_id);

-- ─── XP & LEADERBOARD ────────────────────────────────────────────────────────
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

ALTER TABLE user_xp ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own XP"
  ON user_xp FOR SELECT USING (auth.uid() = user_id);

-- Leaderboard view (public — no RLS needed)
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
  RANK() OVER (ORDER BY x.weekly_xp DESC) AS weekly_rank,
  RANK() OVER (ORDER BY x.total_xp DESC) AS all_time_rank
FROM user_xp x
JOIN profiles p ON p.id = x.user_id
ORDER BY x.weekly_xp DESC;

-- ─── BADGES ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_badges (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id   UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  badge_key TEXT NOT NULL,  -- 'speed_demon','big_baller','first_trade','crypto_king','sharp_shoot'
  earned_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id, badge_key)
);

ALTER TABLE user_badges ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own badges"
  ON user_badges FOR SELECT USING (auth.uid() = user_id);

-- ─── NOTIFICATIONS ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  message    TEXT NOT NULL,
  read       BOOLEAN DEFAULT false,
  type       TEXT DEFAULT 'info', -- 'info','success','warning','error'
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own notifications"
  ON notifications FOR ALL USING (auth.uid() = user_id);

-- ─── HELPER FUNCTIONS ────────────────────────────────────────────────────────

-- Award XP after a successful trade (called server-side via service role)
CREATE OR REPLACE FUNCTION award_trade_xp(
  p_user_id UUID,
  p_xp      INTEGER
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  today DATE := CURRENT_DATE;
  rec   user_xp%ROWTYPE;
BEGIN
  SELECT * INTO rec FROM user_xp WHERE user_id = p_user_id;

  -- Streak logic
  IF rec.last_trade_date = today - INTERVAL '1 day' THEN
    rec.streak_days := rec.streak_days + 1;
  ELSIF rec.last_trade_date <> today THEN
    rec.streak_days := 1;
  END IF;

  -- Weekly XP reset if new week
  IF rec.week_start < date_trunc('week', today)::date THEN
    rec.weekly_xp := 0;
    rec.week_start := date_trunc('week', today)::date;
  END IF;

  UPDATE user_xp SET
    total_xp        = total_xp + p_xp,
    weekly_xp       = weekly_xp + p_xp,
    streak_days     = rec.streak_days,
    last_trade_date = today,
    trade_count     = trade_count + 1,
    level           = GREATEST(1, (total_xp + p_xp) / 1000 + 1),
    week_start      = rec.week_start
  WHERE user_id = p_user_id;

  -- Auto-award badges
  IF (SELECT trade_count FROM user_xp WHERE user_id = p_user_id) = 1 THEN
    INSERT INTO user_badges (user_id, badge_key) VALUES (p_user_id, 'first_trade') ON CONFLICT DO NOTHING;
  END IF;
END;
$$;

-- ─── UPDATED_AT TRIGGERS ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

CREATE OR REPLACE TRIGGER profiles_updated_at
  BEFORE UPDATE ON profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE OR REPLACE TRIGGER wallets_updated_at
  BEFORE UPDATE ON wallets FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE OR REPLACE TRIGGER trades_updated_at
  BEFORE UPDATE ON trades FOR EACH ROW EXECUTE FUNCTION set_updated_at();
