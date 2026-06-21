import { createServerFn } from "@tanstack/react-start";
import { getServerSupabase } from "../lib/supabase.server";
import { requireUser } from "../lib/auth-server";

// ─── Get own trade history (recent) ──────────────────────────────────────────
export const getUserTrades = createServerFn({ method: "GET" })
  .validator((d: { userId?: string; limit?: number }) => d)
  .handler(async ({ data }) => {
    try {
      const userId = await requireUser();
      const db = getServerSupabase();
      const { data: trades, error } = await db
        .from("trades")
        .select("*")
        .eq("user_id", userId)
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
    type: "gift_card" | "crypto";
    brand: string;
    amountUsd: number;
    exchangeRate: number;
  }) => d)
  .handler(async ({ data }) => {
    const userId = await requireUser();
    const db = getServerSupabase();

    const amountNgn = Math.round(data.amountUsd * data.exchangeRate);

    const { data: trade, error } = await db
      .from("trades")
      .insert({
        user_id: userId,
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
export const verifyGiftCard = createServerFn({ method: "POST" })
  .validator((d: {
    tradeId: string;
    cardCode: string;
    cardPin?: string;
    brand: string;
    amountUsd: number;
    recipientEmail?: string;
  }) => d)
  .handler(async ({ data }) => {
    const userId = await requireUser();
    const db = getServerSupabase();

    // Verify the trade belongs to this user
    const { data: trade } = await db
      .from("trades")
      .select("id, user_id, status")
      .eq("id", data.tradeId)
      .single();

    if (!trade || trade.user_id !== userId) {
      return { success: false, reason: "Trade not found or access denied." };
    }

    // Verification allowance check
    const { checkVerificationAllowance, addVerificationUsage } = await import("../lib/db-helpers");
    const allowance = await checkVerificationAllowance(db, userId);

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

    // Record usage for free-tier users
    if (!allowance.unlimited) {
      try {
        await addVerificationUsage(db, userId, data.tradeId);
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
          card_pin: data.cardPin ?? null,
          requires_manual_review: result.requiresManualReview ?? false,
          reloadly_transaction_id: result.productId ? String(result.productId) : null,
        }).eq("id", data.tradeId);

        // ── PILLAR 1: Log 'card_verified' — Reloadly_Token + Timestamp + Actor ──
        // The hash of (reloadly_token | server_ts_ms | user_id | trade_id | event)
        // becomes the cryptographic proof that this card passed Reloadly at this
        // exact moment. If Reloadly is ever accused of returning stale data, this
        // entry's hash mismatch will expose any tampering.
        try {
          const { logTradeEvent, hashReloadlyToken } = await import("../lib/audit-log");
          const reloadlyTokenHash = await hashReloadlyToken().catch(() => "hash-unavailable");
          await logTradeEvent(db, {
            tradeId:  data.tradeId,
            event:    "card_verified",
            actorType: "user",
            actorId:  userId,
            payload: {
              brand:               data.brand,
              amount_usd:          data.amountUsd,
              reloadly_product_id: result.productId ?? null,
              reloadly_balance:    result.balance ?? null,
              reloadly_currency:   result.currency ?? null,
              reloadly_token_hash: reloadlyTokenHash, // Pillar-1 anchor
              requires_manual_review: result.requiresManualReview ?? false,
            },
          });
        } catch (e) {
          console.warn("[AuditLog] card_verified log failed (non-fatal):", e instanceof Error ? e.message : e);
        }

        // Trigger Telegram broadcast to all active vendors (fire-and-forget)
        try {
          const { broadcastTradeToVendors } = await import("./vendor-broadcast");
          const { data: tradeRow } = await db
            .from("trades")
            .select("brand, amount_usd, amount_ngn")
            .eq("id", data.tradeId)
            .single() as { data: { brand: string; amount_usd: number; amount_ngn: number } | null };
          if (tradeRow) {
            broadcastTradeToVendors({
              tradeId: data.tradeId,
              brand: tradeRow.brand,
              amountUsd: Number(tradeRow.amount_usd),
              amountNgn: Number(tradeRow.amount_ngn),
            }).catch(e =>
              console.warn("[Trades] Broadcast failed (non-fatal):", e instanceof Error ? e.message : e)
            );
          }
        } catch (e) {
          console.warn("[Trades] Broadcast import failed (non-fatal):", e instanceof Error ? e.message : e);
        }

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
// SECURITY: All payout values come from the database — the client only supplies
// the trade ID. Amount, bank code, account number, and account name are never
// accepted from the client; this prevents parameter-tampering attacks.
export const processPayout = createServerFn({ method: "POST" })
  .validator((d: { tradeId: string; payoutMethod?: "bank" | "wallet" }) => d)
  .handler(async ({ data }) => {
    const userId = await requireUser();
    const db = getServerSupabase();

    // Fetch trade from DB — verify ownership and status
    const { data: trade, error: tradeErr } = await db
      .from("trades")
      .select("id, user_id, amount_ngn, status")
      .eq("id", data.tradeId)
      .single();

    if (tradeErr || !trade) {
      return { success: false, reason: "Trade not found." };
    }
    if (trade.user_id !== userId) {
      return { success: false, reason: "Access denied." };
    }
    if (trade.status !== "verified") {
      return { success: false, reason: `Trade is not verified (status: ${trade.status}).` };
    }

    const amountNgn = Number(trade.amount_ngn);
    const payoutMethod = data.payoutMethod ?? "bank";

    // ── wallet credit path (no Squad payout) ──────────────────────────────
    if (payoutMethod === "wallet") {
      await db.from("trades").update({ status: "processing", payout_method: "wallet" }).eq("id", data.tradeId);
      const xp = 50 + (amountNgn > 100_000 ? 25 : 0);
      await db.rpc("increment_wallet_balance", { p_user_id: userId, p_currency: "NGN", p_amount: amountNgn });
      await db.rpc("award_trade_xp", { p_user_id: userId, p_xp: xp });
      await db.from("trades").update({
        status: "paid", xp_earned: xp,
        settled_at: new Date().toISOString(), payout_method: "wallet",
      }).eq("id", data.tradeId);
      await db.from("notifications").insert({
        user_id: userId, title: "Wallet Credited! 💰",
        message: `₦${amountNgn.toLocaleString()} has been added to your 7SEVEN wallet.`,
        type: "success",
      });
      try {
        const { pushNotify } = await import("../lib/onesignal");
        pushNotify(userId, "Wallet Credited! 💰",
          `₦${amountNgn.toLocaleString()} is in your wallet — ready to swap to crypto.`,
          { tradeId: data.tradeId, type: "wallet_credit" }
        );
      } catch { /* non-critical */ }
      try {
        const { creditReferrerCommissionFn } = await import("../lib/db-helpers");
        await creditReferrerCommissionFn(db, userId, data.tradeId, amountNgn);
      } catch { /* non-critical */ }
      return { success: true, transactionRef: "WALLET-" + data.tradeId, walletCredit: true };
    }

    // ── Bank transfer path (Squad) ────────────────────────────────────────
    // Fetch the user's default payout account from DB — never from client
    const { data: payoutAccount } = await db
      .from("payout_accounts")
      .select("bank_code, account_number, account_name")
      .eq("user_id", userId)
      .eq("is_default", true)
      .single();

    if (!payoutAccount) {
      return { success: false, reason: "No default payout account found. Please add a bank account first." };
    }

    // Mark as processing
    await db.from("trades").update({ status: "processing", payout_method: "bank" }).eq("id", data.tradeId);

    try {
      const { initiatePayout } = await import("../lib/squadco");

      const result = await initiatePayout({
        tradeId: data.tradeId,
        amountNgn,
        bankCode: payoutAccount.bank_code,
        accountNumber: payoutAccount.account_number,
        accountName: payoutAccount.account_name,
        narration: "7SEVEN CARDS gift card payout",
      });

      if (result.success) {
        await db.rpc("increment_wallet_balance", {
          p_user_id: userId,
          p_currency: "NGN",
          p_amount: amountNgn,
        });

        const xp = 50 + (amountNgn > 100_000 ? 25 : 0);
        await db.rpc("award_trade_xp", { p_user_id: userId, p_xp: xp });

        await db.from("trades").update({
          status: "paid",
          squadco_transaction_ref: result.transactionRef,
          squadco_payment_id: result.paymentId,
          xp_earned: xp,
          settled_at: new Date().toISOString(),
        }).eq("id", data.tradeId);

        await db.from("notifications").insert({
          user_id: userId,
          title: "Payment Sent! 🎉",
          message: `₦${amountNgn.toLocaleString()} has been sent to your bank account.`,
          type: "success",
        });

        try {
          const { pushNotify } = await import("../lib/onesignal");
          pushNotify(userId, "Payment Sent! 🎉",
            `₦${amountNgn.toLocaleString()} is on its way to your bank.`,
            { tradeId: data.tradeId, type: "payout" }
          );
        } catch { /* non-critical */ }

        try {
          const { creditReferrerCommissionFn } = await import("../lib/db-helpers");
          await creditReferrerCommissionFn(db, userId, data.tradeId, amountNgn);
        } catch { /* non-critical */ }

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
        // Demo mode — only allowed outside production
        if (process.env.NODE_ENV === "production") {
          await db.from("trades").update({
            status: "failed",
            failure_reason: "Payment provider not configured",
          }).eq("id", data.tradeId);
          return { success: false, reason: "Payment service is unavailable. Please contact support." };
        }

        const xp = 50;
        await db.rpc("award_trade_xp", { p_user_id: userId, p_xp: xp });
        await db.rpc("increment_wallet_balance", {
          p_user_id: userId,
          p_currency: "NGN",
          p_amount: amountNgn,
        });

        await db.from("trades").update({
          status: "paid",
          xp_earned: xp,
          settled_at: new Date().toISOString(),
        }).eq("id", data.tradeId);

        await db.from("notifications").insert({
          user_id: userId,
          title: "Payment Sent! 🎉",
          message: `₦${amountNgn.toLocaleString()} has been credited to your wallet (demo).`,
          type: "success",
        });

        try {
          const { pushNotify } = await import("../lib/onesignal");
          pushNotify(userId, "Payment Sent! 🎉",
            `₦${amountNgn.toLocaleString()} credited to your wallet.`,
            { tradeId: data.tradeId, type: "payout_demo" }
          );
        } catch { /* non-critical */ }

        try {
          const { creditReferrerCommissionFn } = await import("../lib/db-helpers");
          await creditReferrerCommissionFn(db, userId, data.tradeId, amountNgn);
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
    userId?: string;
    page?: number;
    pageSize?: number;
    status?: string;
    type?: string;
  }) => d)
  .handler(async ({ data }) => {
    try {
      const userId = await requireUser();
      const db = getServerSupabase();
      const page = data.page ?? 0;
      const size = data.pageSize ?? 20;
      const from = page * size;
      const to = from + size - 1;

      let query = db
        .from("trades")
        .select(
          "id,type,brand,region,amount_usd,amount_ngn,exchange_rate,status,failure_reason,xp_earned,settled_at,created_at",
          { count: "exact" }
        )
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .range(from, to);

      if (data.status && data.status !== "all") query = query.eq("status", data.status);
      if (data.type   && data.type   !== "all") query = query.eq("type",   data.type);

      const { data: trades, error, count } = await query;
      if (error) throw error;
      return { trades: trades ?? [], total: count ?? 0, page, pageSize: size };
    } catch {
      return { trades: [], total: 0, page: 0, pageSize: 20 };
    }
  });

// ─── Get single trade status ───────────────────────────────────────────────────
// Verifies the trade belongs to the session user before returning it.
export const getTradeStatus = createServerFn({ method: "GET" })
  .validator((d: { tradeId: string }) => d)
  .handler(async ({ data }) => {
    const userId = await requireUser();
    const db = getServerSupabase();
    const { data: trade, error } = await db
      .from("trades")
      .select("*")
      .eq("id", data.tradeId)
      .eq("user_id", userId)
      .single();

    if (error) throw error;
    return trade;
  });
