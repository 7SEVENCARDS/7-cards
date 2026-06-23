// ─────────────────────────────────────────────────────────────────────────────
// Risk Engine — Phase 10: Fraud Engine
//
// Computes risk assessments (Low / Medium / High / Critical) for:
//   • Users   — trade patterns, account age, KYC, dispute history
//   • Vendors — fraud history, dispute rate, deposit status
//   • Trades  — amount, frequency, card brand patterns
//
// Writes results to the risk_assessments table.
// The event bus also reads risk level for trust score computation.
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from "@supabase/supabase-js";

export type RiskLevel = "low" | "medium" | "high" | "critical";

interface RiskSignals {
  // User signals
  duplicate_cards?:          number;    // same card code submitted multiple times
  multiple_accounts?:        boolean;   // same device/IP across accounts
  failed_verifications?:     number;    // failed KYC / BVN attempts
  abnormal_trade_volume?:    boolean;   // unusual spike in trade value
  dispute_count?:            number;    // trades marked disputed/fraudulent
  account_age_days?:         number;
  kyc_verified?:             boolean;

  // Vendor signals
  fraud_verdicts?:           number;    // confirmed fraud on this vendor
  vendor_dispute_rate?:      number;    // disputes / completed (0–1)
  deposit_forfeited?:        boolean;   // security deposit ever forfeited
  suspension_history?:       number;    // times suspended and reactivated

  // Trade signals
  trade_amount_usd?:         number;
  card_brand_risk?:          "low" | "medium" | "high";   // some brands are higher fraud targets
  rapid_submission?:         boolean;   // multiple trades in short window
  unverified_user?:          boolean;
}

interface RiskResult {
  level:    RiskLevel;
  score:    number;    // 0–100
  signals:  RiskSignals;
  notes:    string;
}

// ─── Score thresholds ─────────────────────────────────────────────────────────
function scoreToLevel(score: number): RiskLevel {
  if (score >= 75) return "critical";
  if (score >= 50) return "high";
  if (score >= 25) return "medium";
  return "low";
}

// ─── User risk assessment ─────────────────────────────────────────────────────
export async function assessUserRisk(
  userId: string,
  db: SupabaseClient
): Promise<RiskResult> {
  let score = 0;
  const signals: RiskSignals = {};

  // Fetch profile
  const { data: profile } = await db
    .from("profiles")
    .select("kyc_status, created_at")
    .eq("id", userId)
    .single();

  const accountAgeDays = profile?.created_at
    ? Math.floor((Date.now() - new Date(profile.created_at).getTime()) / 86_400_000)
    : 0;
  signals.account_age_days = accountAgeDays;
  signals.kyc_verified     = profile?.kyc_status === "approved";

  // New account penalty
  if (accountAgeDays < 3)       score += 20;
  else if (accountAgeDays < 14) score += 10;

  // KYC not verified
  if (!signals.kyc_verified) score += 15;

  // Trade dispute history
  const { count: disputeCount } = await db
    .from("trades")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .in("status", ["disputed", "fraud_flagged"]);
  signals.dispute_count = disputeCount ?? 0;
  score += Math.min(40, (disputeCount ?? 0) * 15);

  // Failed KYC verifications
  const { count: failedVerif } = await db
    .from("kyc_submissions")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("status", "rejected")
    .catch(() => ({ count: 0 })) as { count: number | null };
  signals.failed_verifications = failedVerif ?? 0;
  score += Math.min(20, (failedVerif ?? 0) * 5);

  // Check for abnormal trade volume (> 10 trades in last 24h)
  const { count: recentTrades } = await db
    .from("trades")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("created_at", new Date(Date.now() - 86_400_000).toISOString());
  signals.abnormal_trade_volume = (recentTrades ?? 0) > 10;
  if (signals.abnormal_trade_volume) score += 15;

  score = Math.min(100, score);
  const level = scoreToLevel(score);
  const notes = buildNotes("user", signals, level);

  // Persist to DB
  await upsertRiskAssessment(db, "user", userId, level, score, signals, notes);

  return { level, score, signals, notes };
}

// ─── Vendor risk assessment ───────────────────────────────────────────────────
export async function assessVendorRisk(
  vendorId: string,
  db: SupabaseClient
): Promise<RiskResult> {
  let score = 0;
  const signals: RiskSignals = {};

  // Fetch vendor stats
  const { data: vendor } = await db
    .from("vendors")
    .select("total_disputes, total_completed, total_failed, status, performance_score")
    .eq("id", vendorId)
    .single();

  if (!vendor) {
    return { level: "low", score: 0, signals: {}, notes: "Vendor not found" };
  }

  // Fraud verdicts
  const { count: fraudCount } = await db
    .from("vendor_disputes")
    .select("id", { count: "exact", head: true })
    .eq("vendor_id", vendorId)
    .eq("verdict", "fraud_confirmed");
  signals.fraud_verdicts = fraudCount ?? 0;
  score += Math.min(60, (fraudCount ?? 0) * 30);

  // Dispute rate
  const disputeRate = vendor.total_completed > 0
    ? (vendor.total_disputes / vendor.total_completed)
    : 0;
  signals.vendor_dispute_rate = disputeRate;
  if (disputeRate > 0.3)      score += 25;
  else if (disputeRate > 0.1) score += 10;

  // Suspension history
  const { count: suspensions } = await db
    .from("admin_audit_log")
    .select("id", { count: "exact", head: true })
    .eq("target_id", vendorId)
    .eq("action", "vendor_suspended");
  signals.suspension_history = suspensions ?? 0;
  score += Math.min(20, (suspensions ?? 0) * 8);

  // Deposit ever forfeited
  const { count: forfeitCount } = await db
    .from("vendor_transactions")
    .select("id", { count: "exact", head: true })
    .eq("vendor_id", vendorId)
    .eq("type", "security_deposit_forfeit");
  signals.deposit_forfeited = (forfeitCount ?? 0) > 0;
  if (signals.deposit_forfeited) score += 20;

  score = Math.min(100, score);
  const level = scoreToLevel(score);
  const notes = buildNotes("vendor", signals, level);

  await upsertRiskAssessment(db, "vendor", vendorId, level, score, signals, notes);

  return { level, score, signals, notes };
}

