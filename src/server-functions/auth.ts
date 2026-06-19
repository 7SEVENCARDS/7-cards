import { createServerFn } from "@tanstack/react-start";
import { getWebRequest } from "@tanstack/react-start/server";
import { getServerSupabase } from "../lib/supabase.server";

// ─── Get current session user from cookie ─────────────────────────────────────
export const getSessionUser = createServerFn({ method: "GET" }).handler(async () => {
  try {
    const request = getWebRequest();
    const cookieHeader = request?.headers.get("cookie") ?? "";

    // Extract Supabase access token from cookie
    const tokenMatch = cookieHeader.match(/sb-[^-]+-auth-token=([^;]+)/);
    if (!tokenMatch) return null;

    const db = getServerSupabase();

    // Verify token with Supabase
    const tokenData = JSON.parse(decodeURIComponent(tokenMatch[1]));
    const accessToken = Array.isArray(tokenData) ? tokenData[0]?.access_token : tokenData?.access_token;
    if (!accessToken) return null;

    const { data: { user }, error } = await db.auth.getUser(accessToken);
    if (error || !user) return null;

    // Fetch profile
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

// ─── Get full user profile ────────────────────────────────────────────────────
export const getUserProfile = createServerFn({ method: "GET" })
  .validator((d: { userId: string }) => d)
  .handler(async ({ data }) => {
    const db = getServerSupabase();
    const { data: profile, error } = await db
      .from("profiles")
      .select("*")
      .eq("id", data.userId)
      .single();

    if (error) throw error;
    return profile;
  });

// ─── Update profile ───────────────────────────────────────────────────────────
export const updateProfile = createServerFn({ method: "POST" })
  .validator((d: { userId: string; fullName?: string; avatarUrl?: string }) => d)
  .handler(async ({ data }) => {
    const db = getServerSupabase();
    const { error } = await db
      .from("profiles")
      .update({
        ...(data.fullName && { full_name: data.fullName }),
        ...(data.avatarUrl && { avatar_url: data.avatarUrl }),
      })
      .eq("id", data.userId);

    if (error) throw error;
    return { success: true };
  });
