// ─────────────────────────────────────────────────────────────────────────────
// WalletService — SOLE authority for modifying user wallet balances.
//
// ARCHITECTURE RULE:
//   Every module that needs to change a user's wallet balance (trades, payouts,
//   referrals, premium rewards, weekly commissions, admin adjustments, treasury)
//   MUST go through this service. No module may call `db.rpc("increment_wallet_balance")`
//   or write to the `wallets` table directly.
//
// This centralises:
//   • Balance validation (non-negative, sufficient funds)
//   • Ledger creation (every change is recorded)
//   • Audit logging (who changed what, why, with what reference)
//   • Idempotency (duplicate operations are detected and skipped)
//   • Financial locking (withdrawal lock/unlock lifecycle)
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from "@supabase/supabase-js";

// ─── Shared option types ──────────────────────────────────────────────────────

export interface WalletCreditOptions {
  userId:         string;
  currency?:      string;       // default: "NGN"
  amountNgn:      number;
  refType:        string;       // e.g. "trade_payout" | "admin_credit" | "referral_commission" | "weekly_commission"
  refId?:         string;       // e.g. trade ID, commission ID
  description?:   string;
  idempotencyKey?: string;      // if supplied, duplicate calls are skipped safely
}

export interface WalletDebitOptions {
  userId:         string;
  currency?:      string;
  amountNgn:      number;
  refType:        string;       // e.g. "withdrawal" | "fee" | "admin_debit"
  refId?:         string;
  description?:   string;
  idempotencyKey?: string;
}

export interface WalletLockOptions {
  userId:    string;
  amountNgn: number;
  refId?:    string;            // withdrawal request ID
}

export interface WalletUnlockOptions {
  userId:    string;
  amountNgn: number;
  commit:    boolean;           // true = deduct permanently; false = restore to available
  refId?:    string;
}

