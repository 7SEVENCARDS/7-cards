import { createServerFn } from "@tanstack/react-start";
import { getServerSupabase } from "../lib/supabase.server";

// ─── Get user's trade history ─────────────────────────────────────────────────
export const getUserTrades = createServerFn({ method: "GET" })
  .validator((d: { userId: string; limit?: number }) => d)
  .handler(async ({ data }) => {
    try {
      const db = getServerSupabase();
      const { data: trades, error } = await db
        .from("trades")
        .select("*")
        .eq("user_id", data.userId)
        .order("created_at", { ascending: false })
        .limit(data.limit ?? 10);

      if (error) throw error;
      return trades ?? [];
    } catch {
      return [];
    }
  });

// ─── Create a new trade ───────────────────────────────────────────────────────
export const createTrade = createServerFn({ method: "POST" })
  .validator((d: {
    userId: string;
    type: "gift_card" | "crypto";
    brand: string;
    amountUsd: number;
    exchangeRate: number;
  }) => d)
  .handler(async ({ data }) => {
    const db = getServerSupabase();

    // ── KYC gate: user must have submitted KYC before trading ────────────────
    const { data: profile } = await db
      .from("profiles")
      .select("kyc_status")
      .eq("id", data.userId)
      .single();

    if (!profile || profile.kyc_status === "pending") {
      throw new Error("KYC_REQUIRED: Please complete identity verification before trading.");
    }

    const amountNgn = Math.round(data.amountUsd * data.exchangeRate);

    const { data: trade, error } = await db
      .from("trades")
      .insert({
        user_id: data.userId,
        type: data.type,
        brand: data.brand,
        amount_usd: data.amountUsd,
        amount_ngn: amountNgn,
        exchange_rate: data.exchangeRate,
        status: "pending",
      })
      .select()
      .single();

    if (error) throw error;
    return trade;
  });

// ─── Verify gift card via Reloadly ────────────────────────────────────────────
// Reloadly is used to verify the validity of the user's submitted gift card.
// We check the card against Reloadly's redeem-codes endpoint; if that endpoint
// isn't available on the current tier, we flag for manual operator review —
// standard practice for Nigerian gift card trading platforms.
//
// Rate limiting (free users):
//   - 3 verifications per day for free accounts (Reloadly API billing protection)
//   - Unlimited for: premium subscribers, or users with $25+/week or $50+/month
//     in successful paid trades.
export const verifyGiftCard = createServerFn({ method: "POST" })
  .validator((d: {
    tradeId: string;
    userId: string;
    cardCode: string;
    cardPin?: string;
    brand: string;
    amountUsd: number;
  }) => d)
  .handler(async ({ data }) => {
    const db = getServerSupabase();

    // ── Verification allowance check ─────────────────────────────────────────
    const { checkVerificationAllowance, addVerificationUsage } = await import("../lib/db-helpers");

    const allowance = await checkVerificationAllowance(db, data.userId);

    if (!allowance.allowed) {
      await db.from("trades").update({
        status: "failed",
        failure_reason: "DAILY_LIMIT_REACHED",
      }).eq("id", data.tradeId);

      return {
        success: false,
        limitReached: true,
        reason: `You've used your 3 free daily verifications. Trade $25+ this week or $50+ this month for unlimited access, or upgrade to Premium.`,
        allowance,
      };
    }

    // Mark trade as scanning
    await db.from("trades").update({ status: "scanning" }).eq("id", data.tradeId);

    // Record this verification attempt (for free-tier users; ignored for unlimited)
    if (!allowance.unlimited) {
      try {
        await addVerificationUsage(db, data.userId, data.tradeId);
      } catch { /* non-critical */ }
    }

    try {
      const { verifyUserGiftCard } = await import("../lib/reloadly");

      const result = await verifyUserGiftCard({
        brand: data.brand,
        cardCode: data.cardCode,
        cardPin: data.cardPin,
        amountUsd: data.amountUsd,
      });

      if (result.success) {
        await db.from("trades").update({
          status: "verified",
          card_code: result.cardCode,
          requires_manual_review: result.requiresManualReview ?? false,
          reloadly_transaction_id: result.productId ? String(result.productId) : null,
        }).eq("id", data.tradeId);

        return {
          success: true,
          tradeId: data.tradeId,
          requiresManualReview: result.requiresManualReview,
          allowance,
        };
      } else {
        await db.from("trades").update({
          status: "invalid",
          failure_reason: result.failureReason,
        }).eq("id", data.tradeId);

        return { success: false, reason: result.failureReason ?? "Card verification failed" };
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);

      await db.from("trades").update({
        status: "invalid",
        failure_reason: "Verification service error",
      }).eq("id", data.tradeId);

      return { success: false, reason: msg };
    }
  });

