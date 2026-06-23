-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 028: RBAC Expansion
--
-- Adds two new role values to profiles.role:
--   'vendor'      — user linked to an active vendors row
--   'super_admin' — root operator; can do everything admin can + more
--
-- Adds helper functions used in RLS policies across the schema:
--   is_admin()       — true when caller is admin OR super_admin
--   is_super_admin() — true when caller is super_admin only
--
-- Adds vendor_role_sync trigger:
--   When a vendor row is inserted or activated, sets profiles.role = 'vendor'
--   (unless the user already has admin/super_admin — those always take priority).
--
-- Updates all existing RLS policies that check `role = 'admin'` to also
-- accept `role = 'super_admin'`.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Expand profiles.role CHECK constraint ──────────────────────────────────
DO $$
DECLARE
  _cname TEXT;
BEGIN
  -- Find the existing check constraint on profiles.role (auto-named by PG)
  SELECT constraint_name INTO _cname
  FROM information_schema.check_constraints cc
  JOIN information_schema.constraint_column_usage cu
    ON cu.constraint_name = cc.constraint_name
  WHERE cu.table_name = 'profiles'
    AND cu.column_name = 'role'
  LIMIT 1;

  IF _cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE profiles DROP CONSTRAINT %I', _cname);
  END IF;

  ALTER TABLE profiles
    ADD CONSTRAINT profiles_role_check
      CHECK (role IN ('user', 'admin', 'support', 'vendor', 'super_admin'));
END $$;

-- ── 2. Helper RLS functions ───────────────────────────────────────────────────

-- Returns true when the current user has admin OR super_admin role.
-- Use this in all RLS policies that previously checked role = 'admin'.
CREATE OR REPLACE FUNCTION is_admin()
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid()
      AND role IN ('admin', 'super_admin')
  );
$$;

-- Returns true only for super_admin (for super-admin-only operations).
CREATE OR REPLACE FUNCTION is_super_admin()
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid()
      AND role = 'super_admin'
  );
$$;

-- ── 3. Vendor role sync trigger ───────────────────────────────────────────────
-- When a vendor account is activated, promote their profiles.role to 'vendor'
-- (never overwrite admin or super_admin).

CREATE OR REPLACE FUNCTION sync_vendor_role()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NEW.status = 'active' THEN
    UPDATE profiles
    SET role = 'vendor'
    WHERE id = NEW.user_id
      AND role NOT IN ('admin', 'super_admin');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_vendor_role ON vendors;
CREATE TRIGGER trg_sync_vendor_role
  AFTER INSERT OR UPDATE OF status ON vendors
  FOR EACH ROW EXECUTE FUNCTION sync_vendor_role();

-- Backfill: any currently-active vendor whose profile is still 'user'
UPDATE profiles
SET role = 'vendor'
WHERE role = 'user'
  AND id IN (SELECT user_id FROM vendors WHERE status = 'active');

-- ── 4. Refresh RLS policies to accept super_admin everywhere admin is accepted ─
-- We do this by re-creating policies that still hard-code role = 'admin'
-- to use the is_admin() helper instead, which covers both roles.

-- profiles table
DO $pol$ BEGIN

  DROP POLICY IF EXISTS "Admins can view all profiles"   ON profiles;
  DROP POLICY IF EXISTS "Admins can update all profiles" ON profiles;

  CREATE POLICY "Admins can view all profiles" ON profiles
    FOR SELECT USING (is_admin());

  CREATE POLICY "Admins can update all profiles" ON profiles
    FOR UPDATE USING (is_admin());

END $pol$;

-- trades table
DO $pol$ BEGIN

  DROP POLICY IF EXISTS "Admins can view all trades"   ON trades;
  DROP POLICY IF EXISTS "Admins can update all trades" ON trades;

  CREATE POLICY "Admins can view all trades" ON trades
    FOR SELECT USING (is_admin());

  CREATE POLICY "Admins can update all trades" ON trades
    FOR UPDATE USING (is_admin());

END $pol$;

-- ── 5. Comments ───────────────────────────────────────────────────────────────
COMMENT ON FUNCTION is_admin()       IS 'True when auth.uid() has admin or super_admin role in profiles';
COMMENT ON FUNCTION is_super_admin() IS 'True when auth.uid() has super_admin role in profiles';
COMMENT ON FUNCTION sync_vendor_role() IS 'Keeps profiles.role = vendor in sync with vendors.status = active';

COMMENT ON CONSTRAINT profiles_role_check ON profiles IS
  'Valid role values: user | admin | support | vendor | super_admin';
