import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { getServerSupabase } from "../lib/supabase.server";
import { requireUser } from "../lib/auth-server";

// ─── Get current session user from cookie ─────────────────────────────────────
// Safe: reads session from HTTP-only cookie; never trusts client-supplied IDs.
// ─── Cookie token extraction — handles both unchunked and chunked Supabase cookies ─
// Supabase v2 splits large JWTs across sb-<ref>-auth-token.0/.1/… chunk cookies.
// This affects admin users whose app_metadata makes the JWT exceed ~4 KB.
function _parseTokenJson(raw: string): string | null {
  try {
    const p = JSON.parse(raw);
    return Array.isArray(p) ? (p[0]?.access_token ?? null) : (p?.access_token ?? null);
  } catch { return null; }
}
function _extractToken(cookieHeader: string): string | null {
  // 1. Try unchunked: sb-<ref>-auth-token=<value>
  const m = cookieHeader.match(/sb-[A-Za-z0-9]+-auth-token=([^;]+)/);
  if (m) { const t = _parseTokenJson(decodeURIComponent(m[1])); if (t) return t; }
  // 2. Reassemble chunked: sb-<ref>-auth-token.N=<chunk>
  const cm = cookieHeader.match(/sb-([A-Za-z0-9]+)-auth-token\.\d+=/);
  if (!cm) return null;
  const ref = cm[1];
  const map = new Map<number, string>();
  for (const seg of cookieHeader.split(';')) {
    const eqIdx = seg.indexOf('=');
    if (eqIdx === -1) continue;
    const name = seg.slice(0, eqIdx).trim();
    const val  = seg.slice(eqIdx + 1).trim();
    const nm = name.match(new RegExp('^sb-' + ref + '-auth-token\\.(\\d+)$'));
    if (nm) map.set(parseInt(nm[1], 10), val);
  }
  if (map.size === 0) return null;
  try {
    const joined = Array.from({ length: map.size }, (_, i) => map.get(i) ?? '').join('');
    return _parseTokenJson(decodeURIComponent(joined));
  } catch { return null; }
}

export const getSessionUser = createServerFn({ method: "GET" }).handler(async () => {
  try {
    const request = getRequest();
    const cookieHeader = request?.headers.get("cookie") ?? "";

    const accessToken = _extractToken(cookieHeader);
    if (!accessToken) return null;

    const db = getServerSupabase();
    const {
      data: { user },
      error,
    } = await db.auth.getUser(accessToken);
    if (error || !user) return null;

    const { data: profile } = await db
      .from("profiles")
      .select("*")
      .eq("id", user.id)
      .single();

    return profile ?? null;
  } catch {
    return null;
  }
});

// ─── Get own profile ──────────────────────────────────────────────────────────
// The client may pass userId for React Query cache keying, but the server
// ignores it and derives the identity from the session cookie.
export const getUserProfile = createServerFn({ method: "GET" })
  .validator((d: { userId?: string }) => d)
  .handler(async () => {
    const userId = await requireUser();
    const db = getServerSupabase();
    const { data: profile, error } = await db
      .from("profiles")
      .select("*")
      .eq("id", userId)
      .single();

    // PGRST116 = no rows: authenticated user exists but profile row not yet created
    if (error && (error as Record<string,string>).code !== "PGRST116") throw error;
    return profile ?? null;
  });

// ─── Update own profile ───────────────────────────────────────────────────────
export const updateProfile = createServerFn({ method: "POST" })
  .validator((d: { fullName?: string; avatarUrl?: string }) => d)
  .handler(async ({ data }) => {
    const userId = await requireUser();
    const db = getServerSupabase();
    const { error } = await db
      .from("profiles")
      .update({
        ...(data.fullName !== undefined && { full_name: data.fullName }),
        ...(data.avatarUrl !== undefined && { avatar_url: data.avatarUrl }),
      })
      .eq("id", userId);

    if (error) { console.error("[Auth] updateProfile:", error.message); return { success: false, error: error.message }; }
    return { success: true };
  });
