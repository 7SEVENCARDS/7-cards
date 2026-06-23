// ─────────────────────────────────────────────────────────────────────────────
// Auth Server Extensions — Phase 2: Enterprise RBAC
//
// Extends auth-server.ts with:
//   • requireMasterVendor / requireCountryOperator / requireFranchiseOwner
//   • hasPermission — DB-backed capability check against permission_matrix
//   • getPermissions — fetch the full permission row for a role
//
// Import only in server functions / server-only code.
// ─────────────────────────────────────────────────────────────────────────────

import { requireUser, requireAdmin, AuthError, ForbiddenError, getCallerRole } from "./auth-server";
import { getServerSupabase } from "./supabase.server";

// ─── Permission column names (mirrors permission_matrix table) ────────────────
export type PermissionKey =
  | "can_trade"
  | "can_vendor_process"
  | "can_vendor_manage"
  | "can_view_rates"
  | "can_set_rates"
  | "can_kyc_approve"
  | "can_view_trades"
  | "can_manage_users"
  | "can_view_financials"
  | "can_run_reconciliation"
  | "can_manage_flags"
  | "can_promote_admins"
  | "can_manage_franchise"
  | "can_view_risk";

// ─── Franchise vendor roles ────────────────────────────────────────────────────
const FRANCHISE_ROLES = [
  "master_vendor",
  "regional_vendor",
  "country_operator",
  "franchise_owner",
] as const;

const ELEVATED_VENDOR_ROLES = [
  "vendor",
  ...FRANCHISE_ROLES,
] as const;

// ─── requireMasterVendor ──────────────────────────────────────────────────────
// Requires master_vendor, regional_vendor, country_operator, or admin.
// Used for vendor management operations (approve/suspend sub-vendors, set rates).

export async function requireMasterVendor(): Promise<string> {
  const userId = await requireUser();
  const role   = await getCallerRole(userId);

  const allowed = [...FRANCHISE_ROLES, "admin", "super_admin"] as string[];
  if (!allowed.includes(role)) {
    throw new ForbiddenError("Master vendor or higher role required");
  }
  return userId;
}

// ─── requireCountryOperator ───────────────────────────────────────────────────
// Requires country_operator, admin, or super_admin.
// Used for country-level configuration: rates, reconciliation, franchise management.

export async function requireCountryOperator(): Promise<string> {
  const userId = await requireUser();
  const role   = await getCallerRole(userId);

  const allowed = ["country_operator", "franchise_owner", "admin", "super_admin"] as string[];
  if (!allowed.includes(role)) {
    throw new ForbiddenError("Country operator or higher role required");
  }
  return userId;
}

// ─── requireFranchiseOwner ────────────────────────────────────────────────────
// Requires franchise_owner, admin, or super_admin.
// Used for financial reporting access.

export async function requireFranchiseOwner(): Promise<string> {
  const userId = await requireUser();
  const role   = await getCallerRole(userId);

  const allowed = ["franchise_owner", "country_operator", "admin", "super_admin"] as string[];
  if (!allowed.includes(role)) {
    throw new ForbiddenError("Franchise owner or higher role required");
  }
  return userId;
}

// ─── hasPermission ────────────────────────────────────────────────────────────
// DB-backed capability check. Use for fine-grained checks that should respect
// the permission matrix rather than hardcoded role checks.
//
// Example: await hasPermission(userId, "can_set_rates")

export async function hasPermission(
  userId: string,
  permission: PermissionKey
): Promise<boolean> {
  const db   = getServerSupabase();
  const role = await getCallerRole(userId);

  const { data } = await db
    .from("permission_matrix")
    .select(permission)
    .eq("role", role)
    .single();

  return (data as Record<string, boolean> | null)?.[permission] === true;
}

// ─── requirePermission ────────────────────────────────────────────────────────
// Like hasPermission but throws ForbiddenError if the check fails.
// Use at the top of server functions that have a specific capability requirement.

export async function requirePermission(
  userId: string,
  permission: PermissionKey
): Promise<void> {
  const ok = await hasPermission(userId, permission);
  if (!ok) {
    throw new ForbiddenError(`Permission required: ${permission}`);
  }
}

// ─── getPermissions ───────────────────────────────────────────────────────────
// Returns the full permission row for a user's role.
// Useful for rendering permission-aware UIs without multiple round trips.

export async function getPermissions(userId: string): Promise<Record<PermissionKey, boolean> | null> {
  const db   = getServerSupabase();
  const role = await getCallerRole(userId);

  const { data } = await db
    .from("permission_matrix")
    .select("*")
    .eq("role", role)
    .single();

  return data as Record<PermissionKey, boolean> | null;
}

// ─── isElevatedVendor ─────────────────────────────────────────────────────────
// Returns true for any vendor-tier role (vendor, master_vendor, regional_vendor,
// country_operator, franchise_owner). Used for portal access guards.

export async function isElevatedVendor(userId: string): Promise<boolean> {
  const role = await getCallerRole(userId);
  return (ELEVATED_VENDOR_ROLES as readonly string[]).includes(role);
}

// ─── requireAnyRole ──────────────────────────────────────────────────────────
// Generic guard — throws ForbiddenError unless the caller has one of the listed roles.
// Prefer specific helpers above; use this only when the role set is dynamic.

export async function requireAnyRole(roles: string[]): Promise<string> {
  const userId = await requireUser();
  const role   = await getCallerRole(userId);
  if (!roles.includes(role)) {
    throw new ForbiddenError(`One of [${roles.join(", ")}] required`);
  }
  return userId;
}

// Re-export base helpers for convenience
export { requireUser, requireAdmin, AuthError, ForbiddenError, getCallerRole };
