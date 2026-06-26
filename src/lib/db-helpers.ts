// ─────────────────────────────────────────────────────────────────────────────
// Plain async DB helpers — no TanStack Start wrappers
// Import these anywhere: server functions, webhook handlers, admin scripts
// All functions accept a Supabase client so callers control auth context
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from "@supabase/supabase-js";
import { WalletService } from "./wallet-service";
import { DEFAULT_NGN_RATE } from "./constants";

// ─── ISO Week Key ─────────────────────────────────────────────────────────────
// Returns 'YYYY-Www' e.g. '2026-W26'. Used to de-duplicate weekly payouts.
function isoWeekKey(date: Date = new Date()): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// ─── Referral Commission ──────────────────────────────────────────────────────
// Business rule (updated):
//   • Referrer earns 5% of each qualifying trade's NGN value.
//   • Commission only unlocks once the referee has completed ≥7 successful
//     trades in the current calendar month. Trades 1–6 each month contribute
//     nothing to the referrer. Counter resets on the 1st of each month.
//   • No ₦500 cash bonus — the ₦500 is a separate weekly trade commission
//     paid to active traders every Thursday (see payWeeklyTradeCommissions).
//   • First-trade 100 XP bonus for BOTH parties is kept as UX motivation.
export async function creditReferrerCommissionFn(
  db: SupabaseClient,
  traderId: string,
  tradeId: string,
  tradeAmountNgn: number
): Promise<{ success: boolean; commissionNgn?: number; monthlyCount?: number; reason?: string }> {
  const { data: trader } = await db
    .from("profiles")
    .select("referred_by")
    .eq("id", traderId)
    .single();

  if (!trader?.referred_by) return { success: false, reason: "no_referrer" };

  const COMMISSION_RATE    = 0.05;
  const MONTHLY_THRESHOLD  = 7;        // unlock after 7 trades in a month
  const FIRST_TRADE_XP     = 100;      // XP bonus (no cash) for first trade

  // ── Monthly trade count for this referee (current calendar month) ──────────
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const { count: monthlyCount } = await db
    .from("trades")
    .select("id", { count: "exact", head: true })
    .eq("user_id", traderId)
    .in("status", ["paid", "completed"])
    .gte("created_at", monthStart.toISOString());

  const totalMonthlyTrades = monthlyCount ?? 0;

  // ── First-trade XP bonus (one-time, does NOT require threshold) ───────────
  const { count: prevAll } = await db
    .from("referral_commissions")
    .select("id", { count: "exact", head: true })
    .eq("referee_id", traderId);

  const isVeryFirstTrade = (prevAll ?? 0) === 0;

  if (isVeryFirstTrade) {
    // 100 XP for both referrer and referee — celebrate the first trade
    await Promise.all([
      db.rpc("award_trade_xp", { p_user_id: trader.referred_by, p_xp: FIRST_TRADE_XP }),
      db.rpc("award_trade_xp", { p_user_id: traderId,           p_xp: FIRST_TRADE_XP }),
    ]);

    const [{ data: referrerProfile }, { data: tradersProfile }] = await Promise.all([
      db.from("profiles").select("display_name").eq("id", trader.referred_by).single(),
      db.from("profiles").select("display_name").eq("id", traderId).single(),
    ]);
    const referrerMoniker = referrerProfile?.display_name ?? "a friend";
    const refereeMoniker  = tradersProfile?.display_name  ?? "your referral";

    await db.from("notifications").insert([
      {
        user_id: trader.referred_by,
        title:   "Referral Milestone! 🎉",
        message: `${refereeMoniker} just completed their first trade. +${FIRST_TRADE_XP} XP! They need 7 monthly trades to unlock your 5% commission.`,
        type:    "success",
      },
      {
        user_id: traderId,
        title:   "First Trade! 🎁",
        message: `+${FIRST_TRADE_XP} XP for your first trade! Make 7 trades this month to unlock your referrer's commission network.`,
        type:    "success",
      },
    ]);

    try {
      const { pushNotify } = await import("./onesignal");
      pushNotify(trader.referred_by, "Referral Milestone! 🎉",
        `${refereeMoniker} completed their first trade. +${FIRST_TRADE_XP} XP awarded!`,
        { type: "referral_milestone" }
      );
    } catch { /* non-critical */ }
  }

  // ── Commission gate: require ≥7 monthly trades ────────────────────────────
  if (totalMonthlyTrades < MONTHLY_THRESHOLD) {
    return {
      success:       false,
      reason:        "monthly_threshold_not_met",
      monthlyCount:  totalMonthlyTrades,
    };
  }

  // ── Commission is unlocked — pay 5% ───────────────────────────────────────
  const commissionNgn = Math.round(tradeAmountNgn * COMMISSION_RATE);
  if (commissionNgn <= 0) return { success: false, reason: "amount_too_small" };

  await WalletService.credit(db, { userId: trader.referred_by, currency: "NGN", amountNgn: commissionNgn, refType: "referral_commission", refId: tradeId, description: `5% referral commission from trade ${tradeId}`, idempotencyKey: `referral_commission:${tradeId}` });

  await db.from("referral_commissions").insert({
    referrer_id:     trader.referred_by,
    referee_id:      traderId,
    trade_id:        tradeId,
    amount_ngn:      commissionNgn,
    commission_rate: COMMISSION_RATE,
  });

  // Notify referrer (never expose referee's full name)
  const { data: refProfile } = await db
    .from("profiles")
    .select("display_name")
    .eq("id", traderId)
    .single();
  const refMoniker = refProfile?.display_name ?? "your referral";

  // Milestone notification when referee hits exactly 7 this month
  const hitThreshold = totalMonthlyTrades === MONTHLY_THRESHOLD;
  const notifMsg = hitThreshold
    ? `${refMoniker} just hit 7 trades this month — commission unlocked! ₦${commissionNgn.toLocaleString()} (5%) credited.`
    : `₦${commissionNgn.toLocaleString()} (5%) from ${refMoniker}'s trade this month.`;

  await db.from("notifications").insert({
    user_id: trader.referred_by,
    title:   hitThreshold ? "Commission Unlocked! 🔓💰" : "Commission Earned! 💰",
    message: notifMsg,
    type:    "success",
  });

  try {
    const { pushNotify } = await import("./onesignal");
    pushNotify(trader.referred_by,
      hitThreshold ? "Commission Unlocked! 🔓" : "Commission Earned! 💰",
      notifMsg,
      { type: "referral_commission" }
    );
  } catch { /* non-critical */ }

  return { success: true, commissionNgn, monthlyCount: totalMonthlyTrades };
}

