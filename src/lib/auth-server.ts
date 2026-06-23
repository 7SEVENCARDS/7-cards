// ─────────────────────────────────────────────────────────────────────────────
// Server-side auth helpers — ALWAYS use these instead of trusting client IDs.
// Import only in server functions / server-only code.
// ─────────────────────────────────────────────────────────────────────────────

import { getRequest } from "@tanstack/react-start/server";
import { getServerSupabase } from "./supabase.server";

// ─── Error types ──────────────────────────────────────────────────────────────

export class AuthError extends Error {
  readonly status = 401;
  constructor(msg = "Authentication required") {
    super(msg);
    this.name = "AuthError";
  }
}

export class ForbiddenError extends Error {
  readonly status = 403;
  constructor(msg = "Forbidden") {
    super(msg);
    this.name = "ForbiddenError";
  }
}

// ─── Token extraction ─────────────────────────────────────────────────────────

function extractAccessToken(cookieHeader: string): string | null {
  const tokenMatch = cookieHeader.match(/sb-[^-]+-auth-token=([^;]+)/);
  if (!tokenMatch) return null;
  try {
    const raw = decodeURIComponent(tokenMatch[1]);
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? (parsed[0]?.access_token ?? null)
      : (parsed?.access_token ?? null);
  } catch {
    return null;
  }
}

// ─── requireUser ─────────────────────────────────────────────────────────────
// Extracts and validates the session cookie.
// Returns the authenticated user's UUID.
// Throws AuthError (401) if the session is missing or invalid.

export async function requireUser(): Promise<string> {
  const request = getRequest();
  const cookieHeader = request?.headers.get("cookie") ?? "";
  const accessToken = extractAccessToken(cookieHeader);

  if (!accessToken) throw new AuthError();

  const db = getServerSupabase();
  const {
    data: { user },
    error,
  } = await db.auth.getUser(accessToken);

  if (error || !user) throw new AuthError();
  return user.id;
}

// ─── getOptionalUser ──────────────────────────────────────────────────────────
// Same as requireUser but returns null instead of throwing.
// Use for endpoints that behave differently when logged in vs. not.

export async function getOptionalUser(): Promise<string | null> {
  try {
    return await requireUser();
  } catch {
    return null;
  }
}

// ─── requireAdmin ─────────────────────────────────────────────────────────────
// Validates session AND checks that the caller has admin privileges.
//
// Admin is confirmed via two sources (checked in order):
//   1. profiles.role = 'admin'   — set by DB migrations + seed workflow
//   2. app_metadata.role = 'admin' — set by seed workflow pre-migrations
//      (fallback so admin works even before DB schema is fully applied)
//
// Throws AuthError (401) if not authenticated.
// Throws ForbiddenError (403) if authenticated but not admin.

export async function requireAdmin(): Promise<string> {
  const request = getRequest();
  const cookieHeader = request?.headers.get("cookie") ?? "";
  const accessToken = extractAccessToken(cookieHeader);

  if (!accessToken) throw new AuthError();

  const db = getServerSupabase();
  const {
    data: { user },
    error,
  } = await db.auth.getUser(accessToken);

  if (error || !user) throw new AuthError();

  const userId = user.id;

  // Primary: profiles.role (requires DB migrations to be applied)
  const { data: profile } = await db
    .from("profiles")
    .select("role")
    .eq("id", userId)
    .single();

  if (profile?.role === "admin") {
    return userId;
  }

  // Fallback: app_metadata.role (set by seed script; works pre-migrations)
  if ((user.app_metadata as Record<string, unknown>)?.role === "admin") {
    return userId;
  }

  throw new ForbiddenError("Admin access required");
}

// ─── logAdminAction ───────────────────────────────────────────────────────────
// Writes an immutable audit record for every admin write operation.
// Call AFTER performing the action so the log reflects what actually happened.

export async function logAdminAction(
  adminId: string,
  action: string,
  targetId: string | null,
  meta?: Record<string, unknown>
): Promise<void> {
  const db = getServerSupabase();
  await db.from("admin_audit_log").insert({
    admin_id: adminId,
    action,
    target_id: targetId,
    meta: meta ?? null,
  });
}

// ─── requireVendorAuth ────────────────────────────────────────────────────────
// Validates session AND confirms the caller has a row in the vendors table.
// Returns the authenticated user's UUID.
// Throws AuthError (401) if not authenticated.
// Throws ForbiddenError (403) if authenticated but not a vendor, or suspended.

export async function requireVendorAuth(): Promise<string> {
  const userId = await requireUser();
  const db = getServerSupabase();

  const { data: vendor } = await db
    .from("vendors")
    .select("id, status")
    .eq("user_id", userId)
    .single();

  if (!vendor) {
    throw new ForbiddenError("Vendor account required");
  }

  if (vendor.status === "suspended") {
    throw new ForbiddenError("Vendor account is suspended");
  }

  return userId;
}
