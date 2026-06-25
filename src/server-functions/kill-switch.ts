// ─────────────────────────────────────────────────────────────────────────────
// Kill Switch Server Functions — Production Safety Layer
//
// All writes require super_admin.
// Reads available to all admins.
// ─────────────────────────────────────────────────────────────────────────────

import { createServerFn } from "@tanstack/react-start";
import { getServerSupabase } from "../lib/supabase.server";
import { requireAdmin, requireSuperAdmin, logAdminAction } from "../lib/auth-server";
import {
  getAllKillSwitches,
  setKillSwitch,
  KILL_SWITCHES,
  type KillSwitchKey,
} from "../lib/kill-switch";
import { checkFraudReserveHealth } from "../lib/fraud-reserve";
import { getBackupVerificationHistory } from "../lib/backup-verifier";
import { invalidateProviderScoreCache } from "../lib/provider-router";
import { sendAdminBotMessage } from "../lib/telegram";

// ─── Get all kill switch states ───────────────────────────────────────────────
export const getKillSwitchStatus = createServerFn({ method: "GET" })
  .validator((d: Record<string, never>) => d)
  .handler(async () => {
    await requireAdmin();
    const db = getServerSupabase();
    return getAllKillSwitches(db);
  });

// ─── Toggle a kill switch ─────────────────────────────────────────────────────
export const toggleKillSwitch = createServerFn({ method: "POST" })
  .validator((d: { key: string; frozen: boolean }) => d)
  .handler(async ({ data }) => {
    const adminId = await requireSuperAdmin();
    const db      = getServerSupabase();

    const validKeys = Object.values(KILL_SWITCHES) as string[];
    if (!validKeys.includes(data.key)) {
      throw new Error(`Unknown kill switch key: ${data.key}`);
    }

    await setKillSwitch(data.key as KillSwitchKey, data.frozen, adminId, db);

    // Invalidate provider score cache if a provider kill switch was toggled
    if (data.key.startsWith("kill_switch_provider_")) {
      invalidateProviderScoreCache();
    }

    await logAdminAction(
      adminId,
      data.frozen ? "kill_switch_engaged" : "kill_switch_released",
      null,
      { key: data.key, frozen: data.frozen }
    );

    // Fire admin alert for every kill switch change
    const action = data.frozen ? "🔴 ENGAGED" : "🟢 RELEASED";
    sendAdminBotMessage(
      `${action}: Kill switch \`${data.key}\`\nBy admin: ${adminId}`
    ).catch(() => {});

    return { ok: true, key: data.key, frozen: data.frozen };
  });

// ─── System safety status (for founder dashboard) ─────────────────────────────
export const getSystemSafetyStatus = createServerFn({ method: "GET" })
  .validator((d: Record<string, never>) => d)
  .handler(async () => {
    await requireAdmin();
    const db = getServerSupabase();

    const [killSwitches, fraudReserve, backupHistory, activeLocks] = await Promise.all([
      getAllKillSwitches(db),
      checkFraudReserveHealth(db),
      getBackupVerificationHistory(db, 5),
      db.from("financial_locks")
        .select("lock_key, locked_by, locked_at, expires_at")
        .gt("expires_at", new Date().toISOString())
        .catch(() => ({ data: [] as Array<{ lock_key: string; locked_by: string; locked_at: string; expires_at: string }> })),
    ]);

    const frozenSwitches = killSwitches.filter(ks => ks.frozen);
    const lastBackup     = backupHistory[0] ?? null;

    return {
      killSwitches,
      frozenCount:     frozenSwitches.length,
      fraudReserve,
      backupOk:        lastBackup?.ok ?? null,
      lastBackupCheck: lastBackup?.checked_at ?? null,
      activeLockCount: (activeLocks.data ?? []).length,
      activeLocks:     activeLocks.data ?? [],
      generatedAt:     new Date().toISOString(),
    };
  });
