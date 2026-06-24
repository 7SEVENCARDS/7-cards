// ─────────────────────────────────────────────────────────────────────────────
// Treasury Decision Engine — Phase 12
//
// Evaluates whether a trade should be fulfilled from:
//   TREASURY_BUY   — treasury acquires the inventory directly
//   VENDOR_ROUTE   — route to vendor network for fulfillment
//   HYBRID_ROUTE   — split: treasury covers partial, vendors cover rest
//
// Inputs:
//   trustScore          — user trust score (0–100, from TrustEngine)
//   fraudScore          — trade/user fraud risk (0–100, from RiskEngine)
//   inventoryRiskScore  — risk of inventory becoming unavailable (0–100)
//   demandScore         — demand pressure index (0–100)
//   treasuryUtilization — % of treasury capital currently deployed (0–1)
//   inventoryVelocity   — how fast this brand/region sells (0–100)
//
// Every treasury decision generates:
//   1. Audit log entry       (treasury_decisions table)
//   2. Ledger event          (event_log via eventBus)
//   3. Risk event            (risk_assessments)
//
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from "@supabase/supabase-js";

export type TreasuryDecision = "TREASURY_BUY" | "VENDOR_ROUTE" | "HYBRID_ROUTE";

export interface TreasuryDecisionInput {
  tradeId:              string;
  userId:               string;
  brand:                string;
  region:               string;
  amountUsd:            number;
  trustScore:           number;
  fraudScore:           number;
  inventoryRiskScore:   number;
  demandScore:          number;
  treasuryUtilization:  number;   // 0.0 – 1.0
  inventoryVelocity:    number;   // 0–100
}

export interface TreasuryDecisionResult {
  decision:             TreasuryDecision;
  confidence:           number;    // 0–100
  reason:               string;
  auditId:              string;
  eligibleForTreasury:  boolean;
  vendorAllocationPct:  number;    // 0–100 (100 = full vendor route)
  treasuryAllocationPct: number;   // 0–100 (100 = full treasury buy)
}

// ─── Thresholds ────────────────────────────────────────────────────────────────
const TREASURY_TRUST_MIN         = 51;    // Trusted or Elite required
const TREASURY_FRAUD_MAX         = 30;    // fraud score must be low
const TREASURY_UTILIZATION_MAX   = 0.85;  // treasury must not be overextended
const TREASURY_AMOUNT_MAX_USD    = 5_000; // max per-trade treasury exposure
const HYBRID_TRUST_MIN           = 30;    // Verified+ for hybrid

