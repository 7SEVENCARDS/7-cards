// ─────────────────────────────────────────────────────────────────────────────
// Reconciliation Server Functions — Phase 8
//
// Admin-facing server functions for triggering and viewing reconciliation runs.
// ─────────────────────────────────────────────────────────────────────────────

"use server";

import { requireAdmin } from "../lib/auth-server";
import { getServerSupabase } from "../lib/supabase.server";
import { runReconciliation } from "../lib/reconciliation";

// ── Trigger manual reconciliation (admin only) ────────────────────────────────
export async function triggerManualReconciliation() {
  const adminId = await requireAdmin();
  const db      = getServerSupabase();

  const report = await runReconciliation(db, adminId);
  return report;
}

// ── List recent reconciliation runs ──────────────────────────────────────────
export async function getReconciliationRuns(limit = 20) {
  await requireAdmin();
  const db = getServerSupabase();

  const { data, error } = await db
    .from("reconciliation_runs")
    .select(`
      id, run_type, started_at, completed_at,
      status, total_issues, unreconciled_trades, stale_assignments,
      wallet_discrepancies, duplicate_settlements,
      total_ngn_reconciled, total_usd_volume, error
    `)
    .order("started_at", { ascending: false })
    .limit(limit);

  if (error) { console.error("[reconciliation]", error.message); throw new Error(error.message); }
  return data ?? [];
}

// ── Get a specific run report ─────────────────────────────────────────────────
export async function getReconciliationReport(runId: string) {
  await requireAdmin();
  const db = getServerSupabase();

  const { data, error } = await db
    .from("reconciliation_runs")
    .select("*")
    .eq("id", runId)
    .single();

  if (error || !data) throw new Error(error?.message ?? "Run not found");
  return data;
}
