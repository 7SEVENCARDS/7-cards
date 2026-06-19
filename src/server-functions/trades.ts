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

// ─── Verify gift card (calls Reloadly) ───────────────────────────────────────
export const verifyGiftCard = createServerFn({ method: "POST" })
  .validator((d: {
    tradeId: string;
    userId: string;
    cardCode: string;
    cardPin?: string;
    brand: string;
    amountUsd: number;
    recipientEmail: string;
  }) => d)
  .handler(async ({ data }) => {
    const db = getServerSupabase();

    // Mark trade as scanning
    await db.from("trades").update({ status: "scanning" }).eq("id", data.tradeId);

    try {
      const { redeemGiftCard, getGiftCardProducts } = await import("../lib/reloadly");

      // Find the Reloadly product ID for this brand
      const products = await getGiftCardProducts("US");
      const product = products.find((p) =>
        p.productName.toLowerCase().includes(data.brand.toLowerCase())
      );

      if (!product) {
        // Brand not found in Reloadly — still proceed but log warning
        console.warn(`[Reloadly] Product not found for brand: ${data.brand}`);
      }

      const result = await redeemGiftCard({
        productId: product?.productId ?? 1,
        cardCode: data.cardCode,
        cardPin: data.cardPin,
        amountUsd: data.amountUsd,
        tradeId: data.tradeId,
        recipientEmail: data.recipientEmail,
      });

      if (result.success) {
        await db.from("trades").update({
          status: "verified",
          reloadly_transaction_id: result.transactionId,
          reloadly_order_id: result.orderId,
        }).eq("id", data.tradeId);

        return { success: true, tradeId: data.tradeId };
      } else {
        await db.from("trades").update({
          status: "invalid",
          failure_reason: result.failureReason,
        }).eq("id", data.tradeId);

        return { success: false, reason: result.failureReason ?? "Card verification failed" };
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const isConfig = msg.includes("not configured");

      if (isConfig) {
        // Reloadly not configured — set to verified for demo
        await db.from("trades").update({ status: "verified" }).eq("id", data.tradeId);
        return { success: true, tradeId: data.tradeId, demo: true };
      }

      await db.from("trades").update({
        status: "invalid",
        failure_reason: "Verification service error",
      }).eq("id", data.tradeId);

      return { success: false, reason: "Verification service unavailable" };
    }
  });

// ─── Process payout (calls Squadco) ──────────────────────────────────────────
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
        // Credit NGN wallet
        const { error: walletError } = await db.rpc("increment_wallet_balance", {
          p_user_id: data.userId,
          p_currency: "NGN",
          p_amount: data.amountNgn,
        });

        if (walletError) {
          // Fallback: direct update
          await db
            .from("wallets")
            .update({ balance: db.rpc("balance + $1" as never, [data.amountNgn]) as never })
            .eq("user_id", data.userId)
            .eq("currency", "NGN");
        }

        // Award XP (50 base + bonus for large trades)
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

        // Send notification
        await db.from("notifications").insert({
          user_id: data.userId,
          title: "Payment Sent! 🎉",
          message: `₦${data.amountNgn.toLocaleString()} has been sent to your bank account.`,
          type: "success",
        });

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
        // Squadco not configured — simulate for demo
        const xp = 50;
        await db.rpc("award_trade_xp", { p_user_id: data.userId, p_xp: xp });

        // Directly credit NGN wallet
        const { data: wallet } = await db
          .from("wallets")
          .select("balance")
          .eq("user_id", data.userId)
          .eq("currency", "NGN")
          .single();

        await db.from("wallets")
          .update({ balance: (Number(wallet?.balance ?? 0) + data.amountNgn) })
          .eq("user_id", data.userId)
          .eq("currency", "NGN");

        await db.from("trades").update({
          status: "paid",
          xp_earned: xp,
          settled_at: new Date().toISOString(),
        }).eq("id", data.tradeId);

        await db.from("notifications").insert({
          user_id: data.userId,
          title: "Payment Sent! 🎉",
          message: `₦${data.amountNgn.toLocaleString()} has been credited to your wallet.`,
          type: "success",
        });

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