// ─── Weekly Trade Commission Payout (₦500 every Thursday 7pm WAT) ────────────
// Business rule:
//   • Users who completed ≥1 trade worth ≥$25 (≥₦7,000) in the past 7 days
//     receive ₦500 credited to their wallet.
//   • Paid once per ISO week (YYYY-Www key) — duplicate inserts are blocked by
//     UNIQUE constraint on (user_id, week_key) in weekly_trade_commissions.
//   • Called from /api/cron/weekly-commission every Thursday at 18:00 UTC
//     (= 19:00 WAT = 7pm Nigerian Time).
export async function payWeeklyTradeCommissions(
  db: SupabaseClient
): Promise<{ paid: number; totalNgn: number; skipped: number }> {
  const COMMISSION_NGN  = 500;
  const MIN_TRADE_NGN   = 7_000;   // ₦7,000 minimum trade value
  const MIN_TRADE_USD   = 25;      // $25 minimum
  const weekKey         = isoWeekKey();

  // Look-back window: past 7 days
  const since = new Date();
  since.setDate(since.getDate() - 7);

  // Qualifying trades from the past week
  const { data: trades } = await db
    .from("trades")
    .select("user_id, amount_usd, amount_ngn")
    .in("status", ["paid", "completed"])
    .gte("created_at", since.toISOString())
    .gte("amount_ngn", MIN_TRADE_NGN);

  if (!trades?.length) return { paid: 0, totalNgn: 0, skipped: 0 };

  // Aggregate volume per user and check USD threshold
  const eligible = new Map<string, number>();
  for (const t of trades) {
    const usd = Number(t.amount_usd ?? 0);
    const ngn = Number(t.amount_ngn ?? 0);
    if (ngn < MIN_TRADE_NGN) continue;
    const prev = eligible.get(t.user_id) ?? 0;
    eligible.set(t.user_id, prev + usd);
  }

  // Filter to users meeting $25 threshold
  const userIds = [...eligible.entries()]
    .filter(([, usd]) => usd >= MIN_TRADE_USD)
    .map(([uid]) => uid);

  if (!userIds.length) return { paid: 0, totalNgn: 0, skipped: 0 };

  // Check which were already paid this week
  const { data: alreadyPaid } = await db
    .from("weekly_trade_commissions")
    .select("user_id")
    .eq("week_key", weekKey)
    .in("user_id", userIds);

  const paidSet = new Set((alreadyPaid ?? []).map((r) => r.user_id));
  const toPay   = userIds.filter((uid) => !paidSet.has(uid));

  if (!toPay.length) return { paid: 0, totalNgn: 0, skipped: userIds.length };

  let paid     = 0;
  let totalNgn = 0;
  let skipped  = userIds.length - toPay.length;

  for (const userId of toPay) {
    try {
      // Credit wallet via WalletService (centralised, idempotent)
      await WalletService.credit(db, { userId, currency: "NGN", amountNgn: COMMISSION_NGN, refType: "weekly_commission", description: `Weekly trade commission — ${weekKey}`, idempotencyKey: `weekly_commission:${weekKey}:${userId}` });

      // Record payment (UNIQUE constraint prevents double-pay)
      await db.from("weekly_trade_commissions").insert({
        user_id:    userId,
        week_key:   weekKey,
        amount_ngn: COMMISSION_NGN,
        paid_at:    new Date().toISOString(),
      });

      // In-app notification
      await db.from("notifications").insert({
        user_id: userId,
        title:   "Weekly Commission Paid! 💰",
        message: `₦${COMMISSION_NGN.toLocaleString()} weekly trade commission credited to your wallet for trading ₦7,000+ this week. Keep trading to earn every Thursday!`,
        type:    "success",
      });

      // OneSignal push (fire-and-forget)
      try {
        const { pushNotify } = await import("./onesignal");
        pushNotify(userId, "Weekly Commission Paid! 💰",
          `₦${COMMISSION_NGN.toLocaleString()} credited. Keep trading ₦7,000+ weekly to earn every Thursday!`,
          { type: "weekly_commission" }
        );
      } catch { /* non-critical */ }

      paid++;
      totalNgn += COMMISSION_NGN;
    } catch (err) {
      console.error("[WeeklyCommission] Failed to pay", userId, err);
      skipped++;
    }
  }

  return { paid, totalNgn, skipped };
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

  const premium     = !!profile?.premium;
  const kycVerified = profile?.kyc_status === "verified";

  let tier: TradeTier = "unverified";
  if (premium)          tier = "premium";
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
  const WEEKLY_THRESHOLD_NGN = 25 * DEFAULT_NGN_RATE;
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
  const MONTHLY_THRESHOLD_NGN = 50 * DEFAULT_NGN_RATE;
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
    allowed:             remaining > 0,
    unlimited:           false,
    remaining,
    dailyLimit:          FREE_DAILY_LIMIT,
    reason:              remaining > 0 ? "free_tier" : "limit_reached",
    weeklyNgn:           Math.round(weeklyNgn),
    monthlyNgn:          Math.round(monthlyNgn),
    weeklyThresholdNgn:  WEEKLY_THRESHOLD_NGN,
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
