// ─────────────────────────────────────────────────────────────────────────────
// Premium Admin Server Functions — Phase 15
//
// Admin endpoints for the Premium Membership system:
//   getAdminPremiumSummary  — KPIs for mission control
//   listPremiumUsers        — paginated premium member list
//   getPremiumRevenueReport — allocation breakdown by period
//   getPremiumChurnReport   — retention/churn analytics
//   getPremiumTrustDist     — trust level distribution of premium users
// ─────────────────────────────────────────────────────────────────────────────

import { createServerFn }     from "@tanstack/react-start";
import { getServerSupabase }  from "../lib/supabase.server";
import { requireAdmin }       from "../lib/auth-server";
import { getPremiumSummary, getLiquidityPoolStats } from "../lib/premium-engine";

// ─── Premium KPI summary ──────────────────────────────────────────────────────
export const getAdminPremiumSummary = createServerFn({ method: "GET" })
  .validator((d: Record<string, never>) => d)
  .handler(async () => {
    await requireAdmin();
    const db = getServerSupabase();

    const [summary, liquidity] = await Promise.all([
      getPremiumSummary(db),
      getLiquidityPoolStats(db),
    ]);

    // Retention rate: (active now) / (active + churned) this month
    const retentionDenominator = summary.totalPremium + summary.churnedThisMonth;
    const retentionRate = retentionDenominator > 0
      ? Math.round((summary.totalPremium / retentionDenominator) * 100)
      : 100;

    // Conversion rate needs total users for context
    const { count: totalUsers } = await db
      .from("profiles")
      .select("*", { count: "exact", head: true });

    const conversionRate = totalUsers && totalUsers > 0
      ? Math.round((summary.totalPremium / totalUsers) * 100 * 10) / 10
      : 0;

    return {
      ...summary,
      liquidity,
      retentionRate,
      conversionRate,
      totalUsers: totalUsers ?? 0,
    };
  });

// ─── List premium users (paginated) ───────────────────────────────────────────
export const listPremiumUsers = createServerFn({ method: "GET" })
  .validator((d: { page?: number; pageSize?: number }) => d)
  .handler(async ({ data }) => {
    await requireAdmin();
    const db   = getServerSupabase();
    const page = data.page ?? 0;
    const size = data.pageSize ?? 25;
    const from = page * size;
    const to   = from + size - 1;

    const { data: users, error, count } = await db
      .from("profiles")
      .select(`
        id, full_name, phone, kyc_status, premium, created_at,
        subscriptions!inner(plan, status, started_at, expires_at, amount_ngn),
        trust_scores(trust_score, trust_level)
      `, { count: "exact" })
      .eq("premium", true)
      .eq("subscriptions.plan", "premium")
      .eq("subscriptions.status", "active")
      .order("created_at", { ascending: false })
      .range(from, to)
      .catch(() => ({ data: null, error: null, count: 0 }));

    if (error) { console.error("[admin-premium]", error.message); throw new Error(error.message); }

    return { users: users ?? [], total: count ?? 0, page, pageSize: size };
  });

// ─── Revenue report by period ─────────────────────────────────────────────────
export const getPremiumRevenueReport = createServerFn({ method: "GET" })
  .validator((d: { days?: number }) => d)
  .handler(async ({ data }) => {
    await requireAdmin();
    const db   = getServerSupabase();
    const days = data.days ?? 30;
    const from = new Date(Date.now() - days * 86_400_000).toISOString();

    const { data: rows } = await db
      .from("premium_revenue_allocations")
      .select(`
        total_ngn, treasury_ngn, fraud_reserve_ngn,
        operations_ngn, infrastructure_ngn, growth_ngn, allocated_at
      `)
      .gte("allocated_at", from)
      .order("allocated_at", { ascending: false })
      .limit(500);

    type AllocRow = {
      total_ngn: number; treasury_ngn: number; fraud_reserve_ngn: number;
      operations_ngn: number; infrastructure_ngn: number; growth_ngn: number;
      allocated_at: string;
    };
    const all = (rows ?? []) as AllocRow[];
    const sum = (k: keyof AllocRow) =>
      all.reduce((s, r) => s + (Number(r[k]) || 0), 0);

    // Daily breakdown
    const dailyMap: Record<string, number> = {};
    for (const r of all) {
      const day = r.allocated_at.slice(0, 10);
      dailyMap[day] = (dailyMap[day] ?? 0) + r.total_ngn;
    }
    const daily = Object.entries(dailyMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, revenue]) => ({ date, revenue }));

    return {
      period:   `${days}d`,
      total:    sum("total_ngn"),
      treasury: sum("treasury_ngn"),
      fraud:    sum("fraud_reserve_ngn"),
      ops:      sum("operations_ngn"),
      infra:    sum("infrastructure_ngn"),
      growth:   sum("growth_ngn"),
      daily,
      count:    all.length,
    };
  });

// ─── Churn / retention analytics ──────────────────────────────────────────────
export const getPremiumChurnReport = createServerFn({ method: "GET" })
  .validator((d: Record<string, never>) => d)
  .handler(async () => {
    await requireAdmin();
    const db = getServerSupabase();

    const m1 = new Date(); m1.setDate(1); m1.setHours(0, 0, 0, 0);
    const m3 = new Date(m1); m3.setMonth(m1.getMonth() - 3);

    const [
      { count: activeNow },
      { count: newLast30 },
      { count: churnedLast30 },
      { count: newLast90 },
      { count: churnedLast90 },
    ] = await Promise.all([
      db.from("subscriptions").select("*", { count: "exact", head: true })
        .eq("plan", "premium").eq("status", "active"),
      db.from("subscriptions").select("*", { count: "exact", head: true })
        .eq("plan", "premium").eq("status", "active")
        .gte("started_at", m1.toISOString()),
      db.from("subscriptions").select("*", { count: "exact", head: true })
        .eq("plan", "premium").eq("status", "cancelled")
        .gte("cancelled_at", m1.toISOString()),
      db.from("subscriptions").select("*", { count: "exact", head: true })
        .eq("plan", "premium").eq("status", "active")
        .gte("started_at", m3.toISOString()),
      db.from("subscriptions").select("*", { count: "exact", head: true })
        .eq("plan", "premium").eq("status", "cancelled")
        .gte("cancelled_at", m3.toISOString()),
    ]);

    const churnRate30 = (newLast30 ?? 0) + (churnedLast30 ?? 0) > 0
      ? Math.round(((churnedLast30 ?? 0) / ((newLast30 ?? 0) + (churnedLast30 ?? 0))) * 100)
      : 0;

    return {
      activeNow:    activeNow     ?? 0,
      newLast30:    newLast30     ?? 0,
      churnedLast30: churnedLast30 ?? 0,
      churnRate30,
      newLast90:    newLast90     ?? 0,
      churnedLast90: churnedLast90 ?? 0,
    };
  });

// ─── Trust distribution of premium users ─────────────────────────────────────
export const getPremiumTrustDistribution = createServerFn({ method: "GET" })
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
          .eq("trust_level", level)
          .in(
            "user_id",
            db.from("profiles").select("id").eq("premium", true) as unknown as string[]
          )
          .catch(() => ({ count: 0 }));
        return { level, count: count ?? 0 };
      })
    );

    const total = results.reduce((s, r) => s + r.count, 0);
    return { breakdown: results, total };
  });
