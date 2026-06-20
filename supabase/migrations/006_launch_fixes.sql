-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 006: Launch Fixes
-- Idempotent — safe to run multiple times.
-- Fixes:
--   1. Add email column to profiles (required by premium checkout)
--   2. Fix leaderboard view — add display_name + all_time_xp alias
--   3. Subscription expiry enforcement (expire_stale_subscriptions fn + pg_cron)
--   4. Verification usage index (daily quota queries)
--   5. RLS: leaderboard grant for authenticated reads
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── 1. Add email to profiles ────────────────────────────────────────────────
-- Required by createPremiumCheckout which reads profile.email server-side.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS email TEXT;

-- Sync existing auth emails into profiles (one-time backfill)
UPDATE profiles p
SET email = u.email
FROM auth.users u
WHERE p.id = u.id
  AND (p.email IS NULL OR p.email = '')
  AND u.email IS NOT NULL;

-- Trigger: keep profiles.email in sync whenever auth.users.email changes
CREATE OR REPLACE FUNCTION sync_profile_email()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE profiles
  SET email = NEW.email
  WHERE id = NEW.id
    AND (email IS NULL OR email = '');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_profile_email ON auth.users;
CREATE TRIGGER trg_sync_profile_email
  AFTER INSERT OR UPDATE OF email ON auth.users
  FOR EACH ROW EXECUTE FUNCTION sync_profile_email();

-- ─── 2. Fix leaderboard view ─────────────────────────────────────────────────
-- Original view exposed full_name and total_xp.
-- Server code queries display_name (privacy-masked) and all_time_xp (alias).
DROP VIEW IF EXISTS leaderboard CASCADE;

CREATE OR REPLACE VIEW leaderboard AS
SELECT
  p.id,
  -- Privacy-safe display name for public leaderboard
  CASE
    WHEN p.full_name IS NULL OR trim(p.full_name) = '' THEN 'Anonymous'
    ELSE split_part(trim(p.full_name), ' ', 1) || ' ****'
  END                                                   AS display_name,
  p.full_name,
  p.avatar_url,
  x.total_xp,
  x.total_xp                                            AS all_time_xp,
  x.weekly_xp,
  x.level,
  x.streak_days,
  x.trade_count,
  RANK() OVER (ORDER BY x.weekly_xp DESC)               AS weekly_rank,
  RANK() OVER (ORDER BY x.total_xp  DESC)               AS all_time_rank
FROM user_xp x
JOIN profiles p ON p.id = x.user_id
ORDER BY x.weekly_xp DESC;

-- Allow authenticated users and the anon role to query the view
GRANT SELECT ON leaderboard TO authenticated, anon;

-- ─── 3. Subscription expiry enforcement ──────────────────────────────────────
-- Marks active subscriptions as 'expired' once their expires_at passes.
-- The sync_premium_flag trigger (migration 001) automatically flips
-- profiles.premium = false when status changes to 'expired'.
CREATE OR REPLACE FUNCTION expire_stale_subscriptions()
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  expired_count INTEGER;
BEGIN
  UPDATE subscriptions
  SET status = 'expired'
  WHERE status = 'active'
    AND expires_at IS NOT NULL
    AND expires_at < NOW();

  GET DIAGNOSTICS expired_count = ROW_COUNT;
  RETURN expired_count;
END;
$$;

-- Schedule via pg_cron if the extension is available (Supabase Pro+)
-- Runs daily at 02:00 UTC. Safe to call manually if pg_cron is unavailable.
DO $cron$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    -- Remove any previous schedule to avoid duplicates on re-run
    PERFORM cron.unschedule('7sc-expire-subscriptions')
    WHERE EXISTS (
      SELECT 1 FROM cron.job WHERE jobname = '7sc-expire-subscriptions'
    );

    PERFORM cron.schedule(
      '7sc-expire-subscriptions',
      '0 2 * * *',
      'SELECT expire_stale_subscriptions()'
    );
  END IF;
END $cron$;

-- ─── 4. Verification usage — index for daily quota queries ───────────────────
-- db-helpers.ts queries: .gte("created_at", todayStart.toISOString())
CREATE INDEX IF NOT EXISTS idx_verification_usage_user_day
  ON verification_usage(user_id, created_at DESC);

-- ─── 5. Admin audit log — ensure service role can always insert ───────────────
-- Server functions use the service role client which bypasses RLS by default.
-- This policy is a belt-and-suspenders fallback for any explicit FORCE RLS case.
DO $pol$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'admin_audit_log'
      AND policyname = 'Service role bypass for audit inserts'
  ) THEN
    CREATE POLICY "Service role bypass for audit inserts"
      ON admin_audit_log FOR INSERT
      WITH CHECK (true);
  END IF;
END $pol$;

-- ─── 6. Ensure admin_audit_log target_id accepts UUIDs and text ──────────────
-- target_id is TEXT in migration 005, which is correct — no change needed.
-- Just add an index for fast target lookups.
CREATE INDEX IF NOT EXISTS idx_audit_target_id
  ON admin_audit_log(target_id, created_at DESC);

-- ─── 7. Leaderboard: index for weekly_rank ordering ──────────────────────────
-- The leaderboard view uses RANK() OVER; indexes on user_xp speed up the scan.
CREATE INDEX IF NOT EXISTS idx_user_xp_weekly   ON user_xp(weekly_xp DESC);
CREATE INDEX IF NOT EXISTS idx_user_xp_total    ON user_xp(total_xp  DESC);

-- ─── Done ─────────────────────────────────────────────────────────────────────
-- Next steps after running this migration:
--   • Promote first admin: UPDATE profiles SET role = 'admin' WHERE id = '<uuid>';
--   • Verify leaderboard: SELECT display_name, weekly_rank FROM leaderboard LIMIT 5;
--   • Test expiry:        SELECT expire_stale_subscriptions();
