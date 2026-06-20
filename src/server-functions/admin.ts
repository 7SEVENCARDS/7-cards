// ─────────────────────────────────────────────────────────────────────────────
// Admin Server Functions
// These must only be called by authenticated admin users.
// Protect them in the UI by checking profile.role === 'admin'.
//
// To make a user admin, run in Supabase SQL Editor:
//   UPDATE profiles SET role = 'admin' WHERE id = '<user-uuid>';
// ─────────────────────────────────────────────────────────────────────────────

import { createServerFn } from "@tanstack/react-start";
import { getServerSupabase } from "../lib/supabase.server";

// ─── Platform Stats ───────────────────────────────────────────────────────────
export const getAdminStats = createServerFn({ method: "GET" })
  .validator((d: { adminId: string }) => d)
  .handler(async ({ data }) => {
    const db = getServerSupabase();

    await assertAdmin(db, data.adminId);

    const now = new Date();
    const dayStart   = new Date(now); dayStart.setHours(0, 0, 0, 0);
    const weekStart  = new Date(now); weekStart.setDate(now.getDate() - now.getDay()); weekStart.setHours(0, 0, 0, 0);
    const monthStart = new Date(now); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);

    const [
      { count: totalUsers },
      { count: totalTrades },
      { data: volumeRows },
      { count: pendingKyc },
      { count: manualReview },
      { count: todayTrades },
    ] = await Promise.all([
      db.from("profiles").select("*", { count: "exact", head: true }),
      db.from("trades").select("*", { count: "exact", head: true }).eq("status", "paid"),
      db.from("trades").select("amount_ngn").eq("status", "paid").gte("settled_at", monthStart.toISOString()),
      db.from("profiles").select("*", { count: "exact", head: true }).eq("kyc_status", "submitted"),
      db.from("trades").select("*", { count: "exact", head: true }).eq("requires_manual_review", true).eq("status", "verified"),
      db.from("trades").select("*", { count: "exact", head: true }).gte("created_at", dayStart.toISOString()),
    ]);

    const monthlyVolumeNgn = (volumeRows ?? []).reduce((s, t) => s + Number(t.amount_ngn ?? 0), 0);

    return {
      totalUsers: totalUsers ?? 0,
      totalPaidTrades: totalTrades ?? 0,
      monthlyVolumeNgn: Math.round(monthlyVolumeNgn),
      pendingKycCount: pendingKyc ?? 0,
      manualReviewCount: manualReview ?? 0,
      todayTradeCount: todayTrades ?? 0,
    };
  });

// ─── Pending KYC Queue ────────────────────────────────────────────────────────
export const getKYCQueue = createServerFn({ method: "GET" })
  .validator((d: { adminId: string; limit?: number }) => d)
  .handler(async ({ data }) => {
    const db = getServerSupabase();
    await assertAdmin(db, data.adminId);

    const { data: profiles, error } = await db
      .from("profiles")
      .select("id, full_name, phone, kyc_status, kyc_bvn, kyc_nin, created_at")
      .eq("kyc_status", "submitted")
      .order("created_at", { ascending: true })
      .limit(data.limit ?? 50);

    if (error) throw error;
    return profiles ?? [];
  });

// ─── Approve KYC ─────────────────────────────────────────────────────────────
export const approveKYC = createServerFn({ method: "POST" })
  .validator((d: { adminId: string; userId: string; note?: string }) => d)
  .handler(async ({ data }) => {
    const db = getServerSupabase();
    await assertAdmin(db, data.adminId);

    await db.from("profiles")
      .update({ kyc_status: "verified" })
      .eq("id", data.userId);

    await db.from("notifications").insert({
      user_id: data.userId,
      title: "KYC Approved! ✅",
      message: data.note ?? "Your identity has been verified by our team. You can now trade without limits.",
      type: "success",
    });

    try {
      const { pushNotify } = await import("../lib/onesignal");
      pushNotify(data.userId, "KYC Approved! ✅", "Identity confirmed — start trading now.");
    } catch { /* non-critical */ }

    return { success: true };
  });

