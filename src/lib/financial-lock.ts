// ─────────────────────────────────────────────────────────────────────────────
// Distributed Financial Locks — Production Safety Layer
//
// Prevents duplicate settlement by acquiring an exclusive lock on a resource
// (e.g. a trade ID) before executing any money-moving operation.
//
// Implementation: Supabase `financial_locks` table with TTL.
//   - INSERT OR CONFLICT returns the existing holder so the caller can detect
//     that another worker already owns the lock.
//   - A background cron (or the acquirer) removes expired rows.
//
// Usage:
//   const released = await withFinancialLock(`trade:${tradeId}`, tradeId, db, async () => {
//     // ... initiate payout ...
//   });
//
// Guarantees:
//   - If a lock for the same key is already held (and not expired), the new
//     caller receives an error — it does NOT wait or spin.
//   - TTL defaults to 5 minutes; payout ops should complete in <60 s.
//   - The lock is released in a `finally` block to survive exceptions.
//   - Two concurrent requests for the same tradeId: exactly one will succeed.
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from "@supabase/supabase-js";

const DEFAULT_TTL_MS = 5 * 60 * 1_000; // 5 minutes

export class LockConflictError extends Error {
  constructor(key: string, holder: string) {
    super(`Financial lock conflict: '${key}' is already held by '${holder}'`);
    this.name = "LockConflictError";
  }
}

/**
 * Attempts to acquire an exclusive lock on `lockKey`.
 * Returns the lock's `id` on success.
 * Throws `LockConflictError` if the key is already locked.
 */
export async function acquireFinancialLock(
  lockKey: string,
  holder:  string,
  db:      SupabaseClient,
  ttlMs:   number = DEFAULT_TTL_MS,
): Promise<string> {
  const now       = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);

  // First: sweep any expired locks for this key (best-effort, non-blocking)
  await db
    .from("financial_locks")
    .delete()
    .eq("lock_key", lockKey)
    .lt("expires_at", now.toISOString())
    .catch(() => { /* ignore cleanup errors */ });

  const { data, error } = await db
    .from("financial_locks")
    .insert({
      lock_key:   lockKey,
      locked_by:  holder,
      locked_at:  now.toISOString(),
      expires_at: expiresAt.toISOString(),
    })
    .select("id")
    .single();

  if (error) {
    // Postgres unique violation (23505) = lock already held
    if (error.code === "23505") {
      const { data: existing } = await db
        .from("financial_locks")
        .select("locked_by")
        .eq("lock_key", lockKey)
        .single();
      throw new LockConflictError(lockKey, existing?.locked_by ?? "unknown");
    }
    throw new Error(`Failed to acquire financial lock for '${lockKey}': ${error.message}`);
  }

  if (!data) throw new Error(`No lock ID returned for '${lockKey}'`);
  return data.id as string;
}

/**
 * Releases the lock for `lockKey` held by `holder`.
 * Is a no-op if the lock does not exist or is held by someone else.
 */
export async function releaseFinancialLock(
  lockKey: string,
  holder:  string,
  db:      SupabaseClient,
): Promise<void> {
  await db
    .from("financial_locks")
    .delete()
    .eq("lock_key", lockKey)
    .eq("locked_by", holder)
    .catch(() => { /* best-effort release */ });
}

/**
 * RAII wrapper: acquires a lock, runs `fn`, then releases the lock.
 * Always releases — even if `fn` throws.
 * Propagates `LockConflictError` immediately (no retrying).
 */
export async function withFinancialLock<T>(
  lockKey: string,
  holder:  string,
  db:      SupabaseClient,
  fn:      () => Promise<T>,
  ttlMs:   number = DEFAULT_TTL_MS,
): Promise<T> {
  await acquireFinancialLock(lockKey, holder, db, ttlMs);
  try {
    return await fn();
  } finally {
    await releaseFinancialLock(lockKey, holder, db);
  }
}
