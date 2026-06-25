// ─────────────────────────────────────────────────────────────────────────────
// Backup Verifier — Production Safety Layer
//
// Periodically verifies that Supabase database backups are running and recent.
// Runs on the cron worker schedule (triggered externally).
//
// What it checks:
//   1. Supabase Management API: project backup schedule status
//   2. Staleness check: last backup older than BACKUP_MAX_AGE_HOURS → alert
//   3. Row-count sanity: trades, profiles tables have data → alert if zero
//   4. Records each run in backup_verification_log
//   5. Sends Telegram alert on any failure
//
// NOTE: Supabase Management API requires SUPABASE_SERVICE_ROLE_KEY + project ref.
//   If the Management API is unavailable, falls back to a DB-layer sanity check.
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from "@supabase/supabase-js";
import { sendAdminBotMessage } from "./telegram";

const BACKUP_MAX_AGE_HOURS = 25; // alert if last backup was more than 25h ago

export type BackupVerificationResult = {
  ok:              boolean;
  checkedAt:       string;
  backupStatus:    "fresh" | "stale" | "unknown";
  lastBackupAt:    string | null;
  sanityCheck:     boolean;
  sanityDetails:   string;
  alertFired:      boolean;
  errorMessage:    string | null;
};

/** Run a full backup verification cycle. Returns the verification result. */
export async function runBackupVerification(
  db: SupabaseClient,
  supabaseProjectRef?: string,
  supabaseServiceKey?: string,
): Promise<BackupVerificationResult> {
  const checkedAt    = new Date().toISOString();
  let backupStatus:   "fresh" | "stale" | "unknown" = "unknown";
  let lastBackupAt:   string | null                  = null;
  let alertFired      = false;
  let errorMessage:   string | null                  = null;
  let sanityCheck     = false;
  let sanityDetails   = "";

  // ── Step 1: Supabase Management API backup status ─────────────────────────
  if (supabaseProjectRef && supabaseServiceKey) {
    try {
      const res = await fetch(
        `https://api.supabase.com/v1/projects/${supabaseProjectRef}/database/backups`,
        {
          headers: {
            "Authorization": `Bearer ${supabaseServiceKey}`,
            "Content-Type":  "application/json",
          },
        }
      );

      if (res.ok) {
        const body = await res.json() as {
          backups?: Array<{ created_at: string; status: string }>;
          pitr_enabled?: boolean;
        };

        const backups    = body.backups ?? [];
        const lastBackup = backups
          .filter(b => b.status === "completed")
          .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];

        if (lastBackup) {
          lastBackupAt  = lastBackup.created_at;
          const ageMs   = Date.now() - new Date(lastBackup.created_at).getTime();
          const ageHrs  = ageMs / 3_600_000;
          backupStatus  = ageHrs <= BACKUP_MAX_AGE_HOURS ? "fresh" : "stale";
        } else if (body.pitr_enabled) {
          // PITR counts as always-fresh
          backupStatus = "fresh";
          lastBackupAt = checkedAt;
        }
      }
    } catch (e) {
      errorMessage = `Management API error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // ── Step 2: DB-layer sanity check ─────────────────────────────────────────
  try {
    const [
      { count: tradeCount },
      { count: profileCount },
    ] = await Promise.all([
      db.from("trades").select("*", { count: "exact", head: true }),
      db.from("profiles").select("*", { count: "exact", head: true }),
    ]);

    const tc = tradeCount ?? 0;
    const pc = profileCount ?? 0;

    sanityCheck   = tc > 0 && pc > 0;
    sanityDetails = `trades=${tc}, profiles=${pc}`;
  } catch (e) {
    sanityCheck   = false;
    sanityDetails = `DB unreachable: ${e instanceof Error ? e.message : String(e)}`;
  }

  const ok = sanityCheck && backupStatus !== "stale";

  // ── Step 3: Alert on failure ───────────────────────────────────────────────
  if (!ok) {
    const lines = [
      `🔴 *Backup Verification FAILED*`,
      ``,
      `Backup status: ${backupStatus}`,
      lastBackupAt ? `Last backup: ${lastBackupAt}` : `Last backup: unknown`,
      `DB sanity: ${sanityCheck ? "✅" : "❌"} (${sanityDetails})`,
      errorMessage ? `\nError: ${errorMessage}` : "",
    ].filter(l => l !== undefined);

    sendAdminBotMessage(lines.join("\n")).catch(() => {});
    alertFired = true;
  }

  // ── Step 4: Log to DB ─────────────────────────────────────────────────────
  await db.from("backup_verification_log").insert({
    ok,
    checked_at:     checkedAt,
    backup_status:  backupStatus,
    last_backup_at: lastBackupAt,
    sanity_ok:      sanityCheck,
    sanity_details: sanityDetails,
    alert_fired:    alertFired,
    error_message:  errorMessage,
  }).catch(() => { /* non-fatal */ });

  return {
    ok,
    checkedAt,
    backupStatus,
    lastBackupAt,
    sanityCheck,
    sanityDetails,
    alertFired,
    errorMessage,
  };
}

/** Returns the most recent verification results (for dashboards). */
export async function getBackupVerificationHistory(
  db: SupabaseClient,
  limit = 10,
): Promise<Array<{
  ok: boolean;
  checked_at: string;
  backup_status: string;
  sanity_ok: boolean;
  alert_fired: boolean;
}>> {
  const { data } = await db
    .from("backup_verification_log")
    .select("ok, checked_at, backup_status, sanity_ok, alert_fired")
    .order("checked_at", { ascending: false })
    .limit(limit);

  return data ?? [];
}