// ─── Reject KYC ──────────────────────────────────────────────────────────────
export const rejectKYC = createServerFn({ method: "POST" })
  .validator((d: { adminId: string; userId: string; reason: string }) => d)
  .handler(async ({ data }) => {
    const db = getServerSupabase();
    await assertAdmin(db, data.adminId);

    await db.from("profiles")
      .update({ kyc_status: "rejected" })
      .eq("id", data.userId);

    await db.from("notifications").insert({
      user_id: data.userId,
      title: "KYC Needs Attention",
      message: `Your KYC submission was not approved: ${data.reason}. Please re-submit with correct details.`,
      type: "error",
    });

    try {
      const { pushNotify } = await import("../lib/onesignal");
      pushNotify(data.userId, "KYC Needs Attention", data.reason);
    } catch { /* non-critical */ }

    return { success: true };
  });

// ─── Manual Review Queue (gift cards flagged for human check) ─────────────────
export const getManualReviewQueue = createServerFn({ method: "GET" })
  .validator((d: { adminId: string; limit?: number }) => d)
  .handler(async ({ data }) => {
    const db = getServerSupabase();
    await assertAdmin(db, data.adminId);

    const { data: trades, error } = await db
      .from("trades")
      .select(`
        id, brand, region, amount_usd, amount_ngn, card_code,
        reloadly_transaction_id, status, created_at,
        profiles!inner(id, full_name, phone, kyc_status)
      `)
      .eq("requires_manual_review", true)
      .eq("status", "verified")
      .order("created_at", { ascending: true })
      .limit(data.limit ?? 50);

    if (error) throw error;
    return trades ?? [];
  });

// ─── Approve Manual Trade (mark as ready for payout) ─────────────────────────
export const approveManualTrade = createServerFn({ method: "POST" })
  .validator((d: { adminId: string; tradeId: string }) => d)
  .handler(async ({ data }) => {
    const db = getServerSupabase();
    await assertAdmin(db, data.adminId);

    const { data: trade } = await db
      .from("trades")
      .select("user_id, amount_ngn")
      .eq("id", data.tradeId)
      .single();

    if (!trade) throw new Error("Trade not found");

    await db.from("trades")
      .update({ requires_manual_review: false })
      .eq("id", data.tradeId);

    await db.from("notifications").insert({
      user_id: trade.user_id,
      title: "Card Verified ✅",
      message: "Your gift card has been manually verified. Proceed to submit for payout.",
      type: "success",
    });

    try {
      const { pushNotify } = await import("../lib/onesignal");
      pushNotify(trade.user_id, "Card Verified ✅", "Your card is verified. Proceed to payout.");
    } catch { /* non-critical */ }

    return { success: true };
  });

// ─── Reject Manual Trade ──────────────────────────────────────────────────────
export const rejectManualTrade = createServerFn({ method: "POST" })
  .validator((d: { adminId: string; tradeId: string; reason: string }) => d)
  .handler(async ({ data }) => {
    const db = getServerSupabase();
    await assertAdmin(db, data.adminId);

    const { data: trade } = await db
      .from("trades")
      .select("user_id")
      .eq("id", data.tradeId)
      .single();

    if (!trade) throw new Error("Trade not found");

    await db.from("trades")
      .update({ status: "invalid", failure_reason: data.reason, requires_manual_review: false })
      .eq("id", data.tradeId);

    await db.from("notifications").insert({
      user_id: trade.user_id,
      title: "Card Rejected",
      message: `Your gift card was not accepted: ${data.reason}`,
      type: "error",
    });

    try {
      const { pushNotify } = await import("../lib/onesignal");
      pushNotify(trade.user_id, "Card Rejected", data.reason);
    } catch { /* non-critical */ }

    return { success: true };
  });

