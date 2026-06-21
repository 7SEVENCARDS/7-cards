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
