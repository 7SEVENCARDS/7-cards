// ─────────────────────────────────────────────────────────────────────────────
// Feature Flag Server Functions — Phase 14
//
// Server functions for admin management of feature flags.
// All write operations require super_admin.
// Read operations available to all authenticated users.
// ─────────────────────────────────────────────────────────────────────────────

"use server";

import { requireAdmin, requireSuperAdmin } from "../lib/auth-server";
import { logAdminAction } from "../lib/auth-server";
import { getServerSupabase } from "../lib/supabase.server";
import { getAllFlags, setFlag, setFlagRollout } from "../lib/feature-flags";
import { eventBus } from "../lib/events/event-bus";

// ── List all feature flags (admin-only) ───────────────────────────────────────
export async function listFeatureFlags() {
  await requireAdmin();
  const db = getServerSupabase();
  return getAllFlags(db);
}

// ── Toggle a flag (super_admin only) ─────────────────────────────────────────
export async function toggleFeatureFlag(key: string, enabled: boolean) {
  const adminId = await requireSuperAdmin();
  const db      = getServerSupabase();

  // Get current state for event payload
  const { data: current } = await db
    .from("feature_flags")
    .select("enabled")
    .eq("key", key)
    .single();

  const oldEnabled = current?.enabled ?? false;

  await setFlag(key, enabled, adminId, db);
  await logAdminAction(adminId, enabled ? "feature_flag_enabled" : "feature_flag_disabled", null, {
    flag_key:    key,
    old_enabled: oldEnabled,
    new_enabled: enabled,
  });

  // Emit domain event
  await eventBus.emit({
    type:       "FeatureFlagChanged",
    actorId:    adminId,
    entityId:   key as unknown as string,
    entityType: "feature_flag",
    payload: {
      flag_key:    key,
      old_enabled: oldEnabled,
      new_enabled: enabled,
      changed_by:  adminId,
    },
  }, db).catch(() => {});

  return { ok: true, key, enabled };
}

// ── Update rollout percentage (super_admin only) ──────────────────────────────
export async function updateFlagRollout(key: string, rolloutPct: number) {
  const adminId = await requireSuperAdmin();
  const db      = getServerSupabase();

  await setFlagRollout(key, rolloutPct, adminId, db);
  await logAdminAction(adminId, "feature_flag_rollout_updated", null, {
    flag_key:    key,
    rollout_pct: rolloutPct,
  });

  return { ok: true, key, rollout_pct: rolloutPct };
}

// ── Get flags for current user (for client-side feature gating) ───────────────
// Returns only flag keys and their enabled state — no internal metadata.
export async function getMyFeatureFlags() {
  const db = getServerSupabase();

  const { data } = await db
    .from("feature_flags")
    .select("key, enabled, rollout_pct")
    .eq("enabled", true);

  return (data ?? []).map(f => ({ key: f.key, enabled: f.enabled }));
}
