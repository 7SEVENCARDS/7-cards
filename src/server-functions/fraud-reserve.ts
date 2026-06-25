// ─────────────────────────────────────────────────────────────────────────────
// Fraud Reserve Server Functions — Production Safety Layer
// ─────────────────────────────────────────────────────────────────────────────

import { createServerFn }    from "@tanstack/react-start";
import { getServerSupabase } from "../lib/supabase.server";
import { requireAdmin, requireSuperAdmin, logAdminAction } from "../lib/auth-server";
import {
  checkFraudReserveHealth,
  creditFraudReserve,
  deductFraudReserve,
  getFraudReserveBalance,
  type ReserveEventReason,
} from "../lib/fraud-reserve";

// ─── Get fraud reserve status ─────────────────────────────────────────────────
export const getFraudReserveStatus = createServerFn({ method: "GET" })
  .validator((d: Record<string, never>) => d)
  .handler(async () => {
    await requireAdmin();
    const db     = getServerSupabase();
    const health = await checkFraudReserveHealth(db);

    const { data: events } = await db
      .from("fraud_reserve_events")
      .select("id, type, amount_ngn, reason, reference, admin_id, created_at, balance_after_ngn")
      .order("created_at", { ascending: false })
      .limit(20);

    return {
      ...health,
      recentEvents: events ?? [],
    };
  });

// ─── Manual credit (top-up) ───────────────────────────────────────────────────
export const creditFraudReserveManual = createServerFn({ method: "POST" })
  .validator((d: { amountNgn: number; reason?: string }) => d)
  .handler(async ({ data }) => {
    const adminId = await requireSuperAdmin();
    const db      = getServerSupabase();

    if (data.amountNgn <= 0) throw new Error("Amount must be positive");
    if (data.amountNgn > 50_000_000) throw new Error("Single top-up cannot exceed ₦50M");

    const balanceAfter = await creditFraudReserve(
      db,
      data.amountNgn,
      "manual_credit" as ReserveEventReason,
      adminId,
      `manual-credit-${Date.now()}`
    );

    await logAdminAction(adminId, "fraud_reserve_credited", null, {
      amount_ngn:    data.amountNgn,
      balance_after: balanceAfter,
      reason:        data.reason ?? "manual_credit",
    });

    return { ok: true, balanceAfter };
  });

// ─── Manual debit (write-off) ─────────────────────────────────────────────────
export const deductFraudReserveManual = createServerFn({ method: "POST" })
  .validator((d: { amountNgn: number; reference: string; reason?: string }) => d)
  .handler(async ({ data }) => {
    const adminId = await requireSuperAdmin();
    const db      = getServerSupabase();

    if (data.amountNgn <= 0) throw new Error("Amount must be positive");

    const current = await getFraudReserveBalance(db);
    if (data.amountNgn > current) {
      throw new Error(`Deduction of ₦${data.amountNgn.toLocaleString()} exceeds balance of ₦${current.toLocaleString()}`);
    }

    const balanceAfter = await deductFraudReserve(
      db,
      data.reference,
      data.amountNgn,
      "manual_write_off" as ReserveEventReason,
      adminId
    );

    await logAdminAction(adminId, "fraud_reserve_debited", null, {
      amount_ngn:    data.amountNgn,
      reference:     data.reference,
      balance_after: balanceAfter,
    });

    return { ok: true, balanceAfter };
  });
