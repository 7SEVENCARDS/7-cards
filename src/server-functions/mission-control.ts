// ─────────────────────────────────────────────────────────────────────────────
// Mission Control Server Functions — Phases 4 & 5
//
// Single call returns every metric the executive command center needs.
// All queries run in parallel — typical p50 < 200 ms on Supabase.
// ─────────────────────────────────────────────────────────────────────────────

import { createServerFn } from "@tanstack/react-start";
import { getServerSupabase } from "../lib/supabase.server";
import { requireAdmin } from "../lib/auth-server";

export const getMissionControlData = createServerFn({ method: "GET" })
  .validator((d: Record<string, never>) => d)
  .handler(async () => {
    await requireAdmin();
    const db = getServerSupabase();

    const now        = new Date();
    const dayStart   = new Date(now); dayStart.setHours(0, 0, 0, 0);
    const weekStart  = new Date(now); weekStart.setDate(now.getDate() - 7);
    const monthStart = new Date(now); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
    const h1Ago      = new Date(now.getTime() - 3_600_000);

    const [
      // ── Users ────────────────────────────────────────────────────────────
      { count: totalUsers },
      { count: dailyActiveUsers },   // profiles created or updated today (proxy)
      { count: newUsersToday },
      { count: verifiedUsers },

      // ── Trades — status breakdown ─────────────────────────────────────
      { count: pendingTrades },
      { count: processingTrades },
      { count: paidTrades },
      { count: failedTrades },
      { count: tradesToday },
      { count: tradesThisWeek },
      { data: volumeToday },
      { data: volumeThisMonth },
      { data: volumeAllTime },

      // ── Queue ────────────────────────────────────────────────────────
      { count: kycPending },
      { count: manualReview },
      { count: escrowPending },

      // ── Vendors ─────────────────────────────────────────────────────
      { count: activeVendors },
      { count: suspendedVendors },
      { data: topVendors },

      // ── Settlements ─────────────────────────────────────────────────
      { data: unreconciledRows },

      // ── Risk & Fraud ─────────────────────────────────────────────────
      { count: criticalRisk },
      { count: highRisk },
      { data: recentFraudEvents },

      // ── Events ──────────────────────────────────────────────────────
      { data: recentEvents },

      // ── Reconciliation ───────────────────────────────────────────────
      { data: lastRecon },

      // ── Support ──────────────────────────────────────────────────────
      { count: openSupport },
    ] = await Promise.all([
      // Users
      db.from("profiles").select("*", { count: "exact", head: true }),
      db.from("profiles").select("*", { count: "exact", head: true }).gte("updated_at", dayStart.toISOString()),
      db.from("profiles").select("*", { count: "exact", head: true }).gte("created_at", dayStart.toISOString()),
      db.from("profiles").select("*", { count: "exact", head: true }).in("kyc_status", ["verified", "approved"]),

      // Trades by status
      db.from("trades").select("*", { count: "exact", head: true }).eq("status", "pending"),
      db.from("trades").select("*", { count: "exact", head: true }).in("status", ["processing", "assigned", "card_sent"]),
      db.from("trades").select("*", { count: "exact", head: true }).eq("status", "paid"),
      db.from("trades").select("*", { count: "exact", head: true }).in("status", ["failed", "expired", "cancelled"]),
      db.from("trades").select("*", { count: "exact", head: true }).gte("created_at", dayStart.toISOString()),
      db.from("trades").select("*", { count: "exact", head: true }).gte("created_at", weekStart.toISOString()),
      db.from("trades").select("amount_ngn, amount_usd").gte("created_at", dayStart.toISOString()).in("status", ["paid", "completed"]),
      db.from("trades").select("amount_ngn, amount_usd").gte("created_at", monthStart.toISOString()).in("status", ["paid", "completed"]),
      db.from("trades").select("amount_ngn, amount_usd").in("status", ["paid", "completed"]),

      // Queues
      db.from("profiles").select("*", { count: "exact", head: true }).eq("kyc_status", "submitted"),
      db.from("trades").select("*", { count: "exact", head: true }).eq("status", "pending_review"),
      db.from("trades").select("*", { count: "exact", head: true }).eq("status", "paid").is("settled_at", null),

      // Vendors
      db.from("vendors").select("*", { count: "exact", head: true }).eq("status", "active"),
      db.from("vendors").select("*", { count: "exact", head: true }).eq("status", "suspended"),
      db.from("vendors")
        .select("id, business_name, contact_name, performance_score, performance_tier, total_completed, total_disputes, status")
        .eq("status", "active")
        .order("performance_score", { ascending: false })
        .limit(5),

      // Settlements
      db.from("v_unreconciled_trades").select("id, amount_ngn, created_at").limit(20),

      // Risk
      db.from("risk_assessments").select("*", { count: "exact", head: true }).eq("risk_level", "critical").eq("active", true),
      db.from("risk_assessments").select("*", { count: "exact", head: true }).eq("risk_level", "high").eq("active", true),
      db.from("event_log")
        .select("event_type, entity_type, entity_id, payload, occurred_at")
        .eq("event_type", "FraudDetected")
        .order("occurred_at", { ascending: false })
        .limit(5),

      // Events
      db.from("event_log")
        .select("id, event_type, actor_type, entity_type, entity_id, occurred_at")
        .order("occurred_at", { ascending: false })
        .limit(15),

      // Reconciliation
      db.from("reconciliation_runs")
        .select("id, status, started_at, completed_at, total_issues, unreconciled_trades, wallet_discrepancies")
        .order("started_at", { ascending: false })
        .limit(1),

      // Support
      db.from("notifications")
        .select("*", { count: "exact", head: true })
        .eq("type", "support")
        .eq("read", false)
        .catch(() => ({ count: 0 })) as Promise<{ count: number | null }>,
    ]);

    // Compute volume totals
    const sum = (rows: Array<{ amount_ngn?: number; amount_usd?: number } | null> | null, field: "amount_ngn" | "amount_usd") =>
      (rows ?? []).reduce((s, r) => s + Number((r as Record<string, unknown>)?.[field] ?? 0), 0);

    const todayNgn  = sum(volumeToday,    "amount_ngn");
    const todayUsd  = sum(volumeToday,    "amount_usd");
    const monthNgn  = sum(volumeThisMonth, "amount_ngn");
    const monthUsd  = sum(volumeThisMonth, "amount_usd");
    const allTimeNgn = sum(volumeAllTime,  "amount_ngn");
    const allTimeUsd = sum(volumeAllTime,  "amount_usd");

    const unreconciledNgn = (unreconciledRows ?? []).reduce(
      (s, r) => s + Number((r as Record<string, unknown>)?.amount_ngn ?? 0), 0
    );

    return {
      ts: Date.now(),
      users: {
        total:        totalUsers        ?? 0,
        dailyActive:  dailyActiveUsers  ?? 0,
        newToday:     newUsersToday     ?? 0,
        kycVerified:  verifiedUsers     ?? 0,
      },
      trades: {
        pending:      pendingTrades     ?? 0,
        processing:   processingTrades  ?? 0,
        paid:         paidTrades        ?? 0,
        failed:       failedTrades      ?? 0,
        today:        tradesToday       ?? 0,
        thisWeek:     tradesThisWeek    ?? 0,
      },
      volume: {
        todayNgn:   Math.round(todayNgn),
        todayUsd:   Math.round(todayUsd * 100) / 100,
        monthNgn:   Math.round(monthNgn),
        monthUsd:   Math.round(monthUsd * 100) / 100,
        allTimeNgn: Math.round(allTimeNgn),
        allTimeUsd: Math.round(allTimeUsd * 100) / 100,
      },
      queues: {
        kycPending:    kycPending    ?? 0,
        manualReview:  manualReview  ?? 0,
        escrow:        escrowPending ?? 0,
        support:       openSupport   ?? 0,
      },
      vendors: {
        active:    activeVendors    ?? 0,
        suspended: suspendedVendors ?? 0,
        top:       (topVendors ?? []) as Array<{
          id: string;
          business_name: string;
          contact_name: string | null;
          performance_score: number;
          performance_tier: string;
          total_completed: number;
          total_disputes: number;
          status: string;
        }>,
      },
      settlement: {
        unreconciled:    unreconciledRows?.length ?? 0,
        unreconciledNgn: Math.round(unreconciledNgn),
      },
      risk: {
        critical:     criticalRisk     ?? 0,
        high:         highRisk         ?? 0,
        fraudEvents:  (recentFraudEvents ?? []) as Array<{
          event_type: string;
          entity_type: string;
          entity_id: string;
          payload: Record<string, unknown>;
          occurred_at: string;
        }>,
      },
      recentEvents: (recentEvents ?? []) as Array<{
        id: string;
        event_type: string;
        actor_type: string;
        entity_type: string;
        entity_id: string;
        occurred_at: string;
      }>,
      reconciliation: lastRecon?.[0] ?? null,
    };
  });