// ─── Process payout via Squadco ───────────────────────────────────────────────
export const processPayout = createServerFn({ method: "POST" })
  .validator((d: {
    tradeId: string;
    userId: string;
    amountNgn: number;
    bankCode: string;
    accountNumber: string;
    accountName: string;
  }) => d)
  .handler(async ({ data }) => {
    const db = getServerSupabase();

    // Mark as processing
    await db.from("trades").update({ status: "processing" }).eq("id", data.tradeId);

    try {
      const { initiatePayout } = await import("../lib/squadco");

      const result = await initiatePayout({
        tradeId: data.tradeId,
        amountNgn: data.amountNgn,
        bankCode: data.bankCode,
        accountNumber: data.accountNumber,
        accountName: data.accountName,
        narration: "7SEVEN CARDS gift card payout",
      });

      if (result.success) {
        // Credit NGN wallet using the increment_wallet_balance SQL function
        await db.rpc("increment_wallet_balance", {
          p_user_id: data.userId,
          p_currency: "NGN",
          p_amount: data.amountNgn,
        });

        // Award XP (50 base + 25 bonus for trades over ₦100k)
        const xp = 50 + (data.amountNgn > 100_000 ? 25 : 0);
        await db.rpc("award_trade_xp", { p_user_id: data.userId, p_xp: xp });

        // Mark trade paid
        await db.from("trades").update({
          status: "paid",
          squadco_transaction_ref: result.transactionRef,
          squadco_payment_id: result.paymentId,
          xp_earned: xp,
          settled_at: new Date().toISOString(),
        }).eq("id", data.tradeId);

        await db.from("notifications").insert({
          user_id: data.userId,
          title: "Payment Sent! 🎉",
          message: `₦${data.amountNgn.toLocaleString()} has been sent to your bank account.`,
          type: "success",
        });

        // Push notification
        try {
          const { pushNotify } = await import("../lib/onesignal");
          pushNotify(data.userId, "Payment Sent! 🎉",
            `₦${data.amountNgn.toLocaleString()} is on its way to your bank.`,
            { tradeId: data.tradeId, type: "payout" }
          );
        } catch { /* non-critical */ }

        // Pay 5% recurring commission to referrer on EVERY successful trade.
        try {
          const { creditReferrerCommissionFn } = await import("../lib/db-helpers");
          await creditReferrerCommissionFn(db, data.userId, data.tradeId, data.amountNgn);
        } catch { /* non-critical — don't fail the payout if commission errors */ }

        return { success: true, transactionRef: result.transactionRef };
      } else {
        await db.from("trades").update({
          status: "failed",
          failure_reason: result.message,
        }).eq("id", data.tradeId);

        return { success: false, reason: result.message };
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const isConfig = msg.includes("not configured");

      if (isConfig) {
        // Squadco not configured — demo mode
        const xp = 50;
        await db.rpc("award_trade_xp", { p_user_id: data.userId, p_xp: xp });
        await db.rpc("increment_wallet_balance", {
          p_user_id: data.userId,
          p_currency: "NGN",
          p_amount: data.amountNgn,
        });

        await db.from("trades").update({
          status: "paid",
          xp_earned: xp,
          settled_at: new Date().toISOString(),
        }).eq("id", data.tradeId);

        await db.from("notifications").insert({
          user_id: data.userId,
          title: "Payment Sent! 🎉",
          message: `₦${data.amountNgn.toLocaleString()} has been credited to your wallet (demo).`,
          type: "success",
        });

        // Push notification (demo mode)
        try {
          const { pushNotify } = await import("../lib/onesignal");
          pushNotify(data.userId, "Payment Sent! 🎉",
            `₦${data.amountNgn.toLocaleString()} credited to your wallet.`,
            { tradeId: data.tradeId, type: "payout_demo" }
          );
        } catch { /* non-critical */ }

        // Also pay referral commission in demo mode
        try {
          const { creditReferrerCommissionFn } = await import("../lib/db-helpers");
          await creditReferrerCommissionFn(db, data.userId, data.tradeId, data.amountNgn);
        } catch { /* non-critical */ }

        return { success: true, transactionRef: "DEMO-" + data.tradeId, demo: true };
      }

      await db.from("trades").update({ status: "failed", failure_reason: msg }).eq("id", data.tradeId);
      return { success: false, reason: "Payment service unavailable" };
    }
  });

// ─── Get paginated + filtered trade history ────────────────────────────────────
export const getTradeHistory = createServerFn({ method: "GET" })
  .validator((d: {
    userId: string;
    page?: number;
    pageSize?: number;
    status?: string;
    type?: string;
  }) => d)
  .handler(async ({ data }) => {
    try {
      const db = getServerSupabase();
      const page = data.page ?? 0;
      const size = data.pageSize ?? 20;
      const from = page * size;
      const to = from + size - 1;

      let query = db
        .from("trades")
        .select("id,type,brand,region,amount_usd,amount_ngn,exchange_rate,status,failure_reason,xp_earned,settled_at,created_at", { count: "exact" })
        .eq("user_id", data.userId)
        .order("created_at", { ascending: false })
        .range(from, to);

      if (data.status && data.status !== "all") query = query.eq("status", data.status);
      if (data.type && data.type !== "all") query = query.eq("type", data.type);

      const { data: trades, error, count } = await query;
      if (error) throw error;
      return { trades: trades ?? [], total: count ?? 0, page, pageSize: size };
    } catch {
      return { trades: [], total: 0, page: 0, pageSize: 20 };
    }
  });

// ─── Get single trade status ───────────────────────────────────────────────────
export const getTradeStatus = createServerFn({ method: "GET" })
  .validator((d: { tradeId: string }) => d)
  .handler(async ({ data }) => {
    const db = getServerSupabase();
    const { data: trade, error } = await db
      .from("trades")
      .select("*")
      .eq("id", data.tradeId)
      .single();

    if (error) throw error;
    return trade;
  });
