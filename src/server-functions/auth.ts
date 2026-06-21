import { createServerFn } from "@tanstack/react-start";
import { getWebRequest } from "@tanstack/react-start/server";
import { getServerSupabase } from "../lib/supabase.server";
import { requireUser } from "../lib/auth-server";

// ─── Get current session user from cookie ─────────────────────────────────────
// Safe: reads session from HTTP-only cookie; never trusts client-supplied IDs.
export const getSessionUser = createServerFn({ method: "GET" }).handler(async () => {
  try {
    const request = getWebRequest();
    const cookieHeader = request?.headers.get("cookie") ?? "";

    const tokenMatch = cookieHeader.match(/sb-[^-]+-auth-token=([^;]+)/);
    if (!tokenMatch) return null;

    const db = getServerSupabase();
    const tokenData = JSON.parse(decodeURIComponent(tokenMatch[1]));
    const accessToken = Array.isArray(tokenData)
      ? tokenData[0]?.access_token
      : tokenData?.access_token;
    if (!accessToken) return null;

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

    if (error) throw error;
    return profile;
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

    if (error) throw error;
    return { success: true };
  });
