import { createServerFn } from "@tanstack/react-start";
import { getServerSupabase } from "../lib/supabase.server";
import { requireUser } from "../lib/auth-server";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ReferredUser = {
  display_name: string | null;
  joined_at: string;
  has_traded: boolean;
  trade_count: number;
  total_commission_ngn: number;
};

export type ReferralStats = {
  referralCode: string;
  totalReferred: number;
  totalEarnedNgn: number;
  pendingCount: number;
  earnedCount: number;
  friends: ReferredUser[];
};

// ─── Get own referral stats ───────────────────────────────────────────────────
// Note: raw user IDs and phone numbers are NOT returned in the friends list.
export const getReferralStats = createServerFn({ method: "GET" })
  .validator((d: { userId?: string }) => d)
  .handler(async (): Promise<ReferralStats> => {
    const userId = await requireUser();
    const db = getServerSupabase();

    const { data: profile } = await db
      .from("profiles")
      .select("referral_code")
      .eq("id", userId)
      .single();

    const { data: referred } = await db
      .from("profiles")
      .select("id, display_name, created_at")
      .eq("referred_by", userId)
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

    const { data: trades } = await db
      .from("trades")
      .select("user_id")
      .in("user_id", referredIds)
      .eq("status", "paid");

    const tradeCountMap = new Map<string, number>();
    for (const t of trades ?? []) {
      tradeCountMap.set(t.user_id, (tradeCountMap.get(t.user_id) ?? 0) + 1);
    }

    const { data: commissions } = await db
      .from("referral_commissions")
      .select("referee_id, amount_ngn")
      .eq("referrer_id", userId);

    const commissionByReferee = new Map<string, number>();
    let totalEarnedNgn = 0;
    for (const c of commissions ?? []) {
      commissionByReferee.set(c.referee_id, (commissionByReferee.get(c.referee_id) ?? 0) + c.amount_ngn);
      totalEarnedNgn += c.amount_ngn;
    }

    // Use cybermoniker (display_name) — never expose real name
    const friends: ReferredUser[] = referred.map((r) => ({
      display_name: (r as { display_name?: string | null }).display_name ?? "7Trader",
      joined_at: r.created_at,
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

// ─── Apply referral code ──────────────────────────────────────────────────────
export const applyReferralCode = createServerFn({ method: "POST" })
  .validator((d: { code: string }) => d)
  .handler(async ({ data }) => {
    const userId = await requireUser();
    const db = getServerSupabase();

    const { data: self } = await db
      .from("profiles")
      .select("referred_by, referral_code")
      .eq("id", userId)
      .single();

    if (self?.referred_by) {
      return { success: false, error: "You've already used a referral code." };
    }

    if (self?.referral_code === data.code.toUpperCase()) {
      return { success: false, error: "You can't use your own referral code." };
    }

    const { data: referrer } = await db
      .from("profiles")
      .select("id, display_name")
      .eq("referral_code", data.code.toUpperCase())
      .single();

    if (!referrer) {
      return { success: false, error: "Referral code not found. Check and try again." };
    }

    await db.from("profiles").update({ referred_by: referrer.id }).eq("id", userId);

    const referrerMoniker = (referrer as { display_name?: string | null }).display_name ?? "a friend";

    await db.from("notifications").insert([
      {
        user_id: referrer.id,
        title: "New Referral! 🎉",
        message: "Someone just joined with your code! When they complete 7 trades in a month, you'll start earning 5% commission on every trade they make.",
        type: "success",
      },
      {
        user_id: userId,
        title: "Referral Code Applied! 🔗",
        message: `You're now linked to ${referrerMoniker}. Complete 7 trades this month to unlock your referrer's 5% commission network. First trade earns you both +100 XP!`,
        type: "success",
      },
    ]);

    return { success: true, referrerName: referrerMoniker };
  });

// ─── Recurring referral commission ────────────────────────────────────────────
// Called internally after every successful payout. The session user must own
// the trade being credited — prevents cross-user commission injection.
export const creditReferrerCommission = createServerFn({ method: "POST" })
  .validator((d: { tradeId: string; tradeAmountNgn: number }) => d)
  .handler(async ({ data }) => {
    const userId = await requireUser();
    const db = getServerSupabase();

    // Verify the trade belongs to the session user
    const { data: trade } = await db
      .from("trades")
      .select("user_id")
      .eq("id", data.tradeId)
      .single();

    if (!trade || trade.user_id !== userId) {
      return { success: false, reason: "access_denied" };
    }

    const { creditReferrerCommissionFn } = await import("../lib/db-helpers");
    return creditReferrerCommissionFn(db, userId, data.tradeId, data.tradeAmountNgn);
  });

// ─── Check own verification allowance ────────────────────────────────────────
export const getVerificationAllowance = createServerFn({ method: "GET" })
  .validator((d: { userId?: string }) => d)
  .handler(async () => {
    const userId = await requireUser();
    const db = getServerSupabase();
    const { checkVerificationAllowance } = await import("../lib/db-helpers");
    return checkVerificationAllowance(db, userId);
  });

// ─── Record a verification usage ─────────────────────────────────────────────
export const recordVerificationUsage = createServerFn({ method: "POST" })
  .validator((d: { tradeId: string }) => d)
  .handler(async ({ data }) => {
    const userId = await requireUser();
    const db = getServerSupabase();
    const { addVerificationUsage } = await import("../lib/db-helpers");
    await addVerificationUsage(db, userId, data.tradeId);
    return { success: true };
  });
