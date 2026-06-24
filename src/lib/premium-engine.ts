// ─────────────────────────────────────────────────────────────────────────────
// Premium Engine — Phase 15
//
// Strategic liquidity, trust-acceleration, and recurring-revenue engine.
// Transforms the ₦2,000/mo Premium subscription into:
//
//   1. Revenue Allocation
//      40% → Treasury Growth
//      20% → Fraud Reserve
//      20% → Operations
//      10% → Infrastructure
//      10% → Growth & Expansion
//
//   2. Trust Acceleration
//      Premium membership contributes +8 to trust score (no bypass of security).
//
//   3. Loyalty Milestones
//      30d / 90d / 180d / 365d — tracked and rewarded.
//
//   4. Premium Liquidity Fund
//      40% allocation pooled into premium_liquidity_pool for fast payouts.
//
// Premium NEVER bypasses: KYC, Fraud, Risk, Treasury, Compliance controls.
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from "@supabase/supabase-js";

export type PremiumType = "trader" | "vendor" | "franchise";

export const PREMIUM_PRICE_NGN = 2_000;

export interface RevenueAllocation {
  totalNgn:         number;
  treasuryNgn:      number;   // 40%
  fraudReserveNgn:  number;   // 20%
  operationsNgn:    number;   // 20%
  infrastructureNgn: number;  // 10%
  growthNgn:        number;   // 10%
}

export type MilestoneDays = 30 | 90 | 180 | 365;

export interface PremiumMilestone {
  days:      MilestoneDays;
  label:     string;
  achieved:  boolean;
  achievedAt: string | null;
  benefit:   string;
}

// ─── Revenue allocation ────────────────────────────────────────────────────────
export function computeRevenueAllocation(amountNgn: number = PREMIUM_PRICE_NGN): RevenueAllocation {
  return {
    totalNgn:          amountNgn,
    treasuryNgn:       Math.round(amountNgn * 0.40),
    fraudReserveNgn:   Math.round(amountNgn * 0.20),
    operationsNgn:     Math.round(amountNgn * 0.20),
    infrastructureNgn: Math.round(amountNgn * 0.10),
    growthNgn:         Math.round(amountNgn * 0.10),
  };
}

// ─── Record revenue allocation when a subscription activates ──────────────────
export async function recordPremiumRevenue(
  db: SupabaseClient,
  subscriptionId: string,
  userId: string,
  amountNgn: number = PREMIUM_PRICE_NGN
): Promise<void> {
  const alloc = computeRevenueAllocation(amountNgn);
  const now   = new Date().toISOString();

  try {
    await db.from("premium_revenue_allocations").insert({
      subscription_id:   subscriptionId,
      user_id:           userId,
      total_ngn:         alloc.totalNgn,
      treasury_ngn:      alloc.treasuryNgn,
      fraud_reserve_ngn: alloc.fraudReserveNgn,
      operations_ngn:    alloc.operationsNgn,
      infrastructure_ngn: alloc.infrastructureNgn,
      growth_ngn:        alloc.growthNgn,
      allocated_at:      now,
    });

    // Update premium liquidity pool (40% = treasury allocation)
    await db.rpc("increment_premium_liquidity_pool", {
      p_amount_ngn: alloc.treasuryNgn,
    }).catch(() => {
      // RPC may not exist yet — fall back to direct upsert
      return db.from("premium_liquidity_pool").upsert(
        { id: "singleton", balance_ngn: alloc.treasuryNgn, last_updated: now },
        { onConflict: "id", ignoreDuplicates: false }
      );
    });
  } catch (e) {
    console.warn("[PremiumEngine] Revenue allocation failed:", e instanceof Error ? e.message : e);
  }
}

// ─── Check and award loyalty milestones ───────────────────────────────────────
export async function checkAndAwardMilestones(
  db: SupabaseClient,
  userId: string,
  memberSinceIso: string
): Promise<PremiumMilestone[]> {
  const MILESTONES: { days: MilestoneDays; label: string; benefit: string }[] = [
    { days: 30,  label: "30-Day Member",  benefit: "+1 trust boost & Loyal badge"            },
    { days: 90,  label: "90-Day Member",  benefit: "+2 trust boost & Priority access unlock"  },
    { days: 180, label: "6-Month Member", benefit: "+3 trust boost & Higher treasury limit"   },
    { days: 365, label: "1-Year Member",  benefit: "+5 trust boost & Elite feature unlocks"   },
  ];

  const memberSince = new Date(memberSinceIso);
  const daysSince   = Math.floor((Date.now() - memberSince.getTime()) / 86_400_000);

  const { data: existing } = await db
    .from("premium_milestones")
    .select("milestone_days, achieved_at")
    .eq("user_id", userId);

  const existingSet = new Set((existing ?? []).map(m => m.milestone_days as number));

  const results: PremiumMilestone[] = [];

  for (const ms of MILESTONES) {
    const achieved = daysSince >= ms.days;
    let achievedAt: string | null = null;

    if (achieved) {
      achievedAt = existing?.find(m => m.milestone_days === ms.days)?.achieved_at ?? null;

      if (!achievedAt && !existingSet.has(ms.days)) {
        const at = new Date(memberSince.getTime() + ms.days * 86_400_000).toISOString();
        achievedAt = at;

        await db.from("premium_milestones").upsert({
          user_id:       userId,
          milestone_days: ms.days,
          milestone_label: ms.label,
          achieved_at:   at,
          benefit:       ms.benefit,
        }, { onConflict: "user_id,milestone_days" }).catch(() => {/* non-fatal */});

        // Notify user
        await db.from("notifications").insert({
          user_id: userId,
          title:   `🏆 ${ms.label} Milestone!`,
          message: `You've been Premium for ${ms.days} days. Bonus unlocked: ${ms.benefit}`,
          type:    "success",
        }).catch(() => {/* non-fatal */});
      }
    }

    results.push({ ...ms, achieved, achievedAt });
  }

  return results;
}

