// ─────────────────────────────────────────────────────────────────────────────
// Fraud Reserve Engine — Production Safety Layer
//
// The fraud reserve is a ring-fenced pool of capital set aside to absorb
// confirmed fraud losses WITHOUT touching the operating treasury.
//
// Every confirmed fraud event (vendor deposit forfeiture, chargeback, etc.)
// debits the fraud reserve first. If the reserve falls below a warning
// threshold, an admin alert is fired so the reserve can be topped up before
// it is depleted.
//
// DB tables:
//   fraud_reserve_events — immutable ledger (debit / credit)
//   fraud_reserve_balance — single-row materialized balance (updated atomically)
//
// Usage:
//   await deductFraudReserve(db, tradeId, amountNgn, "vendor_forfeiture");
//   await creditFraudReserve(db, amountNgn, "monthly_allocation");
//   const health = await checkFraudReserveHealth(db);
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from "@supabase/supabase-js";
import { sendAdminBotMessage } from "./telegram";

// ─── Thresholds ───────────────────────────────────────────────────────────────
/** Alert when reserve drops below this fraction of the 30-day rolling loss avg × 3 */
const WARNING_MONTHS_COVERAGE = 1; // must cover at least 1 month of avg losses
const CRITICAL_NGN             = 100_000; // ₦100K hard minimum

export type ReserveEventType = "debit" | "credit";
export type ReserveEventReason =
  | "vendor_forfeiture"
  | "chargeback"
  | "manual_write_off"
  | "monthly_allocation"
  | "manual_credit"
  | "reconciliation_adjustment";

export interface FraudReserveEvent {
  id:          string;
  type:        ReserveEventType;
  amount_ngn:  number;
  reason:      ReserveEventReason;
  reference:   string | null;  // trade_id or other ref
  admin_id:    string | null;
  created_at:  string;
  balance_after_ngn: number;
}

export interface FraudReserveHealth {
  balanceNgn:    number;
  status:        "healthy" | "warning" | "critical";
  coverageMonths: number;  // how many months of avg loss the reserve covers
  avgMonthlyLossNgn: number;
  lastEventAt:   string | null;
}

// ─── Internal: get or create the balance row ──────────────────────────────────
async function getCurrentBalance(db: SupabaseClient): Promise<number> {
  const { data } = await db
    .from("fraud_reserve_balance")
    .select("balance_ngn")
    .eq("id", 1)
    .single();
  return Number(data?.balance_ngn ?? 0);
}

async function updateBalance(
  db: SupabaseClient,
  delta: number, // positive = credit, negative = debit
): Promise<number> {
  const { data, error } = await db.rpc("adjust_fraud_reserve", { p_delta: delta });
  if (error) throw new Error(`Fraud reserve balance update failed: ${error.message}`);
  return Number(data ?? 0);
}

// ─── Deduct from fraud reserve ─────────────────────────────────────────────────
export async function deductFraudReserve(
  db:        SupabaseClient,
  reference: string,
  amountNgn: number,
  reason:    ReserveEventReason,
  adminId?:  string,
): Promise<number> {
  const balanceAfter = await updateBalance(db, -amountNgn);

  await db.from("fraud_reserve_events").insert({
    type:              "debit",
    amount_ngn:        amountNgn,
    reason,
    reference,
    admin_id:          adminId ?? null,
    balance_after_ngn: balanceAfter,
  });

  // Fire alert if balance is critically low
  const health = await checkFraudReserveHealth(db);
  if (health.status === "critical") {
    sendAdminBotMessage(
      `🚨 *FRAUD RESERVE CRITICAL*\n\n` +
      `Balance: ₦${balanceAfter.toLocaleString()}\n` +
      `Last deduction: ₦${amountNgn.toLocaleString()} (${reason})\n` +
      `Reference: ${reference}\n\n` +
      `_Reserve must be topped up immediately to protect treasury._`
    ).catch(() => {});
  } else if (health.status === "warning") {
    sendAdminBotMessage(
      `⚠️ *Fraud Reserve Low*\n\n` +
      `Balance: ₦${balanceAfter.toLocaleString()}\n` +
      `Coverage: ${health.coverageMonths.toFixed(1)} months\n` +
      `Last deduction: ₦${amountNgn.toLocaleString()} (${reason})`
    ).catch(() => {});
  }

  return balanceAfter;
}

// ─── Credit to fraud reserve ──────────────────────────────────────────────────
export async function creditFraudReserve(
  db:        SupabaseClient,
  amountNgn: number,
  reason:    ReserveEventReason,
  adminId?:  string,
  reference?: string,
): Promise<number> {
  const balanceAfter = await updateBalance(db, amountNgn);

  await db.from("fraud_reserve_events").insert({
    type:              "credit",
    amount_ngn:        amountNgn,
    reason,
    reference:         reference ?? null,
    admin_id:          adminId ?? null,
    balance_after_ngn: balanceAfter,
  });

  return balanceAfter;
}

// ─── Health check ─────────────────────────────────────────────────────────────
export async function checkFraudReserveHealth(db: SupabaseClient): Promise<FraudReserveHealth> {
  const [balance, { data: lossRows }, { data: lastEvent }] = await Promise.all([
    getCurrentBalance(db),
    db.from("fraud_reserve_events")
      .select("amount_ngn")
      .eq("type", "debit")
      .gte("created_at", new Date(Date.now() - 90 * 86_400_000).toISOString()),
    db.from("fraud_reserve_events")
      .select("created_at")
      .order("created_at", { ascending: false })
      .limit(1)
      .single()
      .catch(() => ({ data: null })),
  ]);

  const totalLoss90d  = (lossRows ?? []).reduce((s, r) => s + Number(r.amount_ngn), 0);
  const avgMonthlyLoss = totalLoss90d / 3;  // 3 months
  const coverageMonths = avgMonthlyLoss > 0
    ? balance / avgMonthlyLoss
    : balance > CRITICAL_NGN ? 12 : 0;

  let status: "healthy" | "warning" | "critical" = "healthy";
  if (balance <= CRITICAL_NGN) {
    status = "critical";
  } else if (coverageMonths < WARNING_MONTHS_COVERAGE) {
    status = "warning";
  }

  return {
    balanceNgn:       balance,
    status,
    coverageMonths,
    avgMonthlyLossNgn: avgMonthlyLoss,
    lastEventAt:      (lastEvent as { created_at?: string } | null)?.created_at ?? null,
  };
}

// ─── Get reserve balance (lightweight, for dashboards) ────────────────────────
export async function getFraudReserveBalance(db: SupabaseClient): Promise<number> {
  return getCurrentBalance(db);
}
