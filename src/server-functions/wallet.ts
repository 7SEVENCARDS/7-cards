import { createServerFn } from "@tanstack/react-start";
import { getServerSupabase } from "../lib/supabase.server";
import { getCryptoRates } from "../lib/busha";
import { requireUser } from "../lib/auth-server";
import { WalletService } from "../lib/wallet-service";
import { initiatePayout } from "../lib/squadco";

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

    if (error) return { success: false, error: (error as {message?:string}).message ?? "Failed to save account" };
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

// ─── Request user wallet withdrawal ──────────────────────────────────────────
export const requestUserWithdrawal = createServerFn({ method: "POST" })
  .validator((d: {
    amountNgn: number;
    bankCode: string;
    accountNumber: string;
    accountName: string;
    bankName: string;
  }) => d)
  .handler(async ({ data }) => {
    const userId = await requireUser();
    const db = getServerSupabase();

    if (data.amountNgn < 500) throw new Error("Minimum withdrawal is ₦500");
    if (data.amountNgn > 1_000_000) throw new Error("Maximum single withdrawal is ₦1,000,000");

    // 1. Get NGN wallet balance
    const { data: wallet, error: wErr } = await db
      .from("wallets")
      .select("id, balance")
      .eq("user_id", userId)
      .eq("currency", "NGN")
      .single();

    if (wErr || !wallet) throw new Error("NGN wallet not found. Complete a trade first.");
    const balance = Number(wallet.balance);
    if (balance < data.amountNgn) {
      throw new Error(`Insufficient balance. Available: ₦${balance.toLocaleString()}`);
    }

    // 2. Debit balance via WalletService (validates, records ledger, idempotent)
    const withdrawalRef = `WD-${userId.slice(0, 8)}-${Date.now()}`;
    const debitResult = await WalletService.debit(db, {
      userId,
      currency: "NGN",
      amountNgn: data.amountNgn,
      refType: "withdrawal",
      description: `Withdrawal to ${data.accountName} · ${data.bankName}`,
      idempotencyKey: withdrawalRef,
    });
    if (!debitResult.ok) throw new Error(debitResult.error ?? "Failed to debit balance");
    const newBalance = debitResult.newBalance ?? (balance - data.amountNgn);

    // 3. Initiate Squadco payout
    let payoutRef = "";
    try {
      const result = await initiatePayout({
        tradeId: withdrawalRef,
        amountNgn: data.amountNgn,
        bankCode: data.bankCode,
        accountNumber: data.accountNumber,
        accountName: data.accountName,
        narration: "7SEVEN CARDS wallet withdrawal",
      });

      if (!result.success) {
        // Restore balance on payout failure via WalletService credit
        await WalletService.credit(db, { userId, currency: "NGN", amountNgn: data.amountNgn, refType: "withdrawal_reversal", description: "Payout failed — balance restored", idempotencyKey: `${withdrawalRef}_reversal` });
        throw new Error(result.message ?? "Payout failed — balance restored. Try again.");
      }
      payoutRef = result.transactionRef;
    } catch (e: unknown) {
      // Restore balance if Squadco is unreachable or not configured
      await WalletService.credit(db, { userId, currency: "NGN", amountNgn: data.amountNgn, refType: "withdrawal_reversal", description: "Payout service error — balance restored", idempotencyKey: `${withdrawalRef}_reversal` });
      const msg = e instanceof Error ? e.message : "Unknown payout error";
      if (msg.includes("balance restored") || msg.includes("Insufficient") || msg.includes("Minimum")) {
        throw e;
      }
      throw new Error("Payout service temporarily unavailable — balance restored. Please try again in a moment.");
    }

    // 4. Create success notification
    await db.from("notifications").insert({
      user_id: userId,
      title: "Withdrawal Initiated 💸",
      message: `₦${data.amountNgn.toLocaleString()} is on its way to ${data.accountName} · ${data.bankName}. Usually arrives within 5 minutes.`,
      type: "success",
    });

    return { success: true, ref: payoutRef, newBalance };
  });