// ─── All Trades (paginated) ───────────────────────────────────────────────────
export const getAdminTrades = createServerFn({ method: "GET" })
  .validator((d: {
    adminId: string;
    page?: number;
    pageSize?: number;
    status?: string;
  }) => d)
  .handler(async ({ data }) => {
    const db = getServerSupabase();
    await assertAdmin(db, data.adminId);

    const page = data.page ?? 0;
    const size = data.pageSize ?? 25;
    const from = page * size;
    const to = from + size - 1;

    let query = db
      .from("trades")
      .select(`
        id, type, brand, amount_usd, amount_ngn, status, failure_reason,
        requires_manual_review, squadco_transaction_ref, settled_at, created_at,
        profiles!inner(id, full_name, phone)
      `, { count: "exact" })
      .order("created_at", { ascending: false })
      .range(from, to);

    if (data.status && data.status !== "all") query = query.eq("status", data.status);

    const { data: trades, error, count } = await query;
    if (error) throw error;
    return { trades: trades ?? [], total: count ?? 0, page, pageSize: size };
  });

// ─── Manual NGN Credit (emergency/dispute resolution) ────────────────────────
export const adminCreditWallet = createServerFn({ method: "POST" })
  .validator((d: {
    adminId: string;
    userId: string;
    amountNgn: number;
    reason: string;
  }) => d)
  .handler(async ({ data }) => {
    const db = getServerSupabase();
    await assertAdmin(db, data.adminId);

    if (data.amountNgn <= 0 || data.amountNgn > 5_000_000) {
      return { success: false, error: "Amount must be between ₦1 and ₦5,000,000" };
    }

    await db.rpc("increment_wallet_balance", {
      p_user_id: data.userId,
      p_currency: "NGN",
      p_amount: data.amountNgn,
    });

    await db.from("notifications").insert({
      user_id: data.userId,
      title: "Wallet Credited",
      message: `₦${data.amountNgn.toLocaleString()} has been credited to your wallet. Reason: ${data.reason}`,
      type: "success",
    });

    return { success: true };
  });

// ─── Get all gift card exchange rates ────────────────────────────────────────
export const getAdminRates = createServerFn({ method: "GET" })
  .validator((d: { adminId: string }) => d)
  .handler(async ({ data }) => {
    const db = getServerSupabase();
    await assertAdmin(db, data.adminId);

    const { data: rates, error } = await db
      .from("exchange_rates")
      .select("*")
      .eq("region", "USA")
      .order("brand");

    if (error) throw error;
    return rates ?? [];
  });

// ─── Update a single gift card rate ──────────────────────────────────────────
export const updateExchangeRate = createServerFn({ method: "POST" })
  .validator((d: {
    adminId: string;
    brand: string;
    region: string;
    ratePerDollar: number;
  }) => d)
  .handler(async ({ data }) => {
    const db = getServerSupabase();
    await assertAdmin(db, data.adminId);

    if (data.ratePerDollar < 100 || data.ratePerDollar > 10_000) {
      return { success: false, error: "Rate must be between ₦100 and ₦10,000 per dollar." };
    }

    // Compute trend vs previous rate
    const { data: prev } = await db
      .from("exchange_rates")
      .select("rate_per_dollar")
      .eq("brand", data.brand)
      .eq("region", data.region)
      .single();

    const prevRate = prev?.rate_per_dollar ? Number(prev.rate_per_dollar) : data.ratePerDollar;
    const changePct = prevRate > 0 ? ((data.ratePerDollar - prevRate) / prevRate) * 100 : 0;
    const trend = (changePct >= 0 ? "+" : "") + changePct.toFixed(1) + "%";

    const { error } = await db.from("exchange_rates").upsert(
      {
        brand: data.brand,
        region: data.region,
        rate_per_dollar: data.ratePerDollar,
        source: "admin",
        trend,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "brand,region" }
    );

    if (error) throw error;
    return { success: true, trend };
  });

// ─── Internal: assert admin role ─────────────────────────────────────────────
async function assertAdmin(db: ReturnType<typeof import("../lib/supabase.server")["getServerSupabase"]>, userId: string) {
  const { data } = await db
    .from("profiles")
    .select("role")
    .eq("id", userId)
    .single();

  if (data?.role !== "admin") {
    throw new Error("UNAUTHORIZED: Admin access required");
  }
}
