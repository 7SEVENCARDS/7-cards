import { createServerFn } from "@tanstack/react-start";
import { getServerSupabase } from "../lib/supabase.server";
import { getCryptoRates } from "../lib/busha";
import { requireUser } from "../lib/auth-server";

// ─── Get own wallets ──────────────────────────────────────────────────────────
export const getUserWallets = createServerFn({ method: "GET" })
  .validator((d: { userId?: string }) => d)
  .handler(async () => {
    try {
      const userId = await requireUser();
      const db = getServerSupabase();
      const { data: wallets, error } = await db
        .from("wallets")
        .select("*")
        .eq("user_id", userId);

      if (error) throw error;

      const currencies = ["NGN", "BTC", "USDT", "ETH"] as const;
      const walletsMap = Object.fromEntries(wallets.map((w) => [w.currency, w]));

      return currencies.map(
        (cur) => walletsMap[cur] ?? { currency: cur, balance: 0, locked_balance: 0 }
      );
    } catch {
      return [
        { currency: "NGN",  balance: 0, locked_balance: 0 },
        { currency: "BTC",  balance: 0, locked_balance: 0 },
        { currency: "USDT", balance: 0, locked_balance: 0 },
        { currency: "ETH",  balance: 0, locked_balance: 0 },
      ];
    }
  });

// ─── Get total portfolio value in NGN ─────────────────────────────────────────
export const getTotalPortfolioNgn = createServerFn({ method: "GET" })
  .validator((d: { userId?: string }) => d)
  .handler(async () => {
    try {
      const userId = await requireUser();
      const db = getServerSupabase();
      const { data: wallets } = await db
        .from("wallets")
        .select("*")
        .eq("user_id", userId);

      if (!wallets?.length) return { totalNgn: 0, changePercent: "0.0" };

      const cryptoRates = await getCryptoRates();
      const rateMap: Record<string, number> = {};
      for (const r of cryptoRates) {
        const sym = r.symbol.replace("-NGN", "");
        rateMap[sym] = parseFloat(r.price);
      }
      rateMap["NGN"] = 1;

      let total = 0;
      for (const w of wallets) {
        const rate = rateMap[w.currency] ?? 0;
        total += Number(w.balance) * rate;
      }

      return { totalNgn: Math.round(total), changePercent: "+0.0" };
    } catch {
      return { totalNgn: 0, changePercent: "0.0" };
    }
  });

// ─── Get own payout accounts ──────────────────────────────────────────────────
export const getPayoutAccounts = createServerFn({ method: "GET" })
  .validator((d: { userId?: string }) => d)
  .handler(async () => {
    try {
      const userId = await requireUser();
      const db = getServerSupabase();
      const { data: accounts, error } = await db
        .from("payout_accounts")
        .select("*")
        .eq("user_id", userId)
        .order("is_default", { ascending: false });

      if (error) throw error;
      return accounts ?? [];
    } catch {
      return [];
    }
  });

// ─── Add payout account ───────────────────────────────────────────────────────
export const addPayoutAccount = createServerFn({ method: "POST" })
  .validator((d: {
    bankName: string;
    bankCode: string;
    accountNumber: string;
    accountName: string;
    isDefault?: boolean;
  }) => d)
  .handler(async ({ data }) => {
    const userId = await requireUser();
    const db = getServerSupabase();

    if (data.isDefault) {
      await db
        .from("payout_accounts")
        .update({ is_default: false })
        .eq("user_id", userId);
    }

    const { error } = await db.from("payout_accounts").insert({
      user_id: userId,
      bank_name: data.bankName,
      bank_code: data.bankCode,
      account_number: data.accountNumber,
      account_name: data.accountName,
      is_default: data.isDefault ?? false,
    });

    if (error) throw error;
    return { success: true };
  });

// ─── Get notifications ────────────────────────────────────────────────────────
export const getNotifications = createServerFn({ method: "GET" })
  .validator((d: { userId?: string }) => d)
  .handler(async () => {
    try {
      const userId = await requireUser();
      const db = getServerSupabase();
      const { data: notifs, error } = await db
        .from("notifications")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(20);

      if (error) throw error;
      return notifs ?? [];
    } catch {
      return [];
    }
  });

// ─── Mark notification read ───────────────────────────────────────────────────
// Requires auth; only marks the notification if it belongs to the session user.
export const markNotificationRead = createServerFn({ method: "POST" })
  .validator((d: { notificationId: string }) => d)
  .handler(async ({ data }) => {
    const userId = await requireUser();
    const db = getServerSupabase();
    await db
      .from("notifications")
      .update({ read: true })
      .eq("id", data.notificationId)
      .eq("user_id", userId);
    return { success: true };
  });

// ─── Mark all notifications read ─────────────────────────────────────────────
export const markAllNotificationsRead = createServerFn({ method: "POST" })
  .validator((d: { userId?: string }) => d)
  .handler(async () => {
    const userId = await requireUser();
    const db = getServerSupabase();
    await db
      .from("notifications")
      .update({ read: true })
      .eq("user_id", userId)
      .eq("read", false);
    return { success: true };
  });

// ─── Delete notification ──────────────────────────────────────────────────────
export const deleteNotification = createServerFn({ method: "POST" })
  .validator((d: { notificationId: string }) => d)
  .handler(async ({ data }) => {
    const userId = await requireUser();
    const db = getServerSupabase();
    await db
      .from("notifications")
      .delete()
      .eq("id", data.notificationId)
      .eq("user_id", userId);
    return { success: true };
  });

// ─── Clear all read notifications ────────────────────────────────────────────
export const clearReadNotifications = createServerFn({ method: "POST" })
  .validator((d: { userId?: string }) => d)
  .handler(async () => {
    const userId = await requireUser();
    const db = getServerSupabase();
    await db
      .from("notifications")
      .delete()
      .eq("user_id", userId)
      .eq("read", true);
    return { success: true };
  });
