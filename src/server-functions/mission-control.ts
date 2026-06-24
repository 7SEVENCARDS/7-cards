// ─────────────────────────────────────────────────────────────────────────────
// Mission Control Server Functions
//
// Single call returns every metric the executive command center needs.
// All queries run in parallel — typical p50 < 200 ms on Supabase.
//
// Metrics returned:
//   Core: users, trades, volume, queues, vendors, settlement, risk, events,
//         reconciliation, trust, treasury, providerHealth
//   BI:   userLtv, vendorLtv, premiumConversion, fraudRate,
//         treasuryVelocity, inventoryVelocity, profitByBrand,
//         regionalPerformance
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
    const h24Ago     = new Date(now.getTime() - 86_400_000);
    const d30Ago     = new Date(now.getTime() - 30 * 86_400_000);

    // ── BATCH 1: Core operational metrics ────────────────────────────────────
    const [
      { count: totalUsers },
      { count: dailyActiveUsers },
      { count: newUsersToday },
      { count: verifiedUsers },
      { count: premiumUsers },

      { count: pendingTrades },
      { count: processingTrades },
      { count: paidTrades },
      { count: failedTrades },
      { count: tradesToday },
      { count: tradesThisWeek },
      { data: volumeToday },
      { data: volumeThisMonth },
      { data: volumeAllTime },

      { count: kycPending },
      { count: manualReview },
      { count: escrowPending },

      { count: activeVendors },
      { count: suspendedVendors },
      { data: topVendors },

      { data: unreconciledRows },

      { count: criticalRisk },
      { count: highRisk },
      { data: recentFraudEvents },
      { count: totalFraudEvents30d },

      { data: recentEvents },

      { data: lastRecon },

      { count: openSupport },

      { count: eliteTrustCount },
      { count: trustedCount },
      { count: newTrustCount },

      { count: treasuryBuyToday },
      { count: totalDecisionsToday },

      { data: providerLogs },
    ] = await Promise.all([
      // Users
      db.from("profiles").select("*", { count: "exact", head: true }),
      db.from("profiles").select("*", { count: "exact", head: true }).gte("updated_at", dayStart.toISOString()),
      db.from("profiles").select("*", { count: "exact", head: true }).gte("created_at", dayStart.toISOString()),
      db.from("profiles").select("*", { count: "exact", head: true }).in("kyc_status", ["verified", "approved"]),
      db.from("profiles").select("*", { count: "exact", head: true }).eq("premium", true)
        .catch(() => ({ count: 0 })) as Promise<{ count: number | null }>,

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
      db.from("event_log")
        .select("*", { count: "exact", head: true })
        .eq("event_type", "FraudDetected")
        .gte("occurred_at", d30Ago.toISOString())
        .catch(() => ({ count: 0 })) as Promise<{ count: number | null }>,

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

      // Trust Engine
      db.from("trust_scores").select("*", { count: "exact", head: true })
        .eq("trust_level", "Elite")
        .catch(() => ({ count: 0 })) as Promise<{ count: number | null }>,
      db.from("trust_scores").select("*", { count: "exact", head: true })
        .eq("trust_level", "Trusted")
        .catch(() => ({ count: 0 })) as Promise<{ count: number | null }>,
      db.from("trust_scores").select("*", { count: "exact", head: true })
        .eq("trust_level", "New")
        .catch(() => ({ count: 0 })) as Promise<{ count: number | null }>,

      // Treasury
      db.from("treasury_decisions").select("*", { count: "exact", head: true })
        .eq("decision", "TREASURY_BUY")
        .gte("decided_at", dayStart.toISOString())
        .catch(() => ({ count: 0 })) as Promise<{ count: number | null }>,
      db.from("treasury_decisions").select("*", { count: "exact", head: true })
        .gte("decided_at", dayStart.toISOString())
        .catch(() => ({ count: 0 })) as Promise<{ count: number | null }>,

      // Provider Health
      db.from("provider_operation_log")
        .select("provider, gateway, success, latency_ms")
        .gte("created_at", h1Ago.toISOString())
        .limit(500)
        .catch(() => ({ data: [] })) as Promise<{ data: Array<{ provider: string; gateway: string; success: boolean; latency_ms: number }> | null }>,
    ]);

    // ── BATCH 2: Business Intelligence metrics ────────────────────────────────
    const [
      { data: ltvTradesRaw },
      { data: velocityRaw },
      { data: brandProfitRaw },
      { data: regionalRaw },
      { data: treasuryVelocityRaw },
      { data: vendorWalletRaw },
    ] = await Promise.all([
      // User LTV: paid trades with user_id + amount_ngn
      db.from("trades")
        .select("user_id, amount_ngn, amount_usd")
        .eq("status", "paid")
        .not("amount_ngn", "is", null)
        .gte("created_at", d30Ago.toISOString())
        .limit(5000)
        .catch(() => ({ data: [] })) as Promise<{ data: Array<{ user_id: string; amount_ngn: number; amount_usd: number }> | null }>,

      // Inventory velocity: recent settled trades (created_at → settled_at)
      db.from("trades")
        .select("created_at, settled_at")
        .eq("status", "paid")
        .not("settled_at", "is", null)
        .order("settled_at", { ascending: false })
        .limit(500)
        .catch(() => ({ data: [] })) as Promise<{ data: Array<{ created_at: string; settled_at: string }> | null }>,

      // Profit per card type/brand
      db.from("trades")
        .select("brand, region, amount_ngn, amount_usd, exchange_rate")
        .eq("status", "paid")
        .not("brand", "is", null)
        .order("created_at", { ascending: false })
        .limit(2000)
        .catch(() => ({ data: [] })) as Promise<{ data: Array<{ brand: string; region: string | null; amount_ngn: number; amount_usd: number; exchange_rate: number }> | null }>,

      // Regional performance
      db.from("trades")
        .select("region, amount_ngn, amount_usd")
        .eq("status", "paid")
        .not("region", "is", null)
        .order("created_at", { ascending: false })
        .limit(5000)
        .catch(() => ({ data: [] })) as Promise<{ data: Array<{ region: string; amount_ngn: number; amount_usd: number }> | null }>,

      // Treasury velocity: decisions in last 24h for hourly chart
      db.from("treasury_decisions")
        .select("decided_at, decision")
        .gte("decided_at", h24Ago.toISOString())
        .order("decided_at", { ascending: true })
        .limit(1000)
        .catch(() => ({ data: [] })) as Promise<{ data: Array<{ decided_at: string; decision: string }> | null }>,

      // Vendor LTV: wallet balances (total_funded = lifetime earnings)
      db.from("vendor_wallets")
        .select("vendor_id, balance, total_funded, total_withdrawn")
        .catch(() => ({ data: [] })) as Promise<{ data: Array<{ vendor_id: string; balance: number; total_funded: number; total_withdrawn: number }> | null }>,
    ]);

    // ── Compute volume totals ─────────────────────────────────────────────────
    const sum = (rows: Array<{ amount_ngn?: number; amount_usd?: number } | null> | null, field: "amount_ngn" | "amount_usd") =>
      (rows ?? []).reduce((s, r) => s + Number((r as Record<string, unknown>)?.[field] ?? 0), 0);

    const todayNgn   = sum(volumeToday,     "amount_ngn");
    const todayUsd   = sum(volumeToday,     "amount_usd");
    const monthNgn   = sum(volumeThisMonth, "amount_ngn");
    const monthUsd   = sum(volumeThisMonth, "amount_usd");
    const allTimeNgn = sum(volumeAllTime,   "amount_ngn");
    const allTimeUsd = sum(volumeAllTime,   "amount_usd");

    const unreconciledNgn = (unreconciledRows ?? []).reduce(
      (s, r) => s + Number((r as Record<string, unknown>)?.amount_ngn ?? 0), 0
    );

    // ── User LTV ─────────────────────────────────────────────────────────────
    const ltvTrades = (ltvTradesRaw ?? []) as Array<{ user_id: string; amount_ngn: number; amount_usd: number }>;
    const perUser: Record<string, { ngn: number; usd: number; trades: number }> = {};
    for (const t of ltvTrades) {
      if (!perUser[t.user_id]) perUser[t.user_id] = { ngn: 0, usd: 0, trades: 0 };
      perUser[t.user_id].ngn    += Number(t.amount_ngn) || 0;
      perUser[t.user_id].usd    += Number(t.amount_usd) || 0;
      perUser[t.user_id].trades += 1;
    }
    const userLtvEntries = Object.values(perUser);
    const avgUserLtvNgn = userLtvEntries.length > 0
      ? Math.round(userLtvEntries.reduce((s, u) => s + u.ngn, 0) / userLtvEntries.length)
      : 0;
    const avgUserLtvUsd = userLtvEntries.length > 0
      ? Math.round((userLtvEntries.reduce((s, u) => s + u.usd, 0) / userLtvEntries.length) * 100) / 100
      : 0;
    const avgTradesPerUser = userLtvEntries.length > 0
      ? Math.round((userLtvEntries.reduce((s, u) => s + u.trades, 0) / userLtvEntries.length) * 10) / 10
      : 0;
    const activePayingUsers = userLtvEntries.length;

    // ── Vendor LTV ───────────────────────────────────────────────────────────
    const vendorWallets = (vendorWalletRaw ?? []) as Array<{ vendor_id: string; balance: number; total_funded: number; total_withdrawn: number }>;
    const vendorCount = vendorWallets.length;
    const totalVendorFunded = vendorWallets.reduce((s, v) => s + Number(v.total_funded || 0), 0);
    const avgVendorLtvNgn = vendorCount > 0 ? Math.round(totalVendorFunded / vendorCount) : 0;
    const totalVendorBalance = vendorWallets.reduce((s, v) => s + Number(v.balance || 0), 0);

    // ── Premium Conversion ────────────────────────────────────────────────────
    const premiumConversionRate = (totalUsers ?? 0) > 0
      ? Math.round(((premiumUsers ?? 0) / (totalUsers ?? 1)) * 1000) / 10
      : 0;

    // ── Fraud Rate ────────────────────────────────────────────────────────────
    const totalTradesAllTime = (paidTrades ?? 0) + (failedTrades ?? 0) + (pendingTrades ?? 0) + (processingTrades ?? 0);
    const fraudCount30d = totalFraudEvents30d ?? 0;
    const fraudRatePct = totalTradesAllTime > 0
      ? Math.round((fraudCount30d / totalTradesAllTime) * 10000) / 100
      : 0;

    // ── Inventory Velocity ────────────────────────────────────────────────────
    const velocityTrades = (velocityRaw ?? []) as Array<{ created_at: string; settled_at: string }>;
    const settlementMinutes = velocityTrades
      .filter(t => t.settled_at && t.created_at)
      .map(t => (new Date(t.settled_at).getTime() - new Date(t.created_at).getTime()) / 60_000)
      .filter(m => m > 0 && m < 10_080); // ignore > 7 days (outliers)
    const avgSettlementMinutes = settlementMinutes.length > 0
      ? Math.round(settlementMinutes.reduce((s, m) => s + m, 0) / settlementMinutes.length)
      : 0;
    const medianSettlementMinutes = (() => {
      if (!settlementMinutes.length) return 0;
      const sorted = [...settlementMinutes].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return Math.round(sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);
    })();
    const p90SettlementMinutes = (() => {
      if (!settlementMinutes.length) return 0;
      const sorted = [...settlementMinutes].sort((a, b) => a - b);
      return Math.round(sorted[Math.floor(sorted.length * 0.9)] ?? sorted[sorted.length - 1]);
    })();

    // ── Profit per card type/brand ────────────────────────────────────────────
    const brandMap: Record<string, { count: number; totalNgn: number; totalUsd: number; totalRate: number; rateCount: number }> = {};
    for (const t of (brandProfitRaw ?? []) as Array<{ brand: string; region: string | null; amount_ngn: number; amount_usd: number; exchange_rate: number }>) {
      if (!t.brand) continue;
      if (!brandMap[t.brand]) brandMap[t.brand] = { count: 0, totalNgn: 0, totalUsd: 0, totalRate: 0, rateCount: 0 };
      brandMap[t.brand].count++;
      brandMap[t.brand].totalNgn += Number(t.amount_ngn) || 0;
      brandMap[t.brand].totalUsd += Number(t.amount_usd) || 0;
      if (t.exchange_rate) {
        brandMap[t.brand].totalRate  += Number(t.exchange_rate);
        brandMap[t.brand].rateCount++;
      }
    }
    const profitByBrand = Object.entries(brandMap)
      .sort(([, a], [, b]) => b.totalNgn - a.totalNgn)
      .slice(0, 10)
      .map(([brand, v]) => ({
        brand,
        count:      v.count,
        totalNgn:   Math.round(v.totalNgn),
        totalUsd:   Math.round(v.totalUsd * 100) / 100,
        avgRateNgn: v.rateCount > 0 ? Math.round(v.totalRate / v.rateCount) : 0,
        avgNgnPerTrade: Math.round(v.totalNgn / v.count),
      }));

    // ── Regional performance ──────────────────────────────────────────────────
    const regionMap: Record<string, { count: number; totalNgn: number; totalUsd: number }> = {};
    for (const t of (regionalRaw ?? []) as Array<{ region: string; amount_ngn: number; amount_usd: number }>) {
      const r = t.region || "Unknown";
      if (!regionMap[r]) regionMap[r] = { count: 0, totalNgn: 0, totalUsd: 0 };
      regionMap[r].count++;
      regionMap[r].totalNgn += Number(t.amount_ngn) || 0;
      regionMap[r].totalUsd += Number(t.amount_usd) || 0;
    }
    const regionalPerformance = Object.entries(regionMap)
      .sort(([, a], [, b]) => b.totalNgn - a.totalNgn)
      .map(([region, v]) => ({
        region,
        count:    v.count,
        totalNgn: Math.round(v.totalNgn),
        totalUsd: Math.round(v.totalUsd * 100) / 100,
        sharePct: 0, // computed below
      }));
    const regionalTotal = regionalPerformance.reduce((s, r) => s + r.count, 0);
    for (const r of regionalPerformance) {
      r.sharePct = regionalTotal > 0 ? Math.round((r.count / regionalTotal) * 1000) / 10 : 0;
    }

    // ── Treasury velocity ─────────────────────────────────────────────────────
    const tvDecisions = (treasuryVelocityRaw ?? []) as Array<{ decided_at: string; decision: string }>;
    const hourlyVelocity: Record<string, { buy: number; route: number; total: number }> = {};
    for (const d of tvDecisions) {
      const hour = d.decided_at.slice(0, 13) + ":00"; // e.g. "2024-06-24T14:00"
      if (!hourlyVelocity[hour]) hourlyVelocity[hour] = { buy: 0, route: 0, total: 0 };
      hourlyVelocity[hour].total++;
      if (d.decision === "TREASURY_BUY") hourlyVelocity[hour].buy++;
      else hourlyVelocity[hour].route++;
    }
    const treasuryVelocity = Object.entries(hourlyVelocity)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([hour, v]) => ({ hour: hour.slice(11, 16), ...v })); // "14:00"
    const avgDecisionsPerHour = tvDecisions.length > 0
      ? Math.round((tvDecisions.length / 24) * 10) / 10
      : 0;
    const buyRate24h = tvDecisions.length > 0
      ? Math.round((tvDecisions.filter(d => d.decision === "TREASURY_BUY").length / tvDecisions.length) * 1000) / 10
      : 0;

    // ── Provider health ───────────────────────────────────────────────────────
    const providerHealth = (() => {
      const logs = (providerLogs ?? []) as Array<{ provider: string; gateway: string; success: boolean; latency_ms: number }>;
      const grouped: Record<string, { success: number; total: number; latencies: number[] }> = {};
      for (const l of logs) {
        if (!grouped[l.provider]) grouped[l.provider] = { success: 0, total: 0, latencies: [] };
        grouped[l.provider].total++;
        if (l.success) grouped[l.provider].success++;
        if (l.latency_ms) grouped[l.provider].latencies.push(l.latency_ms);
      }
      return Object.entries(grouped).map(([provider, s]) => ({
        provider,
        successRate: Math.round((s.success / s.total) * 100),
        totalCalls:  s.total,
        avgLatencyMs: s.latencies.length > 0 ? Math.round(s.latencies.reduce((a, b) => a + b, 0) / s.latencies.length) : 0,
        status: (s.success / s.total) >= 0.9 ? "healthy" : (s.success / s.total) >= 0.7 ? "degraded" : "down",
      }));
    })();

    return {
      ts: Date.now(),

      users: {
        total:        totalUsers       ?? 0,
        dailyActive:  dailyActiveUsers ?? 0,
        newToday:     newUsersToday    ?? 0,
        kycVerified:  verifiedUsers    ?? 0,
        premium:      premiumUsers     ?? 0,
      },
      trades: {
        pending:    pendingTrades    ?? 0,
        processing: processingTrades ?? 0,
        paid:       paidTrades       ?? 0,
        failed:     failedTrades     ?? 0,
        today:      tradesToday      ?? 0,
        thisWeek:   tradesThisWeek   ?? 0,
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
        kycPending:   kycPending    ?? 0,
        manualReview: manualReview  ?? 0,
        escrow:       escrowPending ?? 0,
        support:      openSupport   ?? 0,
      },
      vendors: {
        active:    activeVendors    ?? 0,
        suspended: suspendedVendors ?? 0,
        top: (topVendors ?? []) as Array<{
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
        critical:    criticalRisk    ?? 0,
        high:        highRisk        ?? 0,
        fraudEvents: (recentFraudEvents ?? []) as Array<{
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
      trust: {
        elite:    eliteTrustCount ?? 0,
        trusted:  trustedCount    ?? 0,
        newUsers: newTrustCount   ?? 0,
        total:    (eliteTrustCount ?? 0) + (trustedCount ?? 0) + (newTrustCount ?? 0),
      },
      treasury: {
        buyDecisionsToday:   treasuryBuyToday     ?? 0,
        totalDecisionsToday: totalDecisionsToday  ?? 0,
        vendorRouteToday:    Math.max(0, (totalDecisionsToday ?? 0) - (treasuryBuyToday ?? 0)),
      },
      providerHealth,

      // ── Business Intelligence ─────────────────────────────────────────────
      userLtv: {
        avgNgn:          avgUserLtvNgn,
        avgUsd:          avgUserLtvUsd,
        avgTradesPerUser,
        activePayingUsers,
        windowDays:      30,
      },
      vendorLtv: {
        avgLifetimeNgn:  avgVendorLtvNgn,
        totalFundedNgn:  Math.round(totalVendorFunded),
        totalBalanceNgn: Math.round(totalVendorBalance),
        vendorCount,
      },
      premiumConversion: {
        premiumUsers:    premiumUsers    ?? 0,
        totalUsers:      totalUsers      ?? 0,
        conversionRate:  premiumConversionRate,
      },
      fraudRate: {
        fraudCount30d,
        totalTrades:    totalTradesAllTime,
        ratePct:        fraudRatePct,
      },
      inventoryVelocity: {
        avgMinutes:    avgSettlementMinutes,
        medianMinutes: medianSettlementMinutes,
        p90Minutes:    p90SettlementMinutes,
        sampleSize:    settlementMinutes.length,
      },
      profitByBrand,
      regionalPerformance,
      treasuryVelocity: {
        hourly:              treasuryVelocity,
        avgDecisionsPerHour,
        buyRate24hPct:       buyRate24h,
        totalDecisions24h:   tvDecisions.length,
      },
    };
  });

// ─── On-demand: trigger weekly analytics email + Telegram push ────────────────
// Same job as the Monday 08:00 UTC cron, callable from Mission Control UI.
// POST — requires admin session.
export const triggerWeeklyAnalyticsReport = createServerFn({ method: "POST" })
  .validator((d: Record<string, never>) => d)
  .handler(async () => {
    await requireAdmin();
    const { getServerSupabase }        = await import("../lib/supabase.server");
    const { sendWeeklyAnalyticsEmail } = await import("../lib/weekly-analytics-email");
    const db     = getServerSupabase();
    const result = await sendWeeklyAnalyticsEmail(db);
    return result;
  });
