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
