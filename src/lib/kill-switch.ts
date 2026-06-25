// ─────────────────────────────────────────────────────────────────────────────
// Treasury Kill Switch — Production Safety Layer
//
// Kill switches are feature flags with a "kill_switch_" prefix stored in the
// feature_flags table. When a kill switch is ENABLED (flag.enabled = true) it
// means the system is FROZEN/DISABLED (the switch is "thrown").
//
// Kill switch keys (see KILL_SWITCHES below):
//   kill_switch_treasury       — all treasury buys frozen
//   kill_switch_withdrawals    — all withdrawals (processPayout) frozen
//   kill_switch_provider_squad    — Squad gateway disabled
//   kill_switch_provider_reloadly — Reloadly disabled
//   kill_switch_provider_busha    — Busha disabled
//   kill_switch_new_trades     — no new trade submissions accepted
//
// Usage:
//   await assertNotKilled("kill_switch_withdrawals", db, "Withdrawals are currently frozen.");
//   const frozen = await isKillSwitchActive("kill_switch_treasury", db);
//   const all    = await getAllKillSwitches(db);
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from "@supabase/supabase-js";

// ─── Well-known kill switch keys ──────────────────────────────────────────────
export const KILL_SWITCHES = {
  TREASURY:          "kill_switch_treasury",
  WITHDRAWALS:       "kill_switch_withdrawals",
  NEW_TRADES:        "kill_switch_new_trades",
  PROVIDER_SQUAD:    "kill_switch_provider_squad",
  PROVIDER_RELOADLY: "kill_switch_provider_reloadly",
  PROVIDER_BUSHA:    "kill_switch_provider_busha",
} as const;

export type KillSwitchKey = typeof KILL_SWITCHES[keyof typeof KILL_SWITCHES];

export interface KillSwitchState {
  key:         KillSwitchKey;
  frozen:      boolean;
  label:       string;
  description: string;
  updatedAt:   string | null;
  updatedBy:   string | null;
}

const LABELS: Record<KillSwitchKey, { label: string; description: string }> = {
  kill_switch_treasury:          { label: "Treasury",        description: "Freeze all treasury-funded card buys" },
  kill_switch_withdrawals:       { label: "Withdrawals",     description: "Freeze all user withdrawal payouts" },
  kill_switch_new_trades:        { label: "New Trades",      description: "Prevent new card trade submissions" },
  kill_switch_provider_squad:    { label: "Squad Gateway",   description: "Disable Squad payment gateway" },
  kill_switch_provider_reloadly: { label: "Reloadly",        description: "Disable Reloadly gift-card network" },
  kill_switch_provider_busha:    { label: "Busha Crypto",    description: "Disable Busha crypto gateway" },
};

// ─── Per-isolate cache (30 s TTL — same as feature-flags) ─────────────────────
let cache:   Map<string, boolean> | null = null;
let cacheTs: number = 0;
const CACHE_TTL_MS = 30_000;

async function loadCache(db: SupabaseClient): Promise<Map<string, boolean>> {
  const now = Date.now();
  if (cache && now - cacheTs < CACHE_TTL_MS) return cache;

  const { data } = await db
    .from("feature_flags")
    .select("key, enabled")
    .like("key", "kill_switch_%");

  const map = new Map<string, boolean>();
  for (const row of data ?? []) {
    map.set(row.key, row.enabled === true);
  }
  cache   = map;
  cacheTs = now;
  return map;
}

function invalidateCache() {
  cache   = null;
  cacheTs = 0;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Returns true when the kill switch is THROWN (system is frozen). */
export async function isKillSwitchActive(key: KillSwitchKey, db: SupabaseClient): Promise<boolean> {
  const map = await loadCache(db);
  return map.get(key) === true;
}

/**
 * Throws an error with `message` when the kill switch is active.
 * Use at the top of any money-moving server function.
 */
export async function assertNotKilled(
  key: KillSwitchKey,
  db: SupabaseClient,
  message = "This operation is temporarily unavailable. Please try again later."
): Promise<void> {
  const frozen = await isKillSwitchActive(key, db);
  if (frozen) throw new Error(message);
}

/** Returns full state for every known kill switch. */
export async function getAllKillSwitches(db: SupabaseClient): Promise<KillSwitchState[]> {
  const { data } = await db
    .from("feature_flags")
    .select("key, enabled, updated_at, updated_by")
    .like("key", "kill_switch_%");

  const byKey = new Map<string, { enabled: boolean; updated_at: string; updated_by: string | null }>();
  for (const row of data ?? []) {
    byKey.set(row.key, row);
  }

  return Object.values(KILL_SWITCHES).map(key => {
    const row    = byKey.get(key);
    const meta   = LABELS[key];
    return {
      key,
      frozen:      row?.enabled === true,
      label:       meta.label,
      description: meta.description,
      updatedAt:   row?.updated_at ?? null,
      updatedBy:   row?.updated_by ?? null,
    };
  });
}

/**
 * Toggle a kill switch ON (frozen) or OFF (active).
 * Requires an adminId for the audit trail.
 * Automatically invalidates the local cache.
 */
export async function setKillSwitch(
  key: KillSwitchKey,
  frozen: boolean,
  adminId: string,
  db: SupabaseClient
): Promise<void> {
  const { error } = await db
    .from("feature_flags")
    .upsert({
      key,
      enabled:     frozen,
      description: LABELS[key]?.description ?? key,
      updated_at:  new Date().toISOString(),
      updated_by:  adminId,
      rollout_pct: 100,
      metadata:    { is_kill_switch: true },
    }, { onConflict: "key" });

  if (error) throw new Error(`Failed to set kill switch ${key}: ${error.message}`);
  invalidateCache();
}
