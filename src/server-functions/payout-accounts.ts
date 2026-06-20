import { createServerFn } from "@tanstack/react-start";
import { getServerSupabase } from "../lib/supabase.server";

// ─── List payout accounts ──────────────────────────────────────────────────────
export const listPayoutAccounts = createServerFn({ method: "GET" })
  .validator((d: { userId: string }) => d)
  .handler(async ({ data }) => {
    const db = getServerSupabase();
    const { data: rows, error } = await db
      .from("payout_accounts")
      .select("*")
      .eq("user_id", data.userId)
      .order("is_default", { ascending: false })
      .order("created_at", { ascending: false });
    if (error) throw error;
    return rows ?? [];
  });

// ─── Lookup bank account name via Squadco ─────────────────────────────────────
export const lookupAccount = createServerFn({ method: "POST" })
  .validator((d: { bankCode: string; accountNumber: string }) => d)
  .handler(async ({ data }) => {
    try {
      const { lookupBankAccount } = await import("../lib/squadco");
      const result = await lookupBankAccount({
        bankCode: data.bankCode,
        accountNumber: data.accountNumber,
      });
      return { success: true, accountName: result.account_name };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);

      // Demo mode — Squadco not yet configured
      if (msg.includes("not configured")) {
        return {
          success: true,
          demo: true,
          accountName: "Demo Account Holder",
        };
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
    userId: string;
    bankCode: string;
    bankName: string;
    accountNumber: string;
    accountName: string;
    makeDefault: boolean;
  }) => d)
  .handler(async ({ data }) => {
    const db = getServerSupabase();

    // If making default, unset all existing defaults first
    if (data.makeDefault) {
      await db
        .from("payout_accounts")
        .update({ is_default: false })
        .eq("user_id", data.userId);
    }

    // Check we don't already have this account
    const { data: existing } = await db
      .from("payout_accounts")
      .select("id")
      .eq("user_id", data.userId)
      .eq("bank_code", data.bankCode)
      .eq("account_number", data.accountNumber)
      .maybeSingle();

    if (existing) {
      return { success: false, error: "This account is already saved." };
    }

    // Check 5-account limit
    const { count } = await db
      .from("payout_accounts")
      .select("id", { count: "exact", head: true })
      .eq("user_id", data.userId);

    if ((count ?? 0) >= 5) {
      return { success: false, error: "You can save up to 5 payout accounts." };
    }

    const { error } = await db.from("payout_accounts").insert({
      user_id: data.userId,
      bank_name: data.bankName,
      bank_code: data.bankCode,
      account_number: data.accountNumber,
      account_name: data.accountName,
      is_default: data.makeDefault || (count ?? 0) === 0, // auto-default if first
    });

    if (error) throw error;
    return { success: true };
  });

// ─── Set account as default ────────────────────────────────────────────────────
export const setDefaultAccount = createServerFn({ method: "POST" })
  .validator((d: { userId: string; accountId: string }) => d)
  .handler(async ({ data }) => {
    const db = getServerSupabase();
    await db
      .from("payout_accounts")
      .update({ is_default: false })
      .eq("user_id", data.userId);
    await db
      .from("payout_accounts")
      .update({ is_default: true })
      .eq("id", data.accountId);
    return { success: true };
  });

// ─── Delete payout account ────────────────────────────────────────────────────
export const deletePayoutAccount = createServerFn({ method: "POST" })
  .validator((d: { userId: string; accountId: string }) => d)
  .handler(async ({ data }) => {
    const db = getServerSupabase();
    const { error } = await db
      .from("payout_accounts")
      .delete()
      .eq("id", data.accountId)
      .eq("user_id", data.userId); // safety: must own it
    if (error) throw error;
    return { success: true };
  });
