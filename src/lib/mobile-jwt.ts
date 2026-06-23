// ─────────────────────────────────────────────────────────────────────────────
// Mobile JWT — Phase 13: Mobile API Platform
//
// Provides JWT + refresh token support for mobile clients (iOS/Android).
//
// Mobile apps cannot use HTTP-only cookies (no browser). Instead they:
//   1. POST /api/v1/auth/login  → receive { access_token, refresh_token, expires_in }
//   2. Store both tokens securely (Keychain on iOS, Keystore on Android)
//   3. Pass access_token in Authorization: Bearer header
//   4. POST /api/v1/auth/refresh when access_token expires
//
// Implementation:
//   • access_token  — Supabase JWT (short-lived, 1h)
//   • refresh_token — Supabase refresh token (long-lived, 7d)
//   • We delegate the actual JWT issuance to Supabase Auth
//   • This module handles token extraction and validation for mobile requests
//
// ─────────────────────────────────────────────────────────────────────────────

import { getServerSupabase } from "./supabase.server";

export interface MobileSession {
  userId:        string;
  accessToken:   string;
  refreshToken:  string;
  expiresAt:     number;  // Unix timestamp (seconds)
}

// ─── Extract Bearer token from Authorization header ───────────────────────────
export function extractBearerToken(request: Request): string | null {
  const auth = request.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return null;
  return auth.slice(7).trim() || null;
}

// ─── Validate a mobile Bearer token ──────────────────────────────────────────
// Returns the userId if valid, throws on invalid/expired.
export async function requireMobileUser(request: Request): Promise<string> {
  const token = extractBearerToken(request);
  if (!token) {
    throw Object.assign(new Error("Authorization: Bearer token required"), { status: 401 });
  }

  const db = getServerSupabase();
  const { data: { user }, error } = await db.auth.getUser(token);

  if (error || !user) {
    throw Object.assign(
      new Error(error?.message ?? "Invalid or expired access token"),
      { status: 401 }
    );
  }

  return user.id;
}

// ─── Sign in (mobile) — email + password ─────────────────────────────────────
export async function mobileSignIn(
  email: string,
  password: string
): Promise<MobileSession> {
  const db = getServerSupabase();
  const { data, error } = await db.auth.signInWithPassword({ email, password });

  if (error || !data.session || !data.user) {
    throw Object.assign(
      new Error(error?.message ?? "Invalid credentials"),
      { status: 401 }
    );
  }

  return {
    userId:       data.user.id,
    accessToken:  data.session.access_token,
    refreshToken: data.session.refresh_token,
    expiresAt:    data.session.expires_at ?? Math.floor(Date.now() / 1000) + 3600,
  };
}

// ─── Refresh (mobile) — exchange refresh_token for new access_token ───────────
export async function mobileRefresh(refreshToken: string): Promise<MobileSession> {
  const db = getServerSupabase();
  const { data, error } = await db.auth.refreshSession({ refresh_token: refreshToken });

  if (error || !data.session || !data.user) {
    throw Object.assign(
      new Error(error?.message ?? "Invalid or expired refresh token"),
      { status: 401 }
    );
  }

  return {
    userId:       data.user.id,
    accessToken:  data.session.access_token,
    refreshToken: data.session.refresh_token,
    expiresAt:    data.session.expires_at ?? Math.floor(Date.now() / 1000) + 3600,
  };
}

// ─── Sign out (mobile) ────────────────────────────────────────────────────────
export async function mobileSignOut(accessToken: string): Promise<void> {
  const db = getServerSupabase();
  // Set the user's JWT so signOut invalidates the right session
  await db.auth.setSession({ access_token: accessToken, refresh_token: "" }).catch(() => {});
  await db.auth.signOut();
}