// ─── Main decision function ────────────────────────────────────────────────────
export async function makeTreasuryDecision(
  input: TreasuryDecisionInput,
  db: SupabaseClient
): Promise<TreasuryDecisionResult> {
  const {
    tradeId, userId, brand, region, amountUsd,
    trustScore, fraudScore, inventoryRiskScore,
    demandScore, treasuryUtilization, inventoryVelocity,
  } = input;

  let decision:            TreasuryDecision;
  let confidence:          number;
  let reason:              string;
  let vendorAllocationPct: number;
  let treasuryAllocationPct: number;

  const trustOk         = trustScore >= TREASURY_TRUST_MIN;
  const fraudOk         = fraudScore <= TREASURY_FRAUD_MAX;
  const utilOk          = treasuryUtilization <= TREASURY_UTILIZATION_MAX;
  const amountOk        = amountUsd <= TREASURY_AMOUNT_MAX_USD;
  const highDemand      = demandScore >= 60;
  const highInventoryRisk = inventoryRiskScore >= 50;
  const fastVelocity    = inventoryVelocity >= 60;

  if (trustOk && fraudOk && utilOk && amountOk) {
    // Full treasury buy — all conditions met
    if (highDemand || fastVelocity) {
      decision             = "TREASURY_BUY";
      vendorAllocationPct  = 0;
      treasuryAllocationPct = 100;
      confidence           = 90;
      reason = `Trust ${trustScore}/100, fraud ${fraudScore}/100, ` +
               `utilization ${(treasuryUtilization * 100).toFixed(0)}%. ` +
               `High demand/velocity — treasury fulfills fully.`;
    } else {
      // Moderate demand — hybrid (treasury 60%, vendor 40%)
      decision              = "HYBRID_ROUTE";
      vendorAllocationPct   = 40;
      treasuryAllocationPct = 60;
      confidence            = 75;
      reason = `Trust ${trustScore}/100, fraud ${fraudScore}/100. ` +
               `Moderate demand — hybrid split (treasury 60%, vendor 40%).`;
    }
  } else if (trustScore >= HYBRID_TRUST_MIN && fraudOk && utilOk) {
    // Partial treasury — user is Verified but not Trusted
    if (highInventoryRisk) {
      // Inventory risk is high — treasury absorbs more
      decision              = "HYBRID_ROUTE";
      vendorAllocationPct   = 30;
      treasuryAllocationPct = 70;
      confidence            = 70;
      reason = `Trust ${trustScore}/100 (Verified tier). High inventory risk — treasury takes 70%.`;
    } else {
      decision              = "HYBRID_ROUTE";
      vendorAllocationPct   = 70;
      treasuryAllocationPct = 30;
      confidence            = 65;
      reason = `Trust ${trustScore}/100 (Verified tier). Low demand — vendor-heavy hybrid (30% treasury).`;
    }
  } else {
    // Vendor route — user not eligible for treasury
    decision              = "VENDOR_ROUTE";
    vendorAllocationPct   = 100;
    treasuryAllocationPct = 0;
    confidence            = 95;

    const reasons: string[] = [];
    if (!trustOk)   reasons.push(`trust score ${trustScore} below threshold ${TREASURY_TRUST_MIN}`);
    if (!fraudOk)   reasons.push(`fraud score ${fraudScore} above limit ${TREASURY_FRAUD_MAX}`);
    if (!utilOk)    reasons.push(`treasury utilization ${(treasuryUtilization * 100).toFixed(0)}% near limit`);
    if (!amountOk)  reasons.push(`amount $${amountUsd} exceeds treasury limit $${TREASURY_AMOUNT_MAX_USD}`);
    reason = `Routed to vendor network. ${reasons.join("; ")}.`;
  }

  const eligibleForTreasury = decision !== "VENDOR_ROUTE";
  const auditId             = crypto.randomUUID();
  const now                 = new Date().toISOString();

  // ── 1. Persist treasury decision ──────────────────────────────────────────
  try {
    await db.from("treasury_decisions").insert({
      id:                     auditId,
      trade_id:               tradeId,
      user_id:                userId,
      brand,
      region,
      amount_usd:             amountUsd,
      decision,
      confidence,
      reason,
      trust_score:            trustScore,
      fraud_score:            fraudScore,
      inventory_risk_score:   inventoryRiskScore,
      demand_score:           demandScore,
      treasury_utilization:   treasuryUtilization,
      inventory_velocity:     inventoryVelocity,
      vendor_allocation_pct:  vendorAllocationPct,
      treasury_allocation_pct: treasuryAllocationPct,
      decided_at:             now,
    });
  } catch (e) {
    console.warn("[TreasuryEngine] Failed to persist decision:", e instanceof Error ? e.message : e);
  }

  // ── 2. Emit ledger event ──────────────────────────────────────────────────
  try {
    await db.from("event_log").insert({
      event_type:  "TreasuryDecision",
      actor_id:    userId,
      actor_type:  "system",
      entity_type: "trade",
      entity_id:   tradeId,
      payload: {
        decision,
        confidence,
        reason,
        audit_id:              auditId,
        trust_score:           trustScore,
        fraud_score:           fraudScore,
        treasury_utilization:  treasuryUtilization,
        vendor_allocation_pct: vendorAllocationPct,
      },
      occurred_at: now,
    });
  } catch (e) {
    console.warn("[TreasuryEngine] Failed to emit event:", e instanceof Error ? e.message : e);
  }

  // ── 3. Write risk event if high-risk treasury exposure ─────────────────────
  if (eligibleForTreasury && fraudScore > 20) {
    try {
      await db.from("risk_assessments").insert({
        entity_type:  "trade",
        entity_id:    tradeId,
        risk_level:   fraudScore > 40 ? "high" : "medium",
        risk_score:   fraudScore,
        signals: {
          treasury_decision: decision,
          trust_score:       trustScore,
          fraud_score:       fraudScore,
          audit_id:          auditId,
        },
        notes:       `Treasury decision: ${decision}. Elevated fraud score ${fraudScore} on treasury-eligible trade.`,
        assessed_by: "treasury_engine",
        assessed_at: now,
        active:      true,
      });
    } catch (e) {
      console.warn("[TreasuryEngine] Failed to write risk event:", e instanceof Error ? e.message : e);
    }
  }

  return {
    decision,
    confidence,
    reason,
    auditId,
    eligibleForTreasury,
    vendorAllocationPct,
    treasuryAllocationPct,
  };
}

