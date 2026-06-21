// ─────────────────────────────────────────────────────────────────────────────
// Plain async DB helpers — no TanStack Start wrappers
// Import these anywhere: server functions, webhook handlers, admin scripts
// All functions accept a Supabase client so callers control auth context
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from "@supabase/supabase-js";

// ─── Referral Commission ──────────────────────────────────────────────────────
// Awards 5% of the trade's NGN value to the referrer.
// Platform model: 15% margin kept; 5% to referrer; net = 10%.
export async function creditReferrerCommissionFn(
  db: SupabaseClient,
  traderId: string,
  tradeId: string,
  tradeAmountNgn: number
): Promise<{ success: boolean; commissionNgn?: number; reason?: string }> {
  const { data: trader } = await db
    .from("profiles")
    .select("referred_by, full_name")
    .eq("id", traderId)
    .single();

  if (!trader?.referred_by) return { success: false, reason: "no_referrer" };

  const COMMISSION_RATE = 0.05;
  const commissionNgn = Math.round(tradeAmountNgn * COMMISSION_RATE);
  if (commissionNgn <= 0) return { success: false, reason: "amount_too_small" };

  await db.rpc("increment_wallet_balance", {
    p_user_id: trader.referred_by,
    p_currency: "NGN",
    p_amount: commissionNgn,
  });

  await db.from("referral_commissions").insert({
    referrer_id: trader.referred_by,
    referee_id: traderId,
    trade_id: tradeId,
    amount_ngn: commissionNgn,
    commission_rate: COMMISSION_RATE,
  });

  await db.from("notifications").insert({
    user_id: trader.referred_by,
    title: "Commission Earned! 💰",
    message: `₦${commissionNgn.toLocaleString()} (5%) commission from ${trader.full_name ?? "your referral"}'s trade.`,
    type: "success",
  });

  // OneSignal push to referrer (fire-and-forget)
  try {
    const { pushNotify } = await import("./onesignal");
    pushNotify(trader.referred_by, "Commission Earned! 💰",
      `₦${commissionNgn.toLocaleString()} from your referral's trade.`,
      { type: "referral_commission" }
    );
  } catch { /* non-critical */ }

  return { success: true, commissionNgn };
}

// ─── Verification Allowance ───────────────────────────────────────────────────
// Free users: 3 verifications/day.
// Unlimited if: premium OR $25+/week OR $50+/month in paid trades.
export type VerificationAllowance = {
  allowed: boolean;
  unlimited: boolean;
  remaining?: number;
  dailyLimit?: number;
  reason: string;
  weeklyNgn?: number;
  monthlyNgn?: number;
  weeklyThresholdNgn?: number;
  monthlyThresholdNgn?: number;
};

export async function checkVerificationAllowance(
  db: SupabaseClient,
  userId: string
): Promise<VerificationAllowance> {
  const { data: profile } = await db
    .from("profiles")
    .select("premium")
    .eq("id", userId)
    .single();

  if (profile?.premium) {
    return { allowed: true, unlimited: true, reason: "premium" };
  }

  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  weekStart.setHours(0, 0, 0, 0);

  const { data: weeklyTrades } = await db
    .from("trades")
    .select("amount_ngn")
    .eq("user_id", userId)
    .eq("status", "paid")
    .gte("settled_at", weekStart.toISOString());

  const weeklyNgn = (weeklyTrades ?? []).reduce((s, t) => s + Number(t.amount_ngn ?? 0), 0);
  const WEEKLY_THRESHOLD_NGN = 25 * 1485;
  if (weeklyNgn >= WEEKLY_THRESHOLD_NGN) {
    return { allowed: true, unlimited: true, reason: "weekly_volume", weeklyNgn };
  }

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const { data: monthlyTrades } = await db
    .from("trades")
    .select("amount_ngn")
    .eq("user_id", userId)
    .eq("status", "paid")
    .gte("settled_at", monthStart.toISOString());

  const monthlyNgn = (monthlyTrades ?? []).reduce((s, t) => s + Number(t.amount_ngn ?? 0), 0);
  const MONTHLY_THRESHOLD_NGN = 50 * 1485;
  if (monthlyNgn >= MONTHLY_THRESHOLD_NGN) {
    return { allowed: true, unlimited: true, reason: "monthly_volume", monthlyNgn };
  }

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const { count: usedToday } = await db
    .from("verification_usage")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("created_at", todayStart.toISOString());

  const FREE_DAILY_LIMIT = 3;
  const remaining = Math.max(0, FREE_DAILY_LIMIT - (usedToday ?? 0));

  return {
    allowed: remaining > 0,
    unlimited: false,
    remaining,
    dailyLimit: FREE_DAILY_LIMIT,
    reason: remaining > 0 ? "free_tier" : "limit_reached",
    weeklyNgn: Math.round(weeklyNgn),
    monthlyNgn: Math.round(monthlyNgn),
    weeklyThresholdNgn: WEEKLY_THRESHOLD_NGN,
    monthlyThresholdNgn: MONTHLY_THRESHOLD_NGN,
  };
}

// ─── Record Verification Usage ────────────────────────────────────────────────
export async function addVerificationUsage(
  db: SupabaseClient,
  userId: string,
  tradeId: string
): Promise<void> {
  await db.from("verification_usage").insert({ user_id: userId, trade_id: tradeId });
}
