import { createServerFn } from "@tanstack/react-start";
import { getServerSupabase } from "../lib/supabase.server";
import { requireUser } from "../lib/auth-server";
import { DEMO_DEPOSIT_ADDRESSES, COMPANY_SPREAD } from "../lib/busha";

// ─── Types ────────────────────────────────────────────────────────────────────

export type CryptoTxRow = {
  id: string;
  user_id: string;
  type: "swap" | "send" | "receive" | "convert";
  from_currency: string | null;
  to_currency: string | null;
  from_amount: number | null;
  to_amount: number | null;
  address: string | null;
  tx_ref: string | null;
  status: "pending" | "completed" | "failed";
  meta: Record<string, string | number | boolean | null> | null;
  created_at: string;
};

// ─── Get deposit address ──────────────────────────────────────────────────────
export const getCryptoDepositAddress = createServerFn({ method: "GET" })
  .inputValidator((d: { currency: string }) => d)
  .handler(async ({ data }) => {
    await requireUser();
    try {
      const { getDepositAddress } = await import("../lib/busha");
      const result = await getDepositAddress(data.currency);
      return { ...result, demo: false };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const isUnconfigured = msg.includes("not configured");
      const demo = DEMO_DEPOSIT_ADDRESSES[data.currency.toUpperCase()];
      return {
        address: demo?.address ?? "ADDRESS_NOT_AVAILABLE",
        network: demo?.network ?? data.currency,
        demo: isUnconfigured,
      };
    }
  });

// ─── Initiate crypto swap ─────────────────────────────────────────────────────
export const initiateCryptoSwap = createServerFn({ method: "POST" })
  .inputValidator(
    (d: { fromCurrency: string; toCurrency: string; amount: number }) => d
  )
  .handler(async ({ data }) => {
    const userId = await requireUser();
    const db = getServerSupabase();

    const { data: profile } = await db
      .from("profiles")
      .select("kyc_status")
      .eq("id", userId)
      .single();
    if (!profile || profile.kyc_status === "pending") {
      return { success: false as const, reason: "KYC_REQUIRED" };
    }

    const sufficient = await db.rpc("deduct_wallet_balance", {
      p_user_id: userId,
      p_currency: data.fromCurrency,
      p_amount: data.amount,
    });
    if (!sufficient.data) {
      return { success: false as const, reason: "INSUFFICIENT_BALANCE" };
    }

    try {
      const { executeSwap } = await import("../lib/busha");
      const result = await executeSwap({
        fromCurrency: data.fromCurrency,
        toCurrency: data.toCurrency,
        amount: data.amount,
      });

      const grossToAmount = parseFloat(result.total ?? "0");
      const companyFee  = +(grossToAmount * COMPANY_SPREAD).toFixed(10);
      const netToAmount = +(grossToAmount * (1 - COMPANY_SPREAD)).toFixed(10);

      await db.rpc("increment_wallet_balance", {
        p_user_id: userId,
        p_currency: data.toCurrency,
        p_amount: netToAmount,
      });

      await db.from("crypto_transactions").insert({
        user_id: userId,
        type: "swap",
        from_currency: data.fromCurrency,
        to_currency: data.toCurrency,
        from_amount: data.amount,
        to_amount: netToAmount,
        tx_ref: result.id,
        status: result.status === "completed" ? "completed" : "pending",
        meta: {
          pair: result.pair,
          busha_fee: result.fee,
          gross_to_amount: grossToAmount,
          company_fee: companyFee,
          spread: COMPANY_SPREAD,
        },
      });

      await db.from("notifications").insert({
        user_id: userId,
        title: "Swap Complete ✅",
        message: `Swapped ${data.amount} ${data.fromCurrency} → ${netToAmount.toFixed(6)} ${data.toCurrency}`,
        type: "success",
      });

      return {
        success: true as const,
        txRef: result.id,
        toAmount: netToAmount,
        toCurrency: data.toCurrency,
        status: result.status,
        demo: false,
      };
    } catch (e: unknown) {
      await db.rpc("increment_wallet_balance", {
        p_user_id: userId,
        p_currency: data.fromCurrency,
        p_amount: data.amount,
      });

      const msg = e instanceof Error ? e.message : String(e);
      const isDemo = msg.includes("not configured");

      if (isDemo && process.env.NODE_ENV !== "production") {
        const { getCryptoRates } = await import("../lib/busha");
        const rates = await getCryptoRates();
        const getPrice = (sym: string) =>
          sym === "NGN"
            ? 1
            : parseFloat(
                rates.find((r) => r.symbol === `${sym}-NGN`)?.price ?? "0"
              );

        const fromPriceNgn = getPrice(data.fromCurrency);
        const toPriceNgn = getPrice(data.toCurrency);
        const grossToAmount =
          toPriceNgn > 0 ? (data.amount * fromPriceNgn) / toPriceNgn : 0;
        const companyFee  = +(grossToAmount * COMPANY_SPREAD).toFixed(10);
        const netToAmount = +(grossToAmount * (1 - COMPANY_SPREAD)).toFixed(10);

        await db.rpc("deduct_wallet_balance", {
          p_user_id: userId,
          p_currency: data.fromCurrency,
          p_amount: data.amount,
        });
        await db.rpc("increment_wallet_balance", {
          p_user_id: userId,
          p_currency: data.toCurrency,
          p_amount: netToAmount,
        });

        const txRef = "DEMO-SWAP-" + Date.now();
        await db.from("crypto_transactions").insert({
          user_id: userId,
          type: "swap",
          from_currency: data.fromCurrency,
          to_currency: data.toCurrency,
          from_amount: data.amount,
          to_amount: netToAmount,
          tx_ref: txRef,
          status: "completed",
          meta: {
            demo: true,
            gross_to_amount: grossToAmount,
            company_fee: companyFee,
            spread: COMPANY_SPREAD,
          },
        });

        await db.from("notifications").insert({
          user_id: userId,
          title: "Swap Complete ✅",
          message: `Swapped ${data.amount} ${data.fromCurrency} → ${netToAmount.toFixed(6)} ${data.toCurrency} (demo)`,
          type: "success",
        });

        return {
          success: true as const,
          txRef,
          toAmount: netToAmount,
          toCurrency: data.toCurrency,
          status: "completed",
          demo: true,
        };
      }

      return { success: false as const, reason: msg };
    }
  });