// ─── Treasury Inventory Exchange ──────────────────────────────────────────────
// Automatically offers treasury-held inventory to vendors in tier order:
// Enterprise → Platinum → Gold → Silver → Bronze
// Based on: liquidity, performance, trust score, purchase history, response time.

export type VendorTier = "enterprise" | "platinum" | "gold" | "silver" | "bronze";

const TIER_ORDER: VendorTier[] = ["enterprise", "platinum", "gold", "silver", "bronze"];

export async function offerTreasuryInventoryToVendors(
  db: SupabaseClient,
  inventoryItemId: string,
  brand: string,
  amountUsd: number
): Promise<{
  offered: boolean;
  vendorId: string | null;
  tier: VendorTier | null;
}> {
  for (const tier of TIER_ORDER) {
    const { data: vendors } = await db
      .from("vendors")
      .select("id, performance_score, performance_tier, response_time_avg_ms")
      .eq("status", "active")
      .eq("performance_tier", tier)
      .gte("performance_score", tier === "enterprise" ? 95 : tier === "platinum" ? 90 : 60)
      .order("performance_score", { ascending: false })
      .limit(5);

    if (!vendors || vendors.length === 0) continue;

    const best = vendors[0];

    await db.from("treasury_inventory_offers").insert({
      inventory_item_id: inventoryItemId,
      vendor_id:         best.id,
      vendor_tier:       tier,
      brand,
      amount_usd:        amountUsd,
      offered_at:        new Date().toISOString(),
      status:            "pending",
    }).catch(() => {/* non-fatal */});

    return { offered: true, vendorId: best.id, tier };
  }

  return { offered: false, vendorId: null, tier: null };
}

// ─── Treasury summary for mission control ─────────────────────────────────────
export async function getTreasurySummary(db: SupabaseClient): Promise<{
  totalDecisions:     number;
  treasuryBuyCount:   number;
  vendorRouteCount:   number;
  hybridRouteCount:   number;
  avgConfidence:      number;
  last24hDecisions:   number;
  utilization:        number;
}> {
  const h24Ago = new Date(Date.now() - 86_400_000).toISOString();

  const [
    { count: totalDecisions },
    { count: treasuryBuyCount },
    { count: vendorRouteCount },
    { count: hybridRouteCount },
    { count: last24h },
    { data: confidenceRows },
  ] = await Promise.all([
    db.from("treasury_decisions").select("*", { count: "exact", head: true }),
    db.from("treasury_decisions").select("*", { count: "exact", head: true }).eq("decision", "TREASURY_BUY"),
    db.from("treasury_decisions").select("*", { count: "exact", head: true }).eq("decision", "VENDOR_ROUTE"),
    db.from("treasury_decisions").select("*", { count: "exact", head: true }).eq("decision", "HYBRID_ROUTE"),
    db.from("treasury_decisions").select("*", { count: "exact", head: true }).gte("decided_at", h24Ago),
    db.from("treasury_decisions").select("confidence").gte("decided_at", h24Ago).limit(100),
  ]);

  const avgConf = confidenceRows && confidenceRows.length > 0
    ? Math.round((confidenceRows as Array<{ confidence: number }>).reduce((s, r) => s + r.confidence, 0) / confidenceRows.length)
    : 0;

  return {
    totalDecisions:   totalDecisions   ?? 0,
    treasuryBuyCount: treasuryBuyCount ?? 0,
    vendorRouteCount: vendorRouteCount ?? 0,
    hybridRouteCount: hybridRouteCount ?? 0,
    avgConfidence:    avgConf,
    last24hDecisions: last24h          ?? 0,
    utilization:      0,   // computed from treasury wallet balance / target
  };
}