// ─── Trade risk assessment ────────────────────────────────────────────────────
export async function assessTradeRisk(
  tradeId: string,
  db: SupabaseClient
): Promise<RiskResult> {
  let score = 0;
  const signals: RiskSignals = {};

  const { data: trade } = await db
    .from("trades")
    .select("user_id, amount_usd, brand, created_at")
    .eq("id", tradeId)
    .single();

  if (!trade) {
    return { level: "low", score: 0, signals: {}, notes: "Trade not found" };
  }

  signals.trade_amount_usd = Number(trade.amount_usd);

  // High-value trades get extra scrutiny
  if (signals.trade_amount_usd > 500)     score += 20;
  else if (signals.trade_amount_usd > 200) score += 10;

  // High-risk gift card brands (commonly used in fraud)
  const highRiskBrands = ["iTunes", "Google Play", "Steam", "Amazon"];
  const mediumRiskBrands = ["Walmart", "Target", "Best Buy"];
  if (highRiskBrands.some(b => trade.brand.toLowerCase().includes(b.toLowerCase()))) {
    signals.card_brand_risk = "high";
    score += 15;
  } else if (mediumRiskBrands.some(b => trade.brand.toLowerCase().includes(b.toLowerCase()))) {
    signals.card_brand_risk = "medium";
    score += 5;
  } else {
    signals.card_brand_risk = "low";
  }

  // User verification status
  const { data: profile } = await db
    .from("profiles")
    .select("kyc_status")
    .eq("id", trade.user_id)
    .single();
  signals.unverified_user = profile?.kyc_status !== "approved";
  if (signals.unverified_user && signals.trade_amount_usd > 100) score += 20;

  // Rapid submission: user already has active trade in last hour
  const { count: recentTrades } = await db
    .from("trades")
    .select("id", { count: "exact", head: true })
    .eq("user_id", trade.user_id)
    .neq("id", tradeId)
    .gte("created_at", new Date(Date.now() - 3_600_000).toISOString());
  signals.rapid_submission = (recentTrades ?? 0) > 2;
  if (signals.rapid_submission) score += 15;

  score = Math.min(100, score);
  const level = scoreToLevel(score);
  const notes = buildNotes("trade", signals, level);

  await upsertRiskAssessment(db, "trade", tradeId, level, score, signals, notes);

  return { level, score, signals, notes };
}

// ─── Persist risk assessment ──────────────────────────────────────────────────
async function upsertRiskAssessment(
  db: SupabaseClient,
  entityType: string,
  entityId: string,
  level: RiskLevel,
  score: number,
  signals: RiskSignals,
  notes: string
): Promise<void> {
  // Deactivate previous assessments for this entity
  await db
    .from("risk_assessments")
    .update({ active: false })
    .eq("entity_type", entityType)
    .eq("entity_id", entityId)
    .eq("active", true);

  await db.from("risk_assessments").insert({
    entity_type:  entityType,
    entity_id:    entityId,
    risk_level:   level,
    risk_score:   score,
    signals,
    notes,
    assessed_at:  new Date().toISOString(),
    assessed_by:  "system",
    active:       true,
  });
}

// ─── Human-readable notes ─────────────────────────────────────────────────────
function buildNotes(type: string, signals: RiskSignals, level: RiskLevel): string {
  const parts: string[] = [`${type.toUpperCase()} risk: ${level.toUpperCase()}.`];

  if (signals.fraud_verdicts)           parts.push(`${signals.fraud_verdicts} confirmed fraud verdict(s).`);
  if (signals.deposit_forfeited)        parts.push("Security deposit previously forfeited.");
  if (signals.dispute_count)            parts.push(`${signals.dispute_count} trade dispute(s) on record.`);
  if (signals.abnormal_trade_volume)    parts.push("Abnormal trade volume in last 24h.");
  if (signals.rapid_submission)         parts.push("Multiple trades submitted within 1 hour.");
  if (signals.unverified_user)          parts.push("KYC not verified.");
  if ((signals.account_age_days ?? 99) < 3) parts.push("Account < 3 days old.");
  if (signals.card_brand_risk === "high") parts.push("High-risk card brand.");

  if (parts.length === 1) parts.push("No significant risk signals detected.");
  return parts.join(" ");
}