// ─── Send crypto to external address ─────────────────────────────────────────
export const initiateCryptoSend = createServerFn({ method: "POST" })
  .inputValidator(
    (d: { currency: string; amount: number; address: string; tag?: string }) => d
  )
  .handler(async ({ data }) => {
    const userId = await requireUser();
    const db = getServerSupabase();

    const { data: profile } = await db
      .from("profiles")
      .select("kyc_status")
      .eq("id", userId)
      .single();
    if (!profile || profile.kyc_status === "pending") {
      return { success: false as const, reason: "KYC_REQUIRED" };
    }

    const MINIMUMS: Record<string, number> = {
      BTC: 0.00001, ETH: 0.001, USDT: 1, USDC: 1, BNB: 0.001, SOL: 0.01,
    };
    const min = MINIMUMS[data.currency.toUpperCase()] ?? 0;
    if (data.amount < min) {
      return {
        success: false as const,
        reason: `Minimum send for ${data.currency} is ${min}`,
      };
    }

    const sufficient = await db.rpc("deduct_wallet_balance", {
      p_user_id: userId,
      p_currency: data.currency,
      p_amount: data.amount,
    });
    if (!sufficient.data) {
      return { success: false as const, reason: "INSUFFICIENT_BALANCE" };
    }

    try {
      const { sendCrypto } = await import("../lib/busha");
      const result = await sendCrypto({
        currency: data.currency,
        amount: data.amount,
        address: data.address,
        tag: data.tag,
      });

      await db.from("crypto_transactions").insert({
        user_id: userId,
        type: "send",
        from_currency: data.currency,
        from_amount: data.amount,
        address: data.address,
        tx_ref: result.id,
        status: result.status === "completed" ? "completed" : "pending",
        meta: { fee: result.fee, tx_id: result.tx_id ?? null },
      });

      await db.from("notifications").insert({
        user_id: userId,
        title: `${data.currency} Sent 📤`,
        message: `${data.amount} ${data.currency} sent to ${data.address.slice(0, 8)}…`,
        type: "info",
      });

      try {
        const { pushNotify } = await import("../lib/onesignal");
        pushNotify(userId, `${data.currency} Sent 📤`,
          `${data.amount} ${data.currency} is on its way.`,
          { type: "crypto_send", txRef: result.id }
        );
      } catch { /* non-critical */ }

      return { success: true as const, txRef: result.id, status: result.status, demo: false };
    } catch (e: unknown) {
      await db.rpc("increment_wallet_balance", {
        p_user_id: userId,
        p_currency: data.currency,
        p_amount: data.amount,
      });

      const msg = e instanceof Error ? e.message : String(e);
      const isDemo = msg.includes("not configured");

      if (isDemo && process.env.NODE_ENV !== "production") {
        await db.rpc("deduct_wallet_balance", {
          p_user_id: userId,
          p_currency: data.currency,
          p_amount: data.amount,
        });
        const txRef = "DEMO-SEND-" + Date.now();
        await db.from("crypto_transactions").insert({
          user_id: userId,
          type: "send",
          from_currency: data.currency,
          from_amount: data.amount,
          address: data.address,
          tx_ref: txRef,
          status: "completed",
          meta: { demo: true },
        });
        await db.from("notifications").insert({
          user_id: userId,
          title: `${data.currency} Sent 📤`,
          message: `${data.amount} ${data.currency} sent to ${data.address.slice(0, 8)}… (demo)`,
          type: "info",
        });
        return { success: true as const, txRef, status: "completed", demo: true };
      }

      return { success: false as const, reason: "Send failed: " + msg };
    }
  });

// ─── Get crypto transaction history ──────────────────────────────────────────
export const getCryptoTransactions = createServerFn({ method: "GET" })
  .inputValidator((d: { limit?: number }) => d)
  .handler(async ({ data }) => {
    try {
      const userId = await requireUser();
      const db = getServerSupabase();
      const { data: txs, error } = await db
        .from("crypto_transactions")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(data.limit ?? 30);
      if (error) throw error;
      return (txs ?? []) as CryptoTxRow[];
    } catch {
      return [] as CryptoTxRow[];
    }
  });
