// ─────────────────────────────────────────────────────────────────────────────
// Trust Engine — Phase 11
//
// Computes a composite trust score (0–100) for every user on the platform.
// Trust score drives:
//   • Treasury eligibility
//   • Withdrawal limits
//   • Daily trade limits
//   • Instant payout eligibility
//   • Auto-approval eligibility
//   • Risk routing
//
// Trust Levels:
//   0–20   = New
//   21–50  = Verified
//   51–80  = Trusted
//   81–100 = Elite
//
// Score inputs (weighted):
//   Mono verification        +15
//   NIN verification         +10
//   BVN verification         +12
//   Bank ownership verified  +8
//   Trade history            up to +20
//   Settlement history       up to +10
//   Fraud history            up to −40
//   Chargeback history       up to −20
//   Device reputation        up to +5
//   Referral quality         up to +5
//   Account age              up to +8
//   Support escalations      up to −10
//   Dispute history          up to −15
//
// Persists to trust_scores table. History tracked in trust_score_history.
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from "@supabase/supabase-js";

export type TrustLevel = "New" | "Verified" | "Trusted" | "Elite";

export interface TrustScoreResult {
  userId:       string;
  score:        number;
  level:        TrustLevel;
  reason:       string;
  updatedAt:    string;
  controls:     TrustControls;
  breakdown:    TrustBreakdown;
}

export interface TrustControls {
  treasuryEligible:       boolean;
  withdrawalLimitNgn:     number;
  dailyTradeLimitUsd:     number;
  instantPayoutEligible:  boolean;
  autoApprovalEligible:   boolean;
  riskRouting:            "standard" | "enhanced" | "manual";
}

export interface TrustBreakdown {
  monoVerified:          number;
  ninVerified:           number;
  bvnVerified:           number;
  bankOwnershipVerified: number;
  tradeHistory:          number;
  settlementHistory:     number;
  fraudPenalty:          number;
  chargebackPenalty:     number;
  deviceReputation:      number;
  referralQuality:       number;
  accountAge:            number;
  supportEscalations:    number;
  disputePenalty:        number;
}

// ─── Level mapping ─────────────────────────────────────────────────────────────
function scoreToLevel(score: number): TrustLevel {
  if (score >= 81) return "Elite";
  if (score >= 51) return "Trusted";
  if (score >= 21) return "Verified";
  return "New";
}

// ─── Controls by trust level ──────────────────────────────────────────────────
function levelToControls(level: TrustLevel, score: number): TrustControls {
  switch (level) {
    case "Elite":
      return {
        treasuryEligible:       true,
        withdrawalLimitNgn:     10_000_000,
        dailyTradeLimitUsd:     10_000,
        instantPayoutEligible:  true,
        autoApprovalEligible:   true,
        riskRouting:            "standard",
      };
    case "Trusted":
      return {
        treasuryEligible:       true,
        withdrawalLimitNgn:     2_000_000,
        dailyTradeLimitUsd:     5_000,
        instantPayoutEligible:  true,
        autoApprovalEligible:   score >= 70,
        riskRouting:            "standard",
      };
    case "Verified":
      return {
        treasuryEligible:       score >= 40,
        withdrawalLimitNgn:     500_000,
        dailyTradeLimitUsd:     1_000,
        instantPayoutEligible:  false,
        autoApprovalEligible:   false,
        riskRouting:            "enhanced",
      };
    case "New":
    default:
      return {
        treasuryEligible:       false,
        withdrawalLimitNgn:     100_000,
        dailyTradeLimitUsd:     200,
        instantPayoutEligible:  false,
        autoApprovalEligible:   false,
        riskRouting:            "manual",
      };
  }
}

