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
