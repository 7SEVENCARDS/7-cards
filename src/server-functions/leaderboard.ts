import { createServerFn } from "@tanstack/react-start";
import { getServerSupabase } from "../lib/supabase.server";
import { requireUser } from "../lib/auth-server";

// ─── Get weekly leaderboard ────────────────────────────────────────────────────
// The raw user `id` (UUID) is never returned in the public leaderboard to
// prevent user enumeration. Only display_name and rank data are exposed.
export const getLeaderboard = createServerFn({ method: "GET" })
  .validator((d: { limit?: number }) => d)
  .handler(async ({ data }) => {
    try {
      const db = getServerSupabase();
      const { data: rows, error } = await db
        .from("leaderboard")
        .select("display_name, weekly_xp, all_time_xp, weekly_rank, all_time_rank, level, trade_count")
        .order("weekly_rank", { ascending: true })
        .limit(data.limit ?? 20);

      if (error) { console.error("[leaderboard] DB error", error.message); return []; }
      return rows ?? [];
    } catch {
      return [];
    }
  });

// ─── Get own XP & level ───────────────────────────────────────────────────────
export const getUserXP = createServerFn({ method: "GET" })
  .validator((d: { userId?: string }) => d)
  .handler(async () => {
    try {
      const userId = await requireUser();
      const db = getServerSupabase();

      const { data: xp } = await db
        .from("user_xp")
        .select("*")
        .eq("user_id", userId)
        .single();

      const { data: rank } = await db
        .from("leaderboard")
        .select("weekly_rank, all_time_rank")
        .eq("id", userId)
        .single();

      return {
        totalXp:    xp?.total_xp    ?? 0,
        weeklyXp:   xp?.weekly_xp   ?? 0,
        level:      xp?.level       ?? 1,
        streakDays: xp?.streak_days ?? 0,
        tradeCount: xp?.trade_count ?? 0,
        weeklyRank:  rank?.weekly_rank   ?? 0,
        allTimeRank: rank?.all_time_rank ?? 0,
      };
    } catch {
      return {
        totalXp: 0, weeklyXp: 0, level: 1,
        streakDays: 0, tradeCount: 0,
        weeklyRank: 0, allTimeRank: 0,
      };
    }
  });

// ─── Get own badges ───────────────────────────────────────────────────────────
export const getUserBadges = createServerFn({ method: "GET" })
  .validator((d: { userId?: string }) => d)
  .handler(async () => {
    try {
      const userId = await requireUser();
      const db = getServerSupabase();
      const { data: badges, error } = await db
        .from("user_badges")
        .select("badge_key, earned_at")
        .eq("user_id", userId);

      if (error) { console.error("[leaderboard] DB error", error.message); return []; }
      return badges?.map((b) => b.badge_key) ?? [];
    } catch {
      return [];
    }
  });