// ─── Trust acceleration bonus (called from TrustEngine) ───────────────────────
// Returns the premium trust bonus (0 if not premium, 5–13 if premium).
export async function getPremiumTrustBonus(
  userId: string,
  db: SupabaseClient
): Promise<{ bonus: number; reason: string; milestones: number }> {
  const { data: profile } = await db
    .from("profiles")
    .select("premium")
    .eq("id", userId)
    .single()
    .catch(() => ({ data: null }));

  if (!profile?.premium) return { bonus: 0, reason: "", milestones: 0 };

  const { data: sub } = await db
    .from("subscriptions")
    .select("started_at")
    .eq("user_id", userId)
    .eq("status", "active")
    .eq("plan", "premium")
    .order("started_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  const memberSince = sub?.started_at ? new Date(sub.started_at) : new Date();
  const daysSince   = Math.floor((Date.now() - memberSince.getTime()) / 86_400_000);

  // Base premium bonus + milestone bonuses
  let bonus = 5;   // base active premium
  let milestones = 0;
  if (daysSince >= 30)  { bonus += 1; milestones++; }
  if (daysSince >= 90)  { bonus += 2; milestones++; }
  if (daysSince >= 180) { bonus += 3; milestones++; }
  if (daysSince >= 365) { bonus += 5; milestones++; }

  return { bonus, reason: `Premium member (${daysSince}d)`, milestones };
}

// ─── Premium liquidity pool stats ─────────────────────────────────────────────
export async function getLiquidityPoolStats(db: SupabaseClient): Promise<{
  balanceNgn:     number;
  totalAllocated: number;
  lastUpdated:    string | null;
}> {
  const [poolRow, allocTotal] = await Promise.all([
    db.from("premium_liquidity_pool").select("balance_ngn, last_updated").eq("id", "singleton").maybeSingle(),
    db.from("premium_revenue_allocations").select("treasury_ngn"),
  ]);

  const total = ((allocTotal.data ?? []) as Array<{ treasury_ngn: number }>)
    .reduce((s, r) => s + (r.treasury_ngn ?? 0), 0);

  return {
    balanceNgn:     (poolRow.data as { balance_ngn?: number } | null)?.balance_ngn ?? 0,
    totalAllocated: total,
    lastUpdated:    (poolRow.data as { last_updated?: string } | null)?.last_updated ?? null,
  };
}

// ─── Admin summary for mission control ────────────────────────────────────────
export async function getPremiumSummary(db: SupabaseClient): Promise<{
  totalPremium:         number;
  monthlyRevenue:       number;
  treasuryAllocation:   number;
  fraudReserveAlloc:    number;
  operationsAlloc:      number;
  infrastructureAlloc:  number;
  growthAlloc:          number;
  churnedThisMonth:     number;
  newThisMonth:         number;
}> {
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const [
    { count: totalPremium },
    { count: newThisMonth },
    { count: churnedThisMonth },
    { data: revenueRows },
  ] = await Promise.all([
    db.from("profiles").select("*", { count: "exact", head: true }).eq("premium", true),
    db.from("subscriptions").select("*", { count: "exact", head: true })
      .eq("plan", "premium").eq("status", "active")
      .gte("started_at", monthStart.toISOString()),
    db.from("subscriptions").select("*", { count: "exact", head: true })
      .eq("plan", "premium").eq("status", "cancelled")
      .gte("cancelled_at", monthStart.toISOString()),
    db.from("premium_revenue_allocations")
      .select("total_ngn, treasury_ngn, fraud_reserve_ngn, operations_ngn, infrastructure_ngn, growth_ngn")
      .gte("allocated_at", monthStart.toISOString())
      .catch(() => ({ data: [] })),
  ]);

  type AllocRow = {
    total_ngn: number; treasury_ngn: number; fraud_reserve_ngn: number;
    operations_ngn: number; infrastructure_ngn: number; growth_ngn: number;
  };
  const rows = (revenueRows ?? []) as AllocRow[];
  const sum  = (k: keyof AllocRow) => rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);

  return {
    totalPremium:        totalPremium       ?? 0,
    monthlyRevenue:      sum("total_ngn"),
    treasuryAllocation:  sum("treasury_ngn"),
    fraudReserveAlloc:   sum("fraud_reserve_ngn"),
    operationsAlloc:     sum("operations_ngn"),
    infrastructureAlloc: sum("infrastructure_ngn"),
    growthAlloc:         sum("growth_ngn"),
    churnedThisMonth:    churnedThisMonth   ?? 0,
    newThisMonth:        newThisMonth       ?? 0,
  };
}
