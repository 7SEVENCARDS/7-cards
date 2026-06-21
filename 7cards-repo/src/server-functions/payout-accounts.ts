import { createServerFn } from "@tanstack/react-start";
import { getServerSupabase } from "../lib/supabase.server";
import { requireUser } from "../lib/auth-server";

// ─── List own payout accounts ─────────────────────────────────────────────────
export const listPayoutAccounts = createServerFn({ method: "GET" })
  .validator((d: { userId?: string }) => d)
  .handler(async () => {
    const userId = await requireUser();
    const db = getServerSupabase();
    const { data: rows, error } = await db
      .from("payout_accounts")
      .select("*")
      .eq("user_id", userId)
      .order("is_default", { ascending: false })
      .order("created_at", { ascending: false });
    if (error) throw error;
    return rows ?? [];
  });

// ─── Lookup bank account name via Squadco ─────────────────────────────────────
// Requires auth to prevent unauthenticated abuse of the lookup endpoint.
export const lookupAccount = createServerFn({ method: "POST" })
  .validator((d: { bankCode: string; accountNumber: string }) => d)
  .handler(async ({ data }) => {
    await requireUser();
    try {
      const { lookupBankAccount } = await import("../lib/squadco");
      const result = await lookupBankAccount({
        bankCode: data.bankCode,
        accountNumber: data.accountNumber,
      });
      return { success: true, accountName: result.account_name };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);

      if (msg.includes("not configured")) {
        // Demo mode — blocked in production
        if (process.env.NODE_ENV === "production") {
          return { success: false, error: "Bank lookup service not available." };
        }
        return { success: true, demo: true, accountName: "Demo Account Holder" };
      }

      const isInvalid =
        msg.toLowerCase().includes("invalid") ||
        msg.toLowerCase().includes("not found") ||
        msg.toLowerCase().includes("does not exist");

      return {
        success: false,
        error: isInvalid
          ? "Account not found. Check the number and bank."
          : "Bank lookup temporarily unavailable. Try again shortly.",
      };
    }
  });

// ─── Add payout account ────────────────────────────────────────────────────────
export const addPayoutAccount = createServerFn({ method: "POST" })
  .validator((d: {
    bankCode: string;
    bankName: string;
    accountNumber: string;
    accountName: string;
    makeDefault: boolean;
  }) => d)
  .handler(async ({ data }) => {
    const userId = await requireUser();
    const db = getServerSupabase();

    if (data.makeDefault) {
      await db
        .from("payout_accounts")
        .update({ is_default: false })
        .eq("user_id", userId);
    }

    // Duplicate check
    const { data: existing } = await db
      .from("payout_accounts")
      .select("id")
      .eq("user_id", userId)
      .eq("bank_code", data.bankCode)
      .eq("account_number", data.accountNumber)
      .maybeSingle();

    if (existing) {
      return { success: false, error: "This account is already saved." };
    }

    // 5-account limit
    const { count } = await db
      .from("payout_accounts")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId);

    if ((count ?? 0) >= 5) {
      return { success: false, error: "You can save up to 5 payout accounts." };
    }

    const { error } = await db.from("payout_accounts").insert({
      user_id: userId,
      bank_name: data.bankName,
      bank_code: data.bankCode,
      account_number: data.accountNumber,
      account_name: data.accountName,
      is_default: data.makeDefault || (count ?? 0) === 0,
    });

    if (error) throw error;
    return { success: true };
  });

// ─── Set account as default ────────────────────────────────────────────────────
// Verifies the account being set as default belongs to the session user.
export const setDefaultAccount = createServerFn({ method: "POST" })
  .validator((d: { accountId: string }) => d)
  .handler(async ({ data }) => {
    const userId = await requireUser();
    const db = getServerSupabase();

    // Confirm ownership before any write
    const { data: account } = await db
      .from("payout_accounts")
      .select("id")
      .eq("id", data.accountId)
      .eq("user_id", userId)
      .single();

    if (!account) {
      return { success: false, error: "Account not found." };
    }

    await db
      .from("payout_accounts")
      .update({ is_default: false })
      .eq("user_id", userId);

    await db
      .from("payout_accounts")
      .update({ is_default: true })
      .eq("id", data.accountId)
      .eq("user_id", userId);

    return { success: true };
  });

// ─── Delete payout account ────────────────────────────────────────────────────
export const deletePayoutAccount = createServerFn({ method: "POST" })
  .validator((d: { accountId: string }) => d)
  .handler(async ({ data }) => {
    const userId = await requireUser();
    const db = getServerSupabase();
    const { error } = await db
      .from("payout_accounts")
      .delete()
      .eq("id", data.accountId)
      .eq("user_id", userId);
    if (error) throw error;
    return { success: true };
  });