// ─── Main trust score computation ─────────────────────────────────────────────
export async function computeTrustScore(
  userId: string,
  db: SupabaseClient
): Promise<TrustScoreResult> {
  const breakdown: TrustBreakdown = {
    monoVerified:          0,
    ninVerified:           0,
    bvnVerified:           0,
    bankOwnershipVerified: 0,
    tradeHistory:          0,
    settlementHistory:     0,
    fraudPenalty:          0,
    chargebackPenalty:     0,
    deviceReputation:      0,
    referralQuality:       0,
    accountAge:            0,
    supportEscalations:    0,
    disputePenalty:        0,
  };

  // ── Fetch profile ─────────────────────────────────────────────────────────
  const { data: profile } = await db
    .from("profiles")
    .select("created_at, kyc_status, kyc_bvn, kyc_nin, mono_account_id, referral_code")
    .eq("id", userId)
    .single();

  if (!profile) {
    const now = new Date().toISOString();
    const result: TrustScoreResult = {
      userId,
      score: 0,
      level: "New",
      reason: "Profile not found",
      updatedAt: now,
      controls: levelToControls("New", 0),
      breakdown,
    };
    return result;
  }

  // ── Account age ──────────────────────────────────────────────────────────
  const ageMs = Date.now() - new Date(profile.created_at).getTime();
  const ageDays = Math.floor(ageMs / 86_400_000);
  if (ageDays >= 365)      breakdown.accountAge = 8;
  else if (ageDays >= 90)  breakdown.accountAge = 5;
  else if (ageDays >= 30)  breakdown.accountAge = 3;
  else if (ageDays >= 7)   breakdown.accountAge = 1;

  // ── Identity verification ─────────────────────────────────────────────────
  if (profile.mono_account_id) breakdown.monoVerified = 15;
  if (profile.kyc_nin)         breakdown.ninVerified   = 10;
  if (profile.kyc_bvn)         breakdown.bvnVerified   = 12;

  // ── Bank ownership verified (has a verified payout account) ──────────────
  const { count: payoutCount } = await db
    .from("payout_accounts")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("verified", true)
    .catch(() => ({ count: 0 })) as { count: number | null };
  if ((payoutCount ?? 0) > 0) breakdown.bankOwnershipVerified = 8;

  // ── Trade history ─────────────────────────────────────────────────────────
  const { count: paidCount } = await db
    .from("trades")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("status", "paid");
  const paid = paidCount ?? 0;
  if (paid >= 50)      breakdown.tradeHistory = 20;
  else if (paid >= 20) breakdown.tradeHistory = 15;
  else if (paid >= 10) breakdown.tradeHistory = 10;
  else if (paid >= 5)  breakdown.tradeHistory = 6;
  else if (paid >= 1)  breakdown.tradeHistory = 3;

  // ── Settlement history (successful payouts) ───────────────────────────────
  const { count: settledCount } = await db
    .from("trades")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("status", "paid")
    .not("settled_at", "is", null);
  const settled = settledCount ?? 0;
  if (settled >= 20)      breakdown.settlementHistory = 10;
  else if (settled >= 10) breakdown.settlementHistory = 7;
  else if (settled >= 5)  breakdown.settlementHistory = 4;
  else if (settled >= 1)  breakdown.settlementHistory = 2;

  // ── Fraud history (negative) ──────────────────────────────────────────────
  const { count: fraudCount } = await db
    .from("trades")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .in("status", ["fraud_flagged", "disputed"]);
  const fraudEvents = fraudCount ?? 0;
  breakdown.fraudPenalty = -Math.min(40, fraudEvents * 20);

  // ── Chargeback history (negative) ────────────────────────────────────────
  const { count: chargebackCount } = await db
    .from("trades")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("failure_reason", "chargeback")
    .catch(() => ({ count: 0 })) as { count: number | null };
  breakdown.chargebackPenalty = -Math.min(20, (chargebackCount ?? 0) * 10);

  // ── Dispute history (negative) ────────────────────────────────────────────
  const { count: disputeCount } = await db
    .from("trades")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .in("status", ["invalid", "pending_review"]);
  const disputes = disputeCount ?? 0;
  breakdown.disputePenalty = -Math.min(15, disputes * 3);

  // ── Support escalations (negative) ───────────────────────────────────────
  const { count: escalationCount } = await db
    .from("support_messages")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .catch(() => ({ count: 0 })) as { count: number | null };
  breakdown.supportEscalations = -Math.min(10, Math.floor((escalationCount ?? 0) / 3) * 2);

  // ── Referral quality ──────────────────────────────────────────────────────
  if (profile.referral_code) {
    const { count: referralCount } = await db
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .eq("referred_by", profile.referral_code)
      .catch(() => ({ count: 0 })) as { count: number | null };
    const refs = referralCount ?? 0;
    if (refs >= 10)     breakdown.referralQuality = 5;
    else if (refs >= 5) breakdown.referralQuality = 3;
    else if (refs >= 1) breakdown.referralQuality = 1;
  }

  // ── Device reputation (placeholder — 1 if no fraud signals on device) ────
  breakdown.deviceReputation = fraudEvents === 0 && (paidCount ?? 0) > 0 ? 3 : 0;

  // ── Compute final score ───────────────────────────────────────────────────
  const rawScore = Object.values(breakdown).reduce((sum, v) => sum + v, 0);
  const score    = Math.max(0, Math.min(100, rawScore));
  const level    = scoreToLevel(score);
  const controls = levelToControls(level, score);
  const now      = new Date().toISOString();

  // ── Build reason string ───────────────────────────────────────────────────
  const reasons: string[] = [];
  if (breakdown.monoVerified)          reasons.push("Mono-linked");
  if (breakdown.bvnVerified)           reasons.push("BVN verified");
  if (breakdown.ninVerified)           reasons.push("NIN verified");
  if (breakdown.bankOwnershipVerified) reasons.push("Bank verified");
  if (breakdown.tradeHistory > 0)      reasons.push(`${paid} successful trades`);
  if (breakdown.fraudPenalty < 0)      reasons.push(`${fraudEvents} fraud flag(s)`);
  if (breakdown.chargebackPenalty < 0) reasons.push(`${chargebackCount ?? 0} chargeback(s)`);
  const reason = reasons.length > 0 ? reasons.join(", ") : "Baseline score";

  // ── Persist to trust_scores ───────────────────────────────────────────────
  try {
    await db.from("trust_scores").upsert(
      {
        user_id:       userId,
        trust_score:   score,
        trust_level:   level,
        trust_reason:  reason,
        updated_at:    now,
        breakdown:     breakdown as unknown as Record<string, unknown>,
        controls:      controls as unknown as Record<string, unknown>,
      },
      { onConflict: "user_id" }
    );

    // ── Append to trust_score_history ────────────────────────────────────
    await db.from("trust_score_history").insert({
      user_id:      userId,
      trust_score:  score,
      trust_level:  level,
      trust_reason: reason,
      recorded_at:  now,
      breakdown:    breakdown as unknown as Record<string, unknown>,
    }).catch(() => {/* history table may not exist yet — non-fatal */});
  } catch (e) {
    console.warn("[TrustEngine] Failed to persist trust score:", e instanceof Error ? e.message : e);
  }

  return { userId, score, level, reason, updatedAt: now, controls, breakdown };
}

// ─── Bulk recompute (for admin / cron use) ────────────────────────────────────
export async function recomputeAllTrustScores(db: SupabaseClient): Promise<{
  processed: number;
  errors: number;
}> {
  const { data: users } = await db
    .from("profiles")
    .select("id")
    .order("created_at", { ascending: false });

  let processed = 0;
  let errors    = 0;

  for (const user of users ?? []) {
    try {
      await computeTrustScore(user.id, db);
      processed++;
    } catch {
      errors++;
    }
  }

  return { processed, errors };
}

// ─── Get trust score for a user (fast path — reads from trust_scores table) ───
export async function getTrustScore(
  userId: string,
  db: SupabaseClient
): Promise<TrustScoreResult | null> {
  const { data } = await db
    .from("trust_scores")
    .select("*")
    .eq("user_id", userId)
    .single();

  if (!data) return null;

  return {
    userId:    data.user_id,
    score:     data.trust_score,
    level:     data.trust_level as TrustLevel,
    reason:    data.trust_reason,
    updatedAt: data.updated_at,
    controls:  data.controls as unknown as TrustControls,
    breakdown: data.breakdown as unknown as TrustBreakdown,
  };
}
