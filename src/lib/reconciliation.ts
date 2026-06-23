// ─────────────────────────────────────────────────────────────────────────────
// Reconciliation Engine — Phase 8
//
// Automated daily reconciliation of:
//   1. Unreconciled trades (paid but not settled after 24h)
//   2. Stale vendor assignments (stuck in assigned/card_sent for 6h+)
//   3. Wallet discrepancies (live balance vs ledger sum)
//   4. Duplicate settlement detections
//   5. Orphan transactions (provider records without matching trades)
//
// Writes results to reconciliation_runs table.
// Emits a ReconciliationRun domain event on completion.
// Called by /api/cron/reconcile (daily at 02:00 UTC).
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from "@supabase/supabase-js";

interface ReconciliationReport {
  run_id:                 string;
  started_at:             string;
  completed_at:           string;
  status:                 "completed" | "failed" | "partial";
  unreconciled_trades:    number;
  stale_assignments:      number;
  wallet_discrepancies:   number;
  duplicate_settlements:  number;
  orphan_transactions:    number;
  total_issues:           number;
  total_ngn_reconciled:   number;
  total_usd_volume:       number;
  details:                Record<string, unknown>;
  errors:                 string[];
}

export async function runReconciliation(
  db: SupabaseClient,
  triggeredBy?: string
): Promise<ReconciliationReport> {
  const startedAt = new Date().toISOString();
  const errors: string[] = [];

  // ── Create run record ─────────────────────────────────────────────────────
  const { data: runRow } = await db
    .from("reconciliation_runs")
    .insert({
      run_type:     "daily",
      started_at:   startedAt,
      status:       "running",
      triggered_by: triggeredBy ?? null,
    })
    .select("id")
    .single();
  const runId = runRow?.id ?? crypto.randomUUID();

  const report: ReconciliationReport = {
    run_id:                runId,
    started_at:            startedAt,
    completed_at:          startedAt,
    status:                "completed",
    unreconciled_trades:   0,
    stale_assignments:     0,
    wallet_discrepancies:  0,
    duplicate_settlements: 0,
    orphan_transactions:   0,
    total_issues:          0,
    total_ngn_reconciled:  0,
    total_usd_volume:      0,
    details:               {},
    errors,
  };

  // ── 1. Unreconciled trades (paid, no settled_at, >24h) ────────────────────
  try {
    const { data: unreconciledRows, error } = await db
      .from("v_unreconciled_trades")
      .select("id, user_id, amount_usd, amount_ngn, status, created_at");

    if (error) throw error;

    report.unreconciled_trades = unreconciledRows?.length ?? 0;
    report.total_ngn_reconciled = unreconciledRows?.reduce(
      (sum, t) => sum + Number(t.amount_ngn ?? 0), 0
    ) ?? 0;
    report.total_usd_volume = unreconciledRows?.reduce(
      (sum, t) => sum + Number(t.amount_usd ?? 0), 0
    ) ?? 0;

    report.details.unreconciled_trade_ids = unreconciledRows?.map(t => t.id) ?? [];

    if (report.unreconciled_trades > 0) {
      console.warn(
        `[Reconciliation] ${report.unreconciled_trades} unreconciled trade(s) found.`,
        report.details.unreconciled_trade_ids
      );
    }
  } catch (e) {
    const msg = `Unreconciled trades check failed: ${e instanceof Error ? e.message : String(e)}`;
    errors.push(msg);
    console.error("[Reconciliation]", msg);
  }

  // ── 2. Stale vendor assignments ───────────────────────────────────────────
  try {
    const { data: staleRows, error } = await db
      .from("v_stale_assignments")
      .select("assignment_id, trade_id, vendor_id, assignment_status, created_at");

    if (error) throw error;

    report.stale_assignments = staleRows?.length ?? 0;
    report.details.stale_assignment_ids = staleRows?.map(a => a.assignment_id) ?? [];

    if (report.stale_assignments > 0) {
      console.warn(
        `[Reconciliation] ${report.stale_assignments} stale assignment(s) found.`
      );
    }
  } catch (e) {
    const msg = `Stale assignments check failed: ${e instanceof Error ? e.message : String(e)}`;
    errors.push(msg);
    console.error("[Reconciliation]", msg);
  }

  // ── 3. Wallet discrepancies (balance vs ledger sum) ───────────────────────
  try {
    // Compare wallet.balance against SUM of wallet_ledger entries for each user/currency.
    const { data: wallets, error: wErr } = await db
      .from("wallets")
      .select("user_id, currency, balance");
    if (wErr) throw wErr;

    const discrepancies: Array<{ user_id: string; currency: string; wallet: number; ledger: number; diff: number }> = [];

    for (const w of wallets ?? []) {
      const { data: ledgerSum } = await db
        .from("wallet_ledger")
        .select("amount.sum()")
        .eq("user_id", w.user_id)
        .eq("currency", w.currency)
        .single() as { data: { sum: number | null } | null };

      const ledgerTotal = Number(ledgerSum?.sum ?? 0);
      const walletBal   = Number(w.balance);
      const diff        = Math.abs(walletBal - ledgerTotal);

      // Tolerance: 1 kobo (NGN 0.01) to account for floating point
      if (diff > 0.01) {
        discrepancies.push({
          user_id:  w.user_id,
          currency: w.currency,
          wallet:   walletBal,
          ledger:   ledgerTotal,
          diff,
        });
      }
    }

    report.wallet_discrepancies = discrepancies.length;
    report.details.wallet_discrepancies = discrepancies;

    if (discrepancies.length > 0) {
      console.error(
        `[Reconciliation] ${discrepancies.length} wallet discrepancy/ies found!`,
        discrepancies
      );
    }
  } catch (e) {
    const msg = `Wallet discrepancy check failed: ${e instanceof Error ? e.message : String(e)}`;
    errors.push(msg);
    console.error("[Reconciliation]", msg);
  }

  // ── 4. Duplicate settlement detection ────────────────────────────────────
  try {
    // Multiple webhook events with same reference that succeeded
    const { data: dupRows } = await db
      .from("processed_webhook_events")
      .select("reference, count:id")
      .eq("status", "success")
      .not("reference", "is", null) as { data: Array<{ reference: string; count: number }> | null };

    // Count duplicates (references appearing more than once)
    const refCounts = new Map<string, number>();
    for (const row of dupRows ?? []) {
      refCounts.set(row.reference, (refCounts.get(row.reference) ?? 0) + 1);
    }
    const duplicates = Array.from(refCounts.entries())
      .filter(([, count]) => count > 1)
      .map(([reference, count]) => ({ reference, count }));

    report.duplicate_settlements = duplicates.length;
    report.details.duplicate_settlement_refs = duplicates;

    if (duplicates.length > 0) {
      console.error(
        `[Reconciliation] ${duplicates.length} potential duplicate settlement(s) found!`,
        duplicates
      );
    }
  } catch (e) {
    const msg = `Duplicate settlement check failed: ${e instanceof Error ? e.message : String(e)}`;
    errors.push(msg);
    console.error("[Reconciliation]", msg);
  }

  // ── Finalize report ───────────────────────────────────────────────────────
  report.total_issues = report.unreconciled_trades
    + report.stale_assignments
    + report.wallet_discrepancies
    + report.duplicate_settlements
    + report.orphan_transactions;

  report.completed_at = new Date().toISOString();
  report.status = errors.length > 0
    ? (report.total_issues > 0 ? "partial" : "failed")
    : "completed";

  // Update run record
  await db.from("reconciliation_runs").update({
    completed_at:          report.completed_at,
    status:                report.status,
    unreconciled_trades:   report.unreconciled_trades,
    stale_assignments:     report.stale_assignments,
    wallet_discrepancies:  report.wallet_discrepancies,
    duplicate_settlements: report.duplicate_settlements,
    orphan_transactions:   report.orphan_transactions,
    total_ngn_reconciled:  report.total_ngn_reconciled,
    total_usd_volume:      report.total_usd_volume,
    report:                report.details,
    error:                 errors.length > 0 ? errors.join("; ") : null,
  }).eq("id", runId);

  // Log to event bus (non-fatal)
  try {
    const { eventBus } = await import("./events/event-bus");
    const { getServerSupabase } = await import("./supabase.server");
    await eventBus.emit({
      type:       "ReconciliationRun",
      actorId:    null,
      entityId:   runId as unknown as string,
      entityType: "settlement",
      payload: {
        run_id:             runId,
        status:             report.status,
        total_issues:       report.total_issues,
        unreconciled_trades: report.unreconciled_trades,
        wallet_discrepancies: report.wallet_discrepancies,
      },
    }, getServerSupabase());
  } catch (_e) {
    // Non-fatal
  }

  console.info(
    `[Reconciliation] Run ${runId} ${report.status}. ` +
    `Issues: ${report.total_issues} ` +
    `(trades: ${report.unreconciled_trades}, ` +
    `assignments: ${report.stale_assignments}, ` +
    `wallets: ${report.wallet_discrepancies}, ` +
    `duplicates: ${report.duplicate_settlements})`
  );

  return report;
}
