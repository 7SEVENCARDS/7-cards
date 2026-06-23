// ─────────────────────────────────────────────────────────────────────────────
// Feature Flags — Phase 14
//
// DB-backed feature flag system. Flags live in the feature_flags table.
// In-memory cache with 30-second TTL — flag changes propagate within 30s
// without needing a Worker restart.
//
// Usage:
//   const enabled = await isEnabled("ocr_scan", db);
//   const flag    = await getFlag("crypto_wallet", db);
//
// Admin toggle (super_admin only):
//   await setFlag("ocr_scan", true, adminUserId, db);
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from "@supabase/supabase-js";

interface FeatureFlag {
  key:           string;
  enabled:       boolean;
  description:   string | null;
  allowed_roles: string[] | null;
  rollout_pct:   number;
  metadata:      Record<string, unknown>;
  updated_at:    string;
}

// ─── In-memory cache (per isolate) ───────────────────────────────────────────
const CACHE_TTL_MS = 30_000;  // 30 seconds
let   flagCache:    Map<string, FeatureFlag> | null = null;
let   cacheTs:      number = 0;

async function loadCache(db: SupabaseClient): Promise<Map<string, FeatureFlag>> {
  const now = Date.now();
  if (flagCache && now - cacheTs < CACHE_TTL_MS) return flagCache;

  const { data, error } = await db
    .from("feature_flags")
    .select("key, enabled, description, allowed_roles, rollout_pct, metadata, updated_at");

  if (error || !data) {
    console.warn("[FeatureFlags] Failed to load flags, serving stale cache:", error?.message);
    return flagCache ?? new Map();
  }

  const map = new Map<string, FeatureFlag>();
  for (const row of data) {
    map.set(row.key, row as FeatureFlag);
  }
  flagCache = map;
  cacheTs   = now;
  return map;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function isEnabled(
  key: string,
  db: SupabaseClient,
  opts?: { role?: string; userId?: string }
): Promise<boolean> {
  const cache = await loadCache(db);
  const flag  = cache.get(key);

  if (!flag || !flag.enabled) return false;

  // Rollout percentage gate (deterministic per userId if provided)
  if (flag.rollout_pct < 100) {
    if (!opts?.userId) return false;
    // Simple deterministic bucket: hash last 2 chars of UUID as 0-99
    const bucket = parseInt(opts.userId.slice(-2), 16) % 100;
    if (bucket >= flag.rollout_pct) return false;
  }

  // Role allowlist gate
  if (flag.allowed_roles && flag.allowed_roles.length > 0) {
    if (!opts?.role || !flag.allowed_roles.includes(opts.role)) return false;
  }

  return true;
}

export async function getFlag(key: string, db: SupabaseClient): Promise<FeatureFlag | null> {
  const cache = await loadCache(db);
  return cache.get(key) ?? null;
}

export async function getAllFlags(db: SupabaseClient): Promise<FeatureFlag[]> {
  const cache = await loadCache(db);
  return Array.from(cache.values());
}

export async function setFlag(
  key: string,
  enabled: boolean,
  updatedBy: string,
  db: SupabaseClient
): Promise<void> {
  const { error } = await db
    .from("feature_flags")
    .update({ enabled, updated_at: new Date().toISOString(), updated_by: updatedBy })
    .eq("key", key);

  if (error) throw new Error(`Failed to update flag ${key}: ${error.message}`);

  // Invalidate cache immediately
  flagCache = null;
  cacheTs   = 0;
}

export async function setFlagRollout(
  key: string,
  rolloutPct: number,
  updatedBy: string,
  db: SupabaseClient
): Promise<void> {
  if (rolloutPct < 0 || rolloutPct > 100) throw new Error("rollout_pct must be 0–100");

  const { error } = await db
    .from("feature_flags")
    .update({ rollout_pct: rolloutPct, updated_at: new Date().toISOString(), updated_by: updatedBy })
    .eq("key", key);

  if (error) throw new Error(`Failed to update rollout for ${key}: ${error.message}`);
  flagCache = null;
  cacheTs   = 0;
}

// ─── Well-known flag keys (type-safe constants) ───────────────────────────────
export const FLAGS = {
  OCR_SCAN:          "ocr_scan",
  CRYPTO_WALLET:     "crypto_wallet",
  VENDOR_ANALYTICS:  "vendor_analytics",
  REFERRAL_PROGRAM:  "referral_program",
  FRANCHISE_OPS:     "franchise_ops",
  MOBILE_API_V1:     "mobile_api_v1",
  TRUST_SCORES:      "trust_scores",
  RISK_ENGINE:       "risk_engine",
  RECONCILIATION:    "reconciliation",
  EVENT_BUS:         "event_bus",
  MONO_CONNECT:      "mono_connect",
  WEEKLY_COMMISSION: "weekly_commission",
  VENDOR_BROADCAST:  "vendor_broadcast",
} as const;

export type FlagKey = typeof FLAGS[keyof typeof FLAGS];
