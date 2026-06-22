// ─────────────────────────────────────────────────────────────────────────────
// Plain async DB helpers — no TanStack Start wrappers
// Import these anywhere: server functions, webhook handlers, admin scripts
// All functions accept a Supabase client so callers control auth context
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from "@supabase/supabase-js";

// ─── Referral Commission ──────────────────────────────────────────────────────
// Awards 5% of the trade's NGN value to the referrer.
// On the referee's FIRST completed trade, both referrer and referee also
// receive a ₦500 welcome bonus.
// Platform model: 15% margin kept; 5% to referrer; net = 10%.
export async function creditReferrerCommissionFn(
  db: SupabaseClient,
  traderId: string,
  tradeId: string,
  tradeAmountNgn: number
): Promise<{ success: boolean; commissionNgn?: number; bonusAwarded?: boolean; reason?: string }> {
  const { data: trader } = await db
    .from("profiles")
    .select("referred_by, full_name")
    .eq("id", traderId)
    .single();

  if (!trader?.referred_by) return { success: false, reason: "no_referrer" };

  const COMMISSION_RATE = 0.05;
  const commissionNgn = Math.round(tradeAmountNgn * COMMISSION_RATE);
  if (commissionNgn <= 0) return { success: false, reason: "amount_too_small" };

  // Check whether this is the referee's first completed trade
  // (count existing commissions BEFORE inserting the new one)
  const { count: prevCommissions } = await db
    .from("referral_commissions")
    .select("id", { count: "exact", head: true })
    .eq("referee_id", traderId);

  const isFirstTrade = (prevCommissions ?? 0) === 0;

  // Credit 5% commission to referrer's wallet
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

  // ── First-trade ₦500 + 100 XP bonus for both parties ───────────────────
  if (isFirstTrade) {
    const BONUS_NGN = 500;
    const BONUS_XP  = 100;

    // Credit ₦500 to referrer
    await db.rpc("increment_wallet_balance", {
      p_user_id: trader.referred_by,
      p_currency: "NGN",
      p_amount: BONUS_NGN,
    });

    // Credit ₦500 to referee (the new user)
    await db.rpc("increment_wallet_balance", {
      p_user_id: traderId,
      p_currency: "NGN",
      p_amount: BONUS_NGN,
    });

    // Award 100 XP to referrer
    await db.rpc("award_trade_xp", { p_user_id: trader.referred_by, p_xp: BONUS_XP });

    // Award 100 XP to referee
    await db.rpc("award_trade_xp", { p_user_id: traderId, p_xp: BONUS_XP });

    // Fetch referrer display_name for notification (never expose full_name)
    const { data: referrerProfile } = await db
      .from("profiles")
      .select("display_name")
      .eq("id", trader.referred_by)
      .single();
    const referrerMoniker = referrerProfile?.display_name ?? "a friend";

    // Fetch referee display_name for referrer notification
    const { data: tradersProfile } = await db
      .from("profiles")
      .select("display_name")
      .eq("id", traderId)
      .single();
    const refereeMoniker = tradersProfile?.display_name ?? "your referral";

    // Notify both users
    await db.from("notifications").insert([
      {
        user_id: trader.referred_by,
        title: "Referral Bonus Unlocked! 🎉",
        message: `₦500 + 100 XP bonus credited! ${refereeMoniker} just completed their first trade. Plus ₦${commissionNgn.toLocaleString()} (5%) commission.`,
        type: "success",
      },
      {
        user_id: traderId,
        title: "Welcome Bonus! 🎁",
        message: `₦500 + 100 XP bonus credited for completing your first trade on 7SEVEN CARDS! Your referrer ${referrerMoniker} also earned their bonus.`,
        type: "success",
      },
    ]);

    // OneSignal pushes (fire-and-forget)
    try {
      const { pushNotify } = await import("./onesignal");
      pushNotify(trader.referred_by, "Referral Bonus Unlocked! 🎉",
        `₦500 bonus + ₦${commissionNgn.toLocaleString()} commission from your referral's first trade.`,
        { type: "referral_bonus" }
      );
      pushNotify(traderId, "Welcome Bonus! 🎁",
        "₦500 credited to your wallet for your first trade. Keep trading to earn more!",
        { type: "first_trade_bonus" }
      );
    } catch { /* non-critical */ }

    return { success: true, commissionNgn, bonusAwarded: true };
  }

  // Standard commission notification (not first trade)
  // Fetch referee display_name — never expose full_name publicly
  const { data: refProfile } = await db
    .from("profiles")
    .select("display_name")
    .eq("id", traderId)
    .single();
  const refMoniker = refProfile?.display_name ?? "your referral";

  await db.from("notifications").insert({
    user_id: trader.referred_by,
    title: "Commission Earned! 💰",
    message: `₦${commissionNgn.toLocaleString()} (5%) commission from ${refMoniker}'s trade.`,
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

  return { success: true, commissionNgn, bonusAwarded: false };
}

// ─── Trade Tier ───────────────────────────────────────────────────────────────
export type TradeTier = "unverified" | "email_verified" | "kyc_verified" | "premium";

export const TRADE_TIER_LIMITS: Record<TradeTier, { perTradeLimitUsd: number; dailyVerifLimit: number | null; label: string }> = {
  unverified:    { perTradeLimitUsd: 200,    dailyVerifLimit: 3,    label: "Unverified" },
  email_verified:{ perTradeLimitUsd: 500,    dailyVerifLimit: null, label: "Email Verified" },
  kyc_verified:  { perTradeLimitUsd: 5_000,  dailyVerifLimit: null, label: "KYC Verified" },
  premium:       { perTradeLimitUsd: 10_000, dailyVerifLimit: null, label: "Premium" },
};

export async function getUserTradeTier(
  db: SupabaseClient,
  userId: string
): Promise<{ tier: TradeTier; emailVerified: boolean; kycVerified: boolean; premium: boolean }> {
  const { data: profile } = await db
    .from("profiles")
    .select("premium, kyc_status")
    .eq("id", userId)
    .single();

  let emailVerified = false;
  try {
    const { data: authUser } = await (db.auth as { admin?: { getUserById: (id: string) => Promise<{ data: { user: { email_confirmed_at?: string | null } | null } }> } }).admin?.getUserById(userId) ?? { data: { user: null } };
    emailVerified = !!authUser?.user?.email_confirmed_at;
  } catch { /* non-critical — treat as unverified */ }

  const premium    = !!profile?.premium;
  const kycVerified = profile?.kyc_status === "verified";

  let tier: TradeTier = "unverified";
  if (premium)      tier = "premium";
  else if (kycVerified) tier = "kyc_verified";
  else if (emailVerified) tier = "email_verified";

  return { tier, emailVerified, kycVerified, premium };
}

// ─── Verification Allowance ───────────────────────────────────────────────────
// Unverified email: 3 verifications/day.
// Email-verified, KYC-verified, Premium, or $25+/week, $50+/month: unlimited.
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
  tier?: TradeTier;
};

export async function checkVerificationAllowance(
  db: SupabaseClient,
  userId: string
): Promise<VerificationAllowance> {
  const { data: profile } = await db
    .from("profiles")
    .select("premium, kyc_status")
    .eq("id", userId)
    .single();

  if (profile?.premium) {
    return { allowed: true, unlimited: true, reason: "premium", tier: "premium" };
  }

  if (profile?.kyc_status === "verified") {
    return { allowed: true, unlimited: true, reason: "kyc_verified", tier: "kyc_verified" };
  }

  // Check email verification — email-verified users get unlimited verifications
  let emailVerified = false;
  try {
    const { data: authUser } = await (db.auth as { admin?: { getUserById: (id: string) => Promise<{ data: { user: { email_confirmed_at?: string | null } | null } }> } }).admin?.getUserById(userId) ?? { data: { user: null } };
    emailVerified = !!authUser?.user?.email_confirmed_at;
  } catch { /* non-critical */ }

  if (emailVerified) {
    return { allowed: true, unlimited: true, reason: "email_verified", tier: "email_verified" };
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
