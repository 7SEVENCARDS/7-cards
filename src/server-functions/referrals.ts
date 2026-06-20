import { createServerFn } from "@tanstack/react-start";
import { getServerSupabase } from "../lib/supabase.server";

export type ReferredUser = {
  id: string;
  full_name: string | null;
  phone: string | null;
  created_at: string;
  has_traded: boolean;   // true = ₦500 earned
};

export type ReferralStats = {
  referralCode: string;
  totalReferred: number;
  totalEarned: number;   // ₦500 × completed traders
  pendingCount: number;  // signed up but no trade yet
  earnedCount: number;   // completed ≥1 trade
  friends: ReferredUser[];
};

// ─── Get referral stats for a user ───────────────────────────────────────────
export const getReferralStats = createServerFn({ method: "GET" })
  .validator((d: { userId: string }) => d)
  .handler(async ({ data }): Promise<ReferralStats> => {
    const db = getServerSupabase();

    // Get own profile for referral code
    const { data: profile } = await db
      .from("profiles")
      .select("referral_code")
      .eq("id", data.userId)
      .single();

    // Get all users referred by this user
    const { data: referred } = await db
      .from("profiles")
      .select("id, full_name, phone, created_at")
      .eq("referred_by", data.userId)
      .order("created_at", { ascending: false });

    if (!referred || referred.length === 0) {
      return {
        referralCode: profile?.referral_code ?? "",
        totalReferred: 0,
        totalEarned: 0,
        pendingCount: 0,
        earnedCount: 0,
        friends: [],
      };
    }

    // Check which referred users have completed at least one successful trade
    const referredIds = referred.map((r) => r.id);
    const { data: traders } = await db
      .from("trades")
      .select("user_id")
      .in("user_id", referredIds)
      .eq("status", "paid");

    const tradersSet = new Set((traders ?? []).map((t) => t.user_id));

    const friends: ReferredUser[] = referred.map((r) => ({
      id: r.id,
      full_name: r.full_name,
      phone: r.phone,
      created_at: r.created_at,
      has_traded: tradersSet.has(r.id),
    }));

    const earnedCount  = friends.filter((f) => f.has_traded).length;
    const pendingCount = friends.length - earnedCount;

    return {
      referralCode: profile?.referral_code ?? "",
      totalReferred: friends.length,
      totalEarned: earnedCount * 500,
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

    // Check user hasn't already been referred
    const { data: self } = await db
      .from("profiles")
      .select("referred_by, referral_code")
      .eq("id", data.userId)
      .single();

    if (self?.referred_by) {
      return { success: false, error: "You've already used a referral code." };
    }

    // Can't use your own code
    if (self?.referral_code === data.code.toUpperCase()) {
      return { success: false, error: "You can't use your own referral code." };
    }

    // Find the referrer
    const { data: referrer } = await db
      .from("profiles")
      .select("id, full_name")
      .eq("referral_code", data.code.toUpperCase())
      .single();

    if (!referrer) {
      return { success: false, error: "Referral code not found. Check and try again." };
    }

    // Link the referral
    await db
      .from("profiles")
      .update({ referred_by: referrer.id })
      .eq("id", data.userId);

    // Notify referrer someone used their code
    await db.from("notifications").insert({
      user_id: referrer.id,
      title: "New Referral! 🎉",
      message: `Someone just signed up with your referral code. You'll earn ₦500 when they complete their first trade.`,
      type: "success",
    });

    return {
      success: true,
      referrerName: referrer.full_name ?? "a friend",
    };
  });

// ─── Credit referrer ₦500 (called server-side after first trade completes) ───
// This is called from trades.ts after a successful payout for a new user's
// first-ever completed trade.
export const creditReferrerBonus = createServerFn({ method: "POST" })
  .validator((d: { traderId: string }) => d)
  .handler(async ({ data }) => {
    const db = getServerSupabase();

    // Get trader's referrer
    const { data: trader } = await db
      .from("profiles")
      .select("referred_by, full_name")
      .eq("id", data.traderId)
      .single();

    if (!trader?.referred_by) return { success: false, reason: "no_referrer" };

    // Only credit on first completed trade
    const { count } = await db
      .from("trades")
      .select("id", { count: "exact", head: true })
      .eq("user_id", data.traderId)
      .eq("status", "paid");

    if ((count ?? 0) > 1) return { success: false, reason: "not_first_trade" };

    const BONUS = 500;

    // Credit ₦500 to referrer's NGN wallet
    const { data: wallet } = await db
      .from("wallets")
      .select("id, balance")
      .eq("user_id", trader.referred_by)
      .eq("currency", "NGN")
      .single();

    if (!wallet) return { success: false, reason: "wallet_not_found" };

    await db
      .from("wallets")
      .update({ balance: (wallet.balance ?? 0) + BONUS })
      .eq("id", wallet.id);

    // Notify referrer
    await db.from("notifications").insert({
      user_id: trader.referred_by,
      title: "₦500 Referral Bonus Earned! 💰",
      message: `${trader.full_name ?? "Your referral"} just completed their first trade. ₦500 has been credited to your NGN wallet.`,
      type: "success",
    });

    // Notify the new trader too
    await db.from("notifications").insert({
      user_id: data.traderId,
      title: "Welcome bonus delivered 🎁",
      message: "Your referrer just earned their ₦500 bonus — thanks for using their code!",
      type: "info",
    });

    return { success: true, bonusAmount: BONUS };
  });