export interface WalletResult {
  ok:          boolean;
  newBalance?: number;
  skipped?:    boolean;         // true when idempotency key matched (no-op)
  error?:      string;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

async function checkIdempotency(
  db: SupabaseClient,
  key: string,
): Promise<boolean> {
  const { data } = await db
    .from("wallet_ledger")
    .select("id")
    .eq("idempotency_key", key)
    .limit(1)
    .maybeSingle();
  return !!data; // true = already processed
}

async function getBalance(
  db: SupabaseClient,
  userId: string,
  currency = "NGN",
): Promise<number> {
  const { data } = await db
    .from("wallets")
    .select("balance")
    .eq("user_id", userId)
    .eq("currency", currency)
    .maybeSingle();
  return Number(data?.balance ?? 0);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Credit a user's wallet.
 * Atomically increments balance via the `credit_wallet` RPC (or
 * `increment_wallet_balance` fallback) and records a rich ledger entry.
 *
 * MUST be used instead of calling db.rpc("increment_wallet_balance") directly.
 */
export async function creditWallet(
  db: SupabaseClient,
  opts: WalletCreditOptions,
): Promise<WalletResult> {
  const { userId, currency = "NGN", amountNgn, refType, refId, description, idempotencyKey } = opts;

  if (!userId) return { ok: false, error: "userId is required" };
  if (amountNgn <= 0) return { ok: false, error: "Credit amount must be positive" };

  try {
    // ── Idempotency check ────────────────────────────────────────────────────
    if (idempotencyKey) {
      const alreadyDone = await checkIdempotency(db, idempotencyKey);
      if (alreadyDone) {
        const bal = await getBalance(db, userId, currency);
        return { ok: true, newBalance: bal, skipped: true };
      }
    }

    // ── Atomic balance update via RPC ────────────────────────────────────────
    // The RPC also updates the wallets.updated_at timestamp.
    const { error: rpcError } = await db.rpc("increment_wallet_balance", {
      p_user_id:  userId,
      p_currency: currency,
      p_amount:   amountNgn,
    });

    if (rpcError) {
      console.error(`[WalletService] credit failed for ${userId}:`, rpcError.message);
      return { ok: false, error: rpcError.message };
    }

    // ── Fetch new balance ────────────────────────────────────────────────────
    const newBalance = await getBalance(db, userId, currency);

    // ── Enrich the trigger-written ledger entry with context ─────────────────
    // The trg_wallet_balance_change trigger fires synchronously and inserts a
    // basic row with ref_type='system'. We update it to add rich metadata.
    // We match on user_id + currency + created_at (within last 5s) to find
    // the trigger row. Non-fatal if update fails.
    await db
      .from("wallet_ledger")
      .update({
        ref_type:        refType,
        ref_id:          refId ?? null,
        description:     description ?? null,
        idempotency_key: idempotencyKey ?? null,
      })
      .eq("user_id", userId)
      .eq("currency", currency)
      .eq("ref_type", "system")
      .gte("created_at", new Date(Date.now() - 5_000).toISOString())
      .order("created_at", { ascending: false })
      .limit(1)
      .then(() => {}) // fire-and-forget enrichment
      .catch((e: unknown) => {
        console.warn("[WalletService] ledger enrichment skipped:", e instanceof Error ? e.message : e);
      });

    console.info(`[WalletService] credited ₦${amountNgn} to ${userId} (${refType}) → balance ₦${newBalance}`);
    return { ok: true, newBalance };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[WalletService] creditWallet exception for ${userId}:`, msg);
    return { ok: false, error: msg };
  }
}

/**
 * Debit a user's wallet.
 * Atomically decrements balance via `decrement_wallet_balance` RPC.
 * Returns { ok: false, error: "Insufficient balance" } instead of throwing.
 *
 * MUST be used instead of raw wallet balance updates.
 */
export async function debitWallet(
  db: SupabaseClient,
  opts: WalletDebitOptions,
): Promise<WalletResult> {
  const { userId, currency = "NGN", amountNgn, refType, refId, description, idempotencyKey } = opts;

  if (!userId) return { ok: false, error: "userId is required" };
  if (amountNgn <= 0) return { ok: false, error: "Debit amount must be positive" };

  try {
    // ── Idempotency check ────────────────────────────────────────────────────
    if (idempotencyKey) {
      const alreadyDone = await checkIdempotency(db, idempotencyKey);
      if (alreadyDone) {
        const bal = await getBalance(db, userId, currency);
        return { ok: true, newBalance: bal, skipped: true };
      }
    }

    // ── Balance pre-check (optimistic; RPC is the authoritative gate) ────────
    const currentBalance = await getBalance(db, userId, currency);
    if (currentBalance < amountNgn) {
      return {
        ok: false,
        error: `Insufficient balance. Available: ₦${currentBalance.toLocaleString()}`,
      };
    }

    // ── Atomic balance decrement via RPC ─────────────────────────────────────
    const { error: rpcError } = await db.rpc("decrement_wallet_balance", {
      p_user_id:  userId,
      p_currency: currency,
      p_amount:   amountNgn,
    });

    if (rpcError) {
      console.error(`[WalletService] debit failed for ${userId}:`, rpcError.message);
      // Common failure: insufficient_balance raised by RPC
      if (rpcError.message?.includes("Insufficient")) {
        return { ok: false, error: `Insufficient balance` };
      }
      return { ok: false, error: rpcError.message };
    }

    const newBalance = await getBalance(db, userId, currency);

    // ── Enrich trigger ledger entry ──────────────────────────────────────────
    await db
      .from("wallet_ledger")
      .update({
        ref_type:        refType,
        ref_id:          refId ?? null,
        description:     description ?? null,
        idempotency_key: idempotencyKey ?? null,
      })
      .eq("user_id", userId)
      .eq("currency", currency)
      .eq("ref_type", "system")
      .gte("created_at", new Date(Date.now() - 5_000).toISOString())
      .order("created_at", { ascending: false })
      .limit(1)
      .then(() => {})
      .catch(() => {});

    console.info(`[WalletService] debited ₦${amountNgn} from ${userId} (${refType}) → balance ₦${newBalance}`);
    return { ok: true, newBalance };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[WalletService] debitWallet exception for ${userId}:`, msg);
    return { ok: false, error: msg };
  }
}

/**
 * Lock funds for a pending withdrawal.
 * Moves `amountNgn` from `balance` → `locked_balance` atomically.
 * The amount is NOT yet gone — it returns if the withdrawal fails/is cancelled.
 */
export async function lockForWithdrawal(
  db: SupabaseClient,
  opts: WalletLockOptions,
): Promise<WalletResult> {
  const { userId, amountNgn, refId } = opts;

  if (!userId) return { ok: false, error: "userId is required" };
  if (amountNgn <= 0) return { ok: false, error: "Lock amount must be positive" };

  try {
    const { error } = await db.rpc("lock_wallet_for_withdrawal", {
      p_user_id: userId,
      p_amount:  amountNgn,
    });

    if (error) {
      console.error(`[WalletService] lockForWithdrawal failed for ${userId}:`, error.message);
      if (error.message?.includes("Insufficient")) {
        return { ok: false, error: "Insufficient balance to lock" };
      }
      return { ok: false, error: error.message };
    }

    const newBalance = await getBalance(db, userId, "NGN");
    console.info(`[WalletService] locked ₦${amountNgn} for withdrawal ${refId ?? "?"} user ${userId}`);
    return { ok: true, newBalance };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[WalletService] lockForWithdrawal exception:`, msg);
    return { ok: false, error: msg };
  }
}

/**
 * Commit or reverse a withdrawal lock.
 *   commit = true  → deduct locked_balance permanently (withdrawal succeeded)
 *   commit = false → restore locked_balance → available balance (withdrawal failed/cancelled)
 */
export async function unlockWithdrawal(
  db: SupabaseClient,
  opts: WalletUnlockOptions,
): Promise<WalletResult> {
  const { userId, amountNgn, commit, refId } = opts;

  if (!userId) return { ok: false, error: "userId is required" };
  if (amountNgn <= 0) return { ok: false, error: "Unlock amount must be positive" };

  try {
    const { error } = await db.rpc("unlock_wallet_withdrawal", {
      p_user_id:   userId,
      p_amount:    amountNgn,
      p_completed: commit,
    });

    if (error) {
      console.error(`[WalletService] unlockWithdrawal failed for ${userId}:`, error.message);
      return { ok: false, error: error.message };
    }

    const newBalance = await getBalance(db, userId, "NGN");
    const action = commit ? "committed" : "reversed";
    console.info(`[WalletService] withdrawal ${action} ₦${amountNgn} for ${refId ?? "?"} user ${userId}`);
    return { ok: true, newBalance };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[WalletService] unlockWithdrawal exception:`, msg);
    return { ok: false, error: msg };
  }
}

/**
 * Read a user's current wallet balance without modifying it.
 */
export async function readBalance(
  db: SupabaseClient,
  userId: string,
  currency = "NGN",
): Promise<number> {
  return getBalance(db, userId, currency);
}

// ─── Convenience re-export as a namespace object ──────────────────────────────
// Callers can import { WalletService } and use WalletService.credit(db, opts)
// which makes the intent explicit and grep-able.
export const WalletService = {
  credit:            creditWallet,
  debit:             debitWallet,
  lockForWithdrawal,
  unlockWithdrawal,
  readBalance,
} as const;
