import { createServerFn } from "@tanstack/react-start";
import { getServerSupabase } from "../lib/supabase.server";

// ─── Get weekly leaderboard ────────────────────────────────────────────────────
export const getLeaderboard = createServerFn({ method: "GET" })
  .validator((d: { limit?: number }) => d)
  .handler(async ({ data }) => {
    try {
      const db = getServerSupabase();
      const { data: rows, error } = await db
        .from("leaderboard")
        .select("*")
        .order("weekly_rank", { ascending: true })
        .limit(data.limit ?? 20);

      if (error) throw error;
      return rows ?? [];
    } catch {
      return [];
    }
  });

// ─── Get user XP & level ──────────────────────────────────────────────────────
export const getUserXP = createServerFn({ method: "GET" })
  .validator((d: { userId: string }) => d)
  .handler(async ({ data }) => {
    try {
      const db = getServerSupabase();

      // Get XP
      const { data: xp } = await db
        .from("user_xp")
        .select("*")
        .eq("user_id", data.userId)
        .single();

      // Get rank from leaderboard view
      const { data: rank } = await db
        .from("leaderboard")
        .select("weekly_rank, all_time_rank")
        .eq("id", data.userId)
        .single();

      return {
        totalXp: xp?.total_xp ?? 0,
        weeklyXp: xp?.weekly_xp ?? 0,
        level: xp?.level ?? 1,
        streakDays: xp?.streak_days ?? 0,
        tradeCount: xp?.trade_count ?? 0,
        weeklyRank: rank?.weekly_rank ?? 0,
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

// ─── Get user badges ──────────────────────────────────────────────────────────
export const getUserBadges = createServerFn({ method: "GET" })
  .validator((d: { userId: string }) => d)
  .handler(async ({ data }) => {
    try {
      const db = getServerSupabase();
      const { data: badges, error } = await db
        .from("user_badges")
        .select("badge_key, earned_at")
        .eq("user_id", data.userId);

      if (error) throw error;
      return badges?.map((b) => b.badge_key) ?? [];
    } catch {
      return [];
    }
  });
