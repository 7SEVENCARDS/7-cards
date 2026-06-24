// ─────────────────────────────────────────────────────────────────────────────
// Premium Analytics — user-facing analytics for Premium members
//
// Returns a full analytics payload in one request:
//   - Trust score + signal breakdown
//   - Trade performance (volume, count, success rate, daily bars)
//   - Referral earnings
//   - Loyalty milestone status
//   - Rate history snapshot
//   - Premium benefit usage summary
// ─────────────────────────────────────────────────────────────────────────────

import { createServerFn }    from "@tanstack/react-start";
import { getServerSupabase } from "../lib/supabase.server";
import { requireUser }       from "../lib/auth-server";
import { checkAndAwardMilestones } from "../lib/premium-engine";

// ─── Full analytics payload ───────────────────────────────────────────────────
export const getPremiumAnalytics = createServerFn({ method: "GET" })
  .validator((d: Record<string, never>) => d)
  .handler(async () => {
    const userId = await requireUser();
    const db     = getServerSupabase();

    // Fetch everything in parallel
    const [
      trustRow,
      tradesResult,
      referralResult,
      milestonesResult,
      ratesResult,
      subResult,
    ] = await Promise.all([
      // Trust score
      db.from("trust_scores")
        .select("trust_score, trust_level, trust_reason, breakdown, computed_at")
        .eq("user_id", userId)
        .maybeSingle(),

      // Trade stats (last 90 days)
      db.from("trades")
        .select("id, status, amount_usd, payout_ngn, created_at, brand")
        .eq("user_id", userId)
        .gte("created_at", new Date(Date.now() - 90 * 86_400_000).toISOString())
        .order("created_at", { ascending: false })
        .limit(500),

      // Referral commissions
      db.from("referral_commissions")
        .select("amount, currency, status, created_at")
        .eq("referrer_id", userId)
        .order("created_at", { ascending: false })
        .limit(200),

      // Premium milestones
      db.from("premium_milestones")
        .select("milestone_days, milestone_label, achieved_at, benefit")
        .eq("user_id", userId)
        .order("milestone_days", { ascending: true }),

      // Recent exchange rates (last 7 days, sampled)
      db.from("exchange_rates")
        .select("brand, rate_ngn_per_usd, updated_at")
        .order("updated_at", { ascending: false })
        .limit(50)
        .catch(() => ({ data: null })),

      // Subscription (for member since + type)
      db.from("subscriptions")
        .select("started_at, expires_at, plan, premium_type, amount_ngn")
        .eq("user_id", userId)
        .eq("plan", "premium")
        .eq("status", "active")
        .order("started_at", { ascending: true })
        .limit(1)
        .maybeSingle(),
    ]);

    // Check/award milestones if member
    if (subResult.data?.started_at) {
      await checkAndAwardMilestones(db, userId, subResult.data.started_at).catch(() => {});
    }

    // ── Trade analytics ──────────────────────────────────────────────────────
    const trades = tradesResult.data ?? [];
    const paidTrades     = trades.filter(t => t.status === "paid");
    const totalTrades    = trades.length;
    const successfulTrades = paidTrades.length;
    const successRate    = totalTrades > 0 ? Math.round((successfulTrades / totalTrades) * 100) : 0;
    const totalVolumeUsd = paidTrades.reduce((s, t) => s + (Number(t.amount_usd) || 0), 0);
    const totalPayoutNgn = paidTrades.reduce((s, t) => s + (Number(t.payout_ngn) || 0), 0);

    // Daily breakdown (last 30 days)
    const dailyMap: Record<string, { count: number; volumeUsd: number; payoutNgn: number }> = {};
    const thirtyDaysAgo = Date.now() - 30 * 86_400_000;
    for (const t of paidTrades) {
      if (new Date(t.created_at).getTime() < thirtyDaysAgo) continue;
      const day = t.created_at.slice(0, 10);
      if (!dailyMap[day]) dailyMap[day] = { count: 0, volumeUsd: 0, payoutNgn: 0 };
      dailyMap[day].count++;
      dailyMap[day].volumeUsd += Number(t.amount_usd) || 0;
      dailyMap[day].payoutNgn += Number(t.payout_ngn) || 0;
    }
    const dailyTrades = Object.entries(dailyMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, v]) => ({ date, ...v }));

    // Brand breakdown
    const brandMap: Record<string, number> = {};
    for (const t of paidTrades) {
      if (t.brand) brandMap[t.brand] = (brandMap[t.brand] ?? 0) + 1;
    }
    const topBrands = Object.entries(brandMap)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([brand, count]) => ({ brand, count }));

    // ── Referral analytics ────────────────────────────────────────────────────
    const commissions   = referralResult.data ?? [];
    const totalEarned   = commissions
      .filter(c => c.status === "paid" && c.currency === "NGN")
      .reduce((s, c) => s + (Number(c.amount) || 0), 0);
    const pendingEarned = commissions
      .filter(c => c.status === "pending" && c.currency === "NGN")
      .reduce((s, c) => s + (Number(c.amount) || 0), 0);

    // ── Milestone status ──────────────────────────────────────────────────────
    const MILESTONE_DEFS: { days: number; label: string; benefit: string }[] = [
      { days: 30,  label: "30-Day Member",  benefit: "+1 trust boost & Loyal badge"            },
      { days: 90,  label: "90-Day Member",  benefit: "+2 trust boost & Priority access unlock" },
      { days: 180, label: "6-Month Member", benefit: "+3 trust boost & Higher treasury limit"  },
      { days: 365, label: "1-Year Member",  benefit: "+5 trust boost & Elite feature unlocks"  },
    ];

    const achievedSet = new Set((milestonesResult.data ?? []).map(m => m.milestone_days));
    const memberSince = subResult.data?.started_at ? new Date(subResult.data.started_at) : null;
    const daysSince   = memberSince ? Math.floor((Date.now() - memberSince.getTime()) / 86_400_000) : 0;

    const milestones = MILESTONE_DEFS.map(m => ({
      ...m,
      achieved:   achievedSet.has(m.days) || daysSince >= m.days,
      achievedAt: (milestonesResult.data ?? []).find(r => r.milestone_days === m.days)?.achieved_at ?? null,
      daysLeft:   Math.max(0, m.days - daysSince),
      progress:   Math.min(100, Math.round((daysSince / m.days) * 100)),
    }));

    // ── Rate history ──────────────────────────────────────────────────────────
    const rateHistory = (ratesResult.data ?? [])
      .map(r => ({ brand: r.brand, rate: Number(r.rate_ngn_per_usd), updatedAt: r.updated_at }))
      .slice(0, 20);

    // ── Premium trust bonus from breakdown ────────────────────────────────────
    const breakdown = trustRow.data?.breakdown as Record<string, number> | null;
    const premiumTrustBonus = breakdown?.premiumMember ?? 0;

    return {
      trust: {
        score:       trustRow.data?.trust_score ?? 0,
        level:       trustRow.data?.trust_level ?? "New",
        reason:      trustRow.data?.trust_reason ?? "",
        breakdown:   breakdown ?? {},
        computedAt:  trustRow.data?.computed_at ?? null,
        premiumBonus: premiumTrustBonus,
      },
      trades: {
        total:         totalTrades,
        successful:    successfulTrades,
        successRate,
        totalVolumeUsd: Math.round(totalVolumeUsd * 100) / 100,
        totalPayoutNgn: Math.round(totalPayoutNgn),
        daily:         dailyTrades,
        topBrands,
      },
      referrals: {
        totalEarned:   Math.round(totalEarned),
        pendingEarned: Math.round(pendingEarned),
        count:         commissions.length,
      },
      milestones,
      daysSince,
      memberSince:   subResult.data?.started_at ?? null,
      expiresAt:     subResult.data?.expires_at ?? null,
      premiumType:   subResult.data?.premium_type ?? "trader",
      rateHistory,
    };
  });
