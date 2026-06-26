// ─────────────────────────────────────────────────────────────────────────────
// Treasury Decision Engine Admin Server Functions — Phase 12
//
// Admin endpoints for the Treasury Decision Engine:
//   getTreasuryDecisions    — paginated list of all decisions
//   getTreasurySummaryData  — aggregate stats for mission control
//   getTreasuryDecisionDetail — single decision + full audit trail
// ─────────────────────────────────────────────────────────────────────────────

import { createServerFn }      from "@tanstack/react-start";
import { getServerSupabase }   from "../lib/supabase.server";
import { requireAdmin }        from "../lib/auth-server";
import { getTreasurySummary }  from "../lib/treasury-engine";

// ─── List all treasury decisions ──────────────────────────────────────────────
export const getTreasuryDecisions = createServerFn({ method: "GET" })
  .validator((d: {
    page?:      number;
    pageSize?:  number;
    decision?:  string;
    userId?:    string;
  }) => d)
  .handler(async ({ data }) => {
    await requireAdmin();
    const db   = getServerSupabase();

    const page = data.page ?? 0;
    const size = data.pageSize ?? 25;
    const from = page * size;
    const to   = from + size - 1;

    let q = db
      .from("treasury_decisions")
      .select(`
        id, trade_id, user_id, brand, region, amount_usd,
        decision, confidence, reason,
        trust_score, fraud_score, inventory_risk_score,
        demand_score, treasury_utilization, inventory_velocity,
        vendor_allocation_pct, treasury_allocation_pct,
        decided_at,
        profiles!inner(full_name, phone)
      `, { count: "exact" })
      .order("decided_at", { ascending: false })
      .range(from, to);

    if (data.decision) q = (q as ReturnType<typeof q.eq>).eq("decision", data.decision);
    if (data.userId)   q = (q as ReturnType<typeof q.eq>).eq("user_id", data.userId);

    const { data: rows, error, count } = await q;
    if (error) { console.error("[admin-treasury]", error.message); throw new Error(error.message); }

    return { rows: rows ?? [], total: count ?? 0, page, pageSize: size };
  });

// ─── Treasury summary for mission control ─────────────────────────────────────
export const getTreasurySummaryData = createServerFn({ method: "GET" })
  .validator((d: Record<string, never>) => d)
  .handler(async () => {
    await requireAdmin();
    const db = getServerSupabase();
    return getTreasurySummary(db);
  });

// ─── Single decision detail ────────────────────────────────────────────────────
export const getTreasuryDecisionDetail = createServerFn({ method: "GET" })
  .validator((d: { decisionId: string }) => d)
  .handler(async ({ data }) => {
    await requireAdmin();
    const db = getServerSupabase();

    const { data: decision, error } = await db
      .from("treasury_decisions")
      .select("*")
      .eq("id", data.decisionId)
      .single();

    if (error) { console.error("[admin-treasury]", error.message); throw new Error(error.message); }

    // Also fetch related ledger events
    const { data: events } = await db
      .from("event_log")
      .select("event_type, payload, occurred_at")
      .eq("entity_id", decision.trade_id)
      .order("occurred_at", { ascending: false })
      .limit(10);

    return { decision, events: events ?? [] };
  });

// ─── Treasury decisions for a specific trade ──────────────────────────────────
export const getTreasuryDecisionForTrade = createServerFn({ method: "GET" })
  .validator((d: { tradeId: string }) => d)
  .handler(async ({ data }) => {
    await requireAdmin();
    const db = getServerSupabase();

    const { data: decisions, error } = await db
      .from("treasury_decisions")
      .select("*")
      .eq("trade_id", data.tradeId)
      .order("decided_at", { ascending: false });

    if (error) { console.error("[admin-treasury]", error.message); throw new Error(error.message); }
    return decisions ?? [];
  });
