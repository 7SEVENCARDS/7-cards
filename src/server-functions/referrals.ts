import { createServerFn } from "@tanstack/react-start";
import { getServerSupabase } from "../lib/supabase.server";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ReferredUser = {
  id: string;
  full_name: string | null;
  phone: string | null;
  created_at: string;
  has_traded: boolean;
  trade_count: number;
  total_commission_ngn: number; // lifetime commission earned from this referral
};

export type ReferralStats = {
  referralCode: string;
  totalReferred: number;
  totalEarnedNgn: number;      // lifetime NGN earned via referral commissions
  pendingCount: number;        // signed up, no trade yet
  earnedCount: number;         // have completed ≥1 trade
  friends: ReferredUser[];
};

// ─── Get referral stats for a user ───────────────────────────────────────────
export const getReferralStats = createServerFn({ method: "GET" })
  .validator((d: { userId: string }) => d)
  .handler(async ({ data }): Promise<ReferralStats> => {
    const db = getServerSupabase();

    const { data: profile } = await db
      .from("profiles")
      .select("referral_code")
      .eq("id", data.userId)
      .single();

    const { data: referred } = await db
      .from("profiles")
      .select("id, full_name, phone, created_at")
      .eq("referred_by", data.userId)
      .order("created_at", { ascending: false });

    if (!referred || referred.length === 0) {
      return {
        referralCode: profile?.referral_code ?? "",
        totalReferred: 0,
        totalEarnedNgn: 0,
        pendingCount: 0,
        earnedCount: 0,
        friends: [],
      };
    }

    const referredIds = referred.map((r) => r.id);

    // Get trade counts per referred user
    const { data: trades } = await db
      .from("trades")
      .select("user_id")
      .in("user_id", referredIds)
      .eq("status", "paid");

    const tradeCountMap = new Map<string, number>();
    for (const t of trades ?? []) {
      tradeCountMap.set(t.user_id, (tradeCountMap.get(t.user_id) ?? 0) + 1);
    }

    // Get commissions earned per referred user
    const { data: commissions } = await db
      .from("referral_commissions")
      .select("referrer_id, referee_id, amount_ngn")
      .eq("referrer_id", data.userId);

    const commissionByReferee = new Map<string, number>();
    let totalEarnedNgn = 0;
    for (const c of commissions ?? []) {
      commissionByReferee.set(c.referee_id, (commissionByReferee.get(c.referee_id) ?? 0) + c.amount_ngn);
      totalEarnedNgn += c.amount_ngn;
    }

    const friends: ReferredUser[] = referred.map((r) => ({
      id: r.id,
      full_name: r.full_name,
      phone: r.phone,
      created_at: r.created_at,
      has_traded: (tradeCountMap.get(r.id) ?? 0) > 0,
      trade_count: tradeCountMap.get(r.id) ?? 0,
      total_commission_ngn: commissionByReferee.get(r.id) ?? 0,
    }));

    const earnedCount  = friends.filter((f) => f.has_traded).length;
    const pendingCount = friends.length - earnedCount;

    return {
      referralCode: profile?.referral_code ?? "",
      totalReferred: friends.length,
      totalEarnedNgn: Math.round(totalEarnedNgn),
      pendingCount,
      earnedCount,
      friends,
    };
  });

// ─── Apply referral code (called when new user signs up) ─────────────────────
export const applyReferralCode = createServerFn({ method: "POST" })
  .validator((d: { userId: string; code: string }) => d)
  .handler(async ({ data }) => {
    const db = getServerSupabase();

    const { data: self } = await db
      .from("profiles")
      .select("referred_by, referral_code")
      .eq("id", data.userId)
      .single();

    if (self?.referred_by) {
      return { success: false, error: "You've already used a referral code." };
    }

    if (self?.referral_code === data.code.toUpperCase()) {
      return { success: false, error: "You can't use your own referral code." };
    }

    const { data: referrer } = await db
      .from("profiles")
      .select("id, full_name")
      .eq("referral_code", data.code.toUpperCase())
      .single();

    if (!referrer) {
      return { success: false, error: "Referral code not found. Check and try again." };
    }

    await db
      .from("profiles")
      .update({ referred_by: referrer.id })
      .eq("id", data.userId);

    await db.from("notifications").insert({
      user_id: referrer.id,
      title: "New Referral! 🎉",
      message: `Someone just signed up with your referral code. You'll earn 5% commission on every trade they complete!`,
      type: "success",
    });

    return { success: true, referrerName: referrer.full_name ?? "a friend" };
  });

// ─── Recurring referral commission (called after EVERY successful trade) ──────
// Business model:
//   Platform keeps 15% of trade value as operating margin.
//   5% of trade value is credited to the referrer from that margin.
//   Net platform margin = 10%.
//   This runs on every successful payout — not just the first trade —
//   to maximise referrer loyalty and word-of-mouth growth.
export const creditReferrerCommission = createServerFn({ method: "POST" })
  .validator((d: {
    traderId: string;
    tradeId: string;
    tradeAmountNgn: number;
  }) => d)
  .handler(async ({ data }) => {
    const db = getServerSupabase();
    const { creditReferrerCommissionFn } = await import("../lib/db-helpers");
    return creditReferrerCommissionFn(db, data.traderId, data.tradeId, data.tradeAmountNgn);
  });

// ─── Check verification allowance ────────────────────────────────────────────
// Free users: 3 verifications per day.
// Unlimited if: premium subscriber OR meets trade volume threshold
//   ($25+ in paid trades this week, or $50+ this month).
// The exchange rate is 1485 NGN/USD by default; we use NGN thresholds.
export const getVerificationAllowance = createServerFn({ method: "GET" })
  .validator((d: { userId: string }) => d)
  .handler(async ({ data }) => {
    const db = getServerSupabase();
    const { checkVerificationAllowance } = await import("../lib/db-helpers");
    return checkVerificationAllowance(db, data.userId);
  });

// ─── Record a verification usage ─────────────────────────────────────────────
export const recordVerificationUsage = createServerFn({ method: "POST" })
  .validator((d: { userId: string; tradeId: string }) => d)
  .handler(async ({ data }) => {
    const db = getServerSupabase();
    const { addVerificationUsage } = await import("../lib/db-helpers");
    await addVerificationUsage(db, data.userId, data.tradeId);
    return { success: true };
  });
