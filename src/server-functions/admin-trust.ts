// ─────────────────────────────────────────────────────────────────────────────
// Trust Engine Admin Server Functions — Phase 11
//
// Admin endpoints for the Trust Engine:
//   getAdminTrustScores    — paginated list of all user trust scores
//   getTrustScoreForUser   — single user trust score + breakdown
//   recomputeTrustScore    — force recompute for a specific user
//   adminBulkRecomputeTrust — bulk recompute (use with care — expensive)
//   getTrustLevelBreakdown  — aggregated stats per trust level
// ─────────────────────────────────────────────────────────────────────────────

import { createServerFn }    from "@tanstack/react-start";
import { getServerSupabase } from "../lib/supabase.server";
import { requireAdmin, logAdminAction } from "../lib/auth-server";
import { computeTrustScore, getTrustScore } from "../lib/trust-engine";

// ─── List all trust scores (paginated) ───────────────────────────────────────
export const getAdminTrustScores = createServerFn({ method: "GET" })
  .validator((d: {
    page?:       number;
    pageSize?:   number;
    level?:      string;
    minScore?:   number;
    maxScore?:   number;
  }) => d)
  .handler(async ({ data }) => {
    await requireAdmin();
    const db = getServerSupabase();

    const page = data.page ?? 0;
    const size = data.pageSize ?? 25;
    const from = page * size;
    const to   = from + size - 1;

    let q = db
      .from("trust_scores")
      .select(`
        user_id, trust_score, trust_level, trust_reason,
        updated_at, controls, breakdown,
        profiles!inner(id, full_name, phone, kyc_status)
      `, { count: "exact" })
      .order("trust_score", { ascending: false })
      .range(from, to);

    if (data.level)    q = (q as ReturnType<typeof q.eq>).eq("trust_level", data.level);
    if (data.minScore) q = (q as ReturnType<typeof q.gte>).gte("trust_score", data.minScore);
    if (data.maxScore) q = (q as ReturnType<typeof q.lte>).lte("trust_score", data.maxScore);

    const { data: rows, error, count } = await q;
    if (error) { console.error("[admin-trust]", error.message); throw new Error(error.message); }

    return { rows: rows ?? [], total: count ?? 0, page, pageSize: size };
  });

// ─── Get trust score for a single user ───────────────────────────────────────
export const getTrustScoreForUser = createServerFn({ method: "GET" })
  .validator((d: { userId: string }) => d)
  .handler(async ({ data }) => {
    await requireAdmin();
    const db = getServerSupabase();

    const score = await getTrustScore(data.userId, db);
    if (!score) {
      // Compute on demand if not yet cached
      return computeTrustScore(data.userId, db);
    }
    return score;
  });

// ─── Force recompute for a user ───────────────────────────────────────────────
export const recomputeTrustScore = createServerFn({ method: "POST" })
  .validator((d: { userId: string }) => d)
  .handler(async ({ data }) => {
    const adminId = await requireAdmin();
    const db      = getServerSupabase();

    const result = await computeTrustScore(data.userId, db);

    await logAdminAction(adminId, "trust_score_recomputed", data.userId, {
      score: result.score,
      level: result.level,
    });

    return result;
  });

// ─── Trust level breakdown (admin dashboard stats) ────────────────────────────
export const getTrustLevelBreakdown = createServerFn({ method: "GET" })
  .validator((d: Record<string, never>) => d)
  .handler(async () => {
    await requireAdmin();
    const db = getServerSupabase();

    const levels = ["New", "Verified", "Trusted", "Elite"] as const;
    const results = await Promise.all(
      levels.map(async (level) => {
        const { count } = await db
          .from("trust_scores")
          .select("*", { count: "exact", head: true })
          .eq("trust_level", level);
        return { level, count: count ?? 0 };
      })
    );

    const { data: avgRow } = await db
      .from("trust_scores")
      .select("trust_score");

    const allScores = (avgRow ?? []) as Array<{ trust_score: number }>;
    const avgScore  = allScores.length > 0
      ? Math.round(allScores.reduce((s, r) => s + Number(r.trust_score), 0) / allScores.length)
      : 0;

    // Treasury eligibility: Verified (score≥40) + Trusted + Elite
    const treasuryEligible = results.find(r => r.level === "Trusted")!.count +
                             results.find(r => r.level === "Elite")!.count;

    return { breakdown: results, avgScore, treasuryEligible, total: allScores.length };
  });

// ─── Get trust score history for a user ──────────────────────────────────────
export const getTrustScoreHistory = createServerFn({ method: "GET" })
  .validator((d: { userId: string; limit?: number }) => d)
  .handler(async ({ data }) => {
    await requireAdmin();
    const db = getServerSupabase();

    const { data: history, error } = await db
      .from("trust_score_history")
      .select("trust_score, trust_level, trust_reason, recorded_at, breakdown")
      .eq("user_id", data.userId)
      .order("recorded_at", { ascending: false })
      .limit(Math.min(data.limit ?? 30, 100))
      .catch(() => ({ data: null, error: null }));

    if (error) { console.error("[admin-trust]", error.message); throw new Error(error.message); }
    return history ?? [];
  });
