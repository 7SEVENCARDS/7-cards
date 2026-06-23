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
//
// Supabase v2 stores the auth session in a cookie named:
//   sb-<projectRef>-auth-token
// When the JWT exceeds ~4 KB (common for admin users with app_metadata claims),
// Supabase splits the value across numbered chunk cookies:
//   sb-<projectRef>-auth-token.0=<chunk0>
//   sb-<projectRef>-auth-token.1=<chunk1>
//   …
// The unchunked form is tried first; if no access_token is found we reassemble
// the chunks in order and parse the combined value.

function parseTokenJson(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? (parsed[0]?.access_token ?? null)
      : (parsed?.access_token ?? null);
  } catch {
    return null;
  }
}

function extractAccessToken(cookieHeader: string): string | null {
  // ── 1. Try the unchunked cookie: sb-<ref>-auth-token=<value> ────────────
  const unchunkedMatch = cookieHeader.match(/sb-[A-Za-z0-9]+-auth-token=([^;]+)/);
  if (unchunkedMatch) {
    const token = parseTokenJson(decodeURIComponent(unchunkedMatch[1]));
    if (token) return token;
  }

  // ── 2. Detect chunks: sb-<ref>-auth-token.N=<value> ─────────────────────
  const chunkNameMatch = cookieHeader.match(/sb-([A-Za-z0-9]+)-auth-token\.\d+=/);
  if (!chunkNameMatch) return null;

  const projectRef = chunkNameMatch[1];
  const chunkMap   = new Map<number, string>();

  for (const segment of cookieHeader.split(";")) {
    const eqIdx = segment.indexOf("=");
    if (eqIdx === -1) continue;
    const name  = segment.slice(0, eqIdx).trim();
    const value = segment.slice(eqIdx + 1).trim();
    const m = name.match(new RegExp(`^sb-${projectRef}-auth-token\\.(\\d+)$`));
    if (m) chunkMap.set(parseInt(m[1], 10), value);
  }

  if (chunkMap.size === 0) return null;

  try {
    const joined = Array.from({ length: chunkMap.size }, (_, i) => chunkMap.get(i) ?? "").join("");
    return parseTokenJson(decodeURIComponent(joined));
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

  if (profile?.role === "admin" || profile?.role === "super_admin") {
    return userId;
  }

  // Fallback: app_metadata.role (set by seed script; works pre-migrations)
  const metaRole = (user.app_metadata as Record<string, unknown>)?.role;
  if (metaRole === "admin" || metaRole === "super_admin") {
    return userId;
  }

  throw new ForbiddenError("Admin access required");
}

// ─── requireSuperAdmin ────────────────────────────────────────────────────────
// Validates session AND checks that the caller is a super_admin.
// Only super_admins may perform root-level operations (promote other admins,
// delete tenants, etc.).
//
// Throws AuthError (401) if not authenticated.
// Throws ForbiddenError (403) if authenticated but not super_admin.

export async function requireSuperAdmin(): Promise<string> {
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

  const { data: profile } = await db
    .from("profiles")
    .select("role")
    .eq("id", userId)
    .single();

  if (profile?.role === "super_admin") return userId;

  const metaRole = (user.app_metadata as Record<string, unknown>)?.role;
  if (metaRole === "super_admin") return userId;

  throw new ForbiddenError("Super admin access required");
}

// ─── getCallerRole ────────────────────────────────────────────────────────────
// Returns the profiles.role for a validated user ID.
// Call this AFTER requireUser() / requireAdmin() — it trusts the userId.

export async function getCallerRole(userId: string): Promise<string> {
  const db = getServerSupabase();
  const { data: profile } = await db
    .from("profiles")
    .select("role")
    .eq("id", userId)
    .single();
  return profile?.role ?? "user";
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