// ─── Earnings history ─────────────────────────────────────────────────────────
// Combines weekly trade commissions + referral commissions into one timeline.
// Also returns eligibility for the next Thursday payout and countdown info.
export type EarningEntry = {
  id:         string;
  type:       "weekly_commission" | "referral_commission";
  amount_ngn: number;
  label:      string;
  sub:        string;
  created_at: string;
};
export type EarningsData = {
  entries:         EarningEntry[];
  totalEarnedNgn:  number;
  eligibleThisWeek: boolean;
  weeklyVolumeNgn: number;
  nextThursdayIso: string;   // ISO of next Thursday 18:00 UTC (= 7pm WAT)
};

export const getEarningsHistory = createServerFn({ method: "GET" })
  .validator((d: { userId?: string }) => d)
  .handler(async (): Promise<EarningsData> => {
    try {
      const userId = await requireUser();
      const db     = getServerSupabase();

      // ── Weekly commissions ────────────────────────────────────────────────
      const { data: weeklyRows } = await db
        .from("weekly_trade_commissions")
        .select("id, week_key, amount_ngn, paid_at")
        .eq("user_id", userId)
        .order("paid_at", { ascending: false })
        .limit(30);

      // ── Referral commissions ──────────────────────────────────────────────
      const { data: refRows } = await db
        .from("referral_commissions")
        .select("id, amount_ngn, commission_rate, created_at, referee_id")
        .eq("referrer_id", userId)
        .order("created_at", { ascending: false })
        .limit(30);

      // Fetch referee display names (batch)
      const refereeIds = [...new Set((refRows ?? []).map((r) => r.referee_id))];
      const refNames: Record<string, string> = {};
      if (refereeIds.length > 0) {
        const { data: profiles } = await db
          .from("profiles")
          .select("id, display_name")
          .in("id", refereeIds);
        for (const p of profiles ?? []) {
          refNames[p.id] = p.display_name ?? "a referral";
        }
      }

      // ── Build combined timeline ───────────────────────────────────────────
      const entries: EarningEntry[] = [
        ...(weeklyRows ?? []).map((w) => ({
          id:         w.id,
          type:       "weekly_commission" as const,
          amount_ngn: Number(w.amount_ngn),
          label:      `Weekly Commission — ${w.week_key}`,
          sub:        new Date(w.paid_at).toLocaleDateString("en-NG", { day: "numeric", month: "short", year: "numeric" }),
          created_at: w.paid_at,
        })),
        ...(refRows ?? []).map((r) => ({
          id:         r.id,
          type:       "referral_commission" as const,
          amount_ngn: Number(r.amount_ngn),
          label:      `5% Commission from ${refNames[r.referee_id] ?? "a referral"}`,
          sub:        new Date(r.created_at).toLocaleDateString("en-NG", { day: "numeric", month: "short", year: "numeric" }),
          created_at: r.created_at,
        })),
      ].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

      const totalEarnedNgn =
        entries.reduce((s, e) => s + e.amount_ngn, 0);

      // ── Eligibility: ≥$25 (≥₦7,000) trades in past 7 days ───────────────
      const since7d = new Date();
      since7d.setDate(since7d.getDate() - 7);

      const { data: weekTrades } = await db
        .from("trades")
        .select("amount_usd, amount_ngn")
        .eq("user_id", userId)
        .in("status", ["paid", "completed"])
        .gte("created_at", since7d.toISOString())
        .gte("amount_ngn", 7000);

      const weeklyVolumeUsd = (weekTrades ?? []).reduce((s, t) => s + Number(t.amount_usd ?? 0), 0);
      const weeklyVolumeNgn = (weekTrades ?? []).reduce((s, t) => s + Number(t.amount_ngn ?? 0), 0);
      const eligibleThisWeek = weeklyVolumeUsd >= 25;

      // ── Next Thursday 18:00 UTC ───────────────────────────────────────────
      const now = new Date();
      const dayOfWeek = now.getUTCDay(); // 0=Sun … 4=Thu … 6=Sat
      const daysUntilThursday = (4 - dayOfWeek + 7) % 7 || 7; // always ≥1
      const nextThursday = new Date(now);
      nextThursday.setUTCDate(nextThursday.getUTCDate() + daysUntilThursday);
      nextThursday.setUTCHours(18, 0, 0, 0);
      const nextThursdayIso = nextThursday.toISOString();

      return { entries, totalEarnedNgn, eligibleThisWeek, weeklyVolumeNgn, nextThursdayIso };
    } catch {
      return { entries: [], totalEarnedNgn: 0, eligibleThisWeek: false, weeklyVolumeNgn: 0, nextThursdayIso: "" };
    }
  });
