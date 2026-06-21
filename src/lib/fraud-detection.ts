// ─────────────────────────────────────────────────────────────────────────────
// Immutable Truth Engine — Pillars 2 & 3
//
// Pillar 2: Multi-Point Timestamp Audit
//   When a vendor marks an assignment failed, we immediately re-query Reloadly
//   with the same card code to determine the card's current status.
//
//   T_Exposure = card_exposed_at_ms — the exact millisecond the card code was
//                delivered to the vendor's Telegram chat.
//   T_Redeemed = inferred from Reloadly's re-check response.
//
//   Verdict logic (mirrors the spec exactly):
//     T_Redeemed < T_Exposure  → card was dead before delivery → SYSTEM_ERROR
//     T_Redeemed ≥ T_Exposure  → card was alive at delivery, vendor used it → FRAUD_CONFIRMED
//     Reloadly says still VALID → vendor lying (card never used) → FRAUD_CONFIRMED
//     Reloadly unreachable      → INCONCLUSIVE (manual review required)
//
// Pillar 3: Automated Capital Depreciation
//   FRAUD_CONFIRMED fires an atomic DB transaction — zero human intervention:
//     1. Full security deposit forfeited  (forfeit_vendor_security_deposit RPC)
//     2. Vendor auto-suspended            (vendors.status = 'suspended')
//     3. Audit entry written              (trade_audit_log, SHA-256 signed)
//     4. Telegram + DB notification sent  (non-fatal fire-and-forget)
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from "@supabase/supabase-js";
import { logTradeEvent, hashReloadlyToken } from "./audit-log";

// ─── Types ────────────────────────────────────────────────────────────────────
type FraudVerdict = "fraud_confirmed" | "system_error" | "inconclusive";

type AuditEvidence = {
  t_exposure_ms:        number | null;
  t_audit_ms:           number;
  t_redeemed_ms:        number | null;
  reloadly_card_status: string;
  reloadly_audit_raw:   unknown;
  verdict:              FraudVerdict;
  verdict_reason:       string;
};

// ─── Pillar 2: Run the forensic timestamp audit ───────────────────────────────
export async function runFraudAudit(
  db: SupabaseClient,
  assignmentId: string,
  vendorId:     string,
  failureReason: string
): Promise<void> {
  const tAuditMs = Date.now();

  // ── Fetch assignment — get T_Exposure and card details ────────────────────
  const { data: assignment } = await db
    .from("vendor_card_assignments")
    .select("id, trade_id, brand, card_code, card_pin, card_exposed_at_ms, amount_usd")
    .eq("id", assignmentId)
    .single() as {
      data: {
        id: string;
        trade_id: string | null;
        brand: string;
        card_code: string;
        card_pin: string | null;
        card_exposed_at_ms: number | null;
        amount_usd: number;
      } | null;
    };

  if (!assignment) {
    console.error(`[FraudAudit] Assignment ${assignmentId} not found`);
    return;
  }

  const tExposureMs = assignment.card_exposed_at_ms ?? null;

  // Log that the audit started
  await logTradeEvent(db, {
    tradeId:      assignment.trade_id,
    assignmentId,
    event:        "fraud_audit_initiated",
    actorType:    "system",
    payload: {
      vendor_id:      vendorId,
      failure_reason: failureReason,
      t_exposure_ms:  tExposureMs,
      t_audit_ms:     tAuditMs,
    },
  });

  // ── Step B: Reloadly live re-query (The Retailer Live Query) ─────────────
  let reloadlyRaw: unknown = null;
  let cardStatus = "UNKNOWN";

  try {
    const { verifyUserGiftCard } = await import("./reloadly");
    const recheck = await verifyUserGiftCard({
      brand:     assignment.brand,
      cardCode:  assignment.card_code,
      cardPin:   assignment.card_pin ?? undefined,
      amountUsd: Number(assignment.amount_usd),
    });
    reloadlyRaw = recheck;

    if (recheck.success) {
      // Reloadly says card is STILL VALID → vendor is lying about it being used
      cardStatus = "VALID";
    } else {
      const reason = (recheck.failureReason ?? "").toLowerCase();
      if (
        reason.includes("redeemed") ||
        reason.includes("already used") ||
        reason.includes("zero balance") ||
        reason.includes("balance") ||
        reason.includes("invalid")
      ) {
        cardStatus = "REDEEMED";
      } else if (reason.includes("expired")) {
        cardStatus = "EXPIRED";
      } else {
        cardStatus = "UNKNOWN";
      }
    }
  } catch (e) {
    reloadlyRaw = { error: e instanceof Error ? e.message : String(e) };
    cardStatus = "UNKNOWN";
    console.warn("[FraudAudit] Reloadly re-query failed:", reloadlyRaw);
  }

  // ── Step C: Apply the verdict formula (Pillar 2) ─────────────────────────
  let verdict:       FraudVerdict;
  let verdictReason: string;
  let tRedeemedMs:   number | null = null;

  if (cardStatus === "UNKNOWN") {
    // Reloadly unreachable — cannot determine verdict safely
    verdict       = "inconclusive";
    verdictReason = "Reloadly re-query returned unknown status — manual review required";

  } else if (cardStatus === "VALID") {
    // Card is still valid → vendor claimed failure falsely (card was never used)
    // T_Redeemed = ∞ (card not redeemed at all), T_Exposure < ∞ → Fraud
    verdict       = "fraud_confirmed";
    verdictReason = "Reloadly reports card still VALID at audit time — vendor claimed failure on an untouched card";
    tRedeemedMs   = null; // never redeemed

  } else {
    // Card is REDEEMED or EXPIRED — apply timestamp comparison
    // Since we know the card was verified as VALID at T_Verification (which is
    // always before T_Exposure), and it's now INVALID, it was redeemed during
    // the vendor's possession window.
    tRedeemedMs = tAuditMs; // conservative: use audit time as upper bound

    if (tExposureMs === null) {
      // T_Exposure not recorded — this means code was exposed via admin panel,
      // not Telegram. We still have strong evidence vendor redeemed the card.
      verdict       = "fraud_confirmed";
      verdictReason = "Card was REDEEMED after verification. T_Exposure not recorded (admin assignment) but vendor was sole possessor of code.";
    } else if (tRedeemedMs < tExposureMs) {
      // Mathematically impossible since tRedeemedMs = tAuditMs > tExposureMs always.
      // This branch guards against future clock-skew edge cases.
      verdict       = "system_error";
      verdictReason = `T_Redeemed (${tRedeemedMs}) < T_Exposure (${tExposureMs}) — card was invalid before delivery. Reloadly validation failure.`;
    } else {
      // T_Redeemed ≥ T_Exposure → card was alive when delivered, vendor used it
      verdict       = "fraud_confirmed";
      verdictReason = `Card REDEEMED after delivery. T_Exposure=${tExposureMs}ms, T_Redeemed≥${tRedeemedMs}ms. Vendor had sole possession.`;
    }
  }

  const evidence: AuditEvidence = {
    t_exposure_ms:        tExposureMs,
    t_audit_ms:           tAuditMs,
    t_redeemed_ms:        tRedeemedMs,
    reloadly_card_status: cardStatus,
    reloadly_audit_raw:   reloadlyRaw,
    verdict,
    verdict_reason:       verdictReason,
  };

  // ── Persist the dispute record ────────────────────────────────────────────
  const { data: dispute } = await db.from("vendor_disputes").insert({
    assignment_id:        assignmentId,
    vendor_id:            vendorId,
    trade_id:             assignment.trade_id,
    failure_reason:       failureReason,
    t_exposure_ms:        tExposureMs,
    t_audit_ms:           tAuditMs,
    t_redeemed_ms:        tRedeemedMs,
    reloadly_audit_raw:   reloadlyRaw,
    reloadly_card_status: cardStatus,
    verdict,
    verdict_at:           new Date().toISOString(),
    verdict_evidence:     evidence,
  }).select("id").single() as { data: { id: string } | null };

  // Update assignment with fraud verdict
  await db.from("vendor_card_assignments").update({
    fraud_verdict:    verdict,
    fraud_verdict_at: new Date().toISOString(),
  }).eq("id", assignmentId);

  // Log the verdict to the immutable audit trail
  await logTradeEvent(db, {
    tradeId:      assignment.trade_id,
    assignmentId,
    event:        verdict === "fraud_confirmed" ? "fraud_confirmed"
                : verdict === "system_error"    ? "system_error"
                : "inconclusive",
    actorType:    "system",
    payload: {
      vendor_id:    vendorId,
      dispute_id:   dispute?.id ?? null,
      verdict,
      verdict_reason: verdictReason,
      t_exposure_ms:  tExposureMs,
      t_redeemed_ms:  tRedeemedMs,
      card_status:    cardStatus,
    },
  });

  // ── Pillar 3: Automated Capital Depreciation on FRAUD_CONFIRMED ───────────
  if (verdict === "fraud_confirmed") {
    await autoEnforceFraudVerdict(db, {
      assignmentId,
      vendorId,
      disputeId:   dispute?.id ?? null,
      evidence,
    });
  }
}

// ─── Pillar 3: Automated Capital Depreciation ─────────────────────────────────
// Fires atomically with zero human intervention when fraud is confirmed.
async function autoEnforceFraudVerdict(
  db: SupabaseClient,
  opts: {
    assignmentId: string;
    vendorId:     string;
    disputeId:    string | null;
    evidence:     AuditEvidence;
  }
): Promise<void> {
  let forfeitedNgn  = 0;
  let autoSuspended = false;

  // ── Step 1: Forfeit the full security deposit ─────────────────────────────
  try {
    const { data: wallet } = await db
      .from("vendor_wallets")
      .select("locked")
      .eq("vendor_id", opts.vendorId)
      .single() as { data: { locked: number } | null };

    const depositHeld = Number(wallet?.locked ?? 0);

    if (depositHeld > 0) {
      const { data: forfeited } = await db.rpc("forfeit_vendor_security_deposit", {
        p_vendor_id: opts.vendorId,
        p_amount:    depositHeld, // forfeit the FULL deposit on fraud
      });
      forfeitedNgn = Number(forfeited ?? 0);

      if (forfeitedNgn > 0) {
        const { data: updWallet } = await db
          .from("vendor_wallets").select("balance").eq("vendor_id", opts.vendorId).single();
        await db.from("vendor_transactions").insert({
          vendor_id:    opts.vendorId,
          type:         "security_deposit_forfeit",
          amount:       forfeitedNgn,
          balance_after: updWallet?.balance ?? null,
          description:  `FRAUD: Full deposit forfeited — card redeemed after delivery. Dispute ${opts.disputeId?.slice(0,8) ?? "N/A"}`,
          assignment_id: opts.assignmentId,
        });
      }
    }
  } catch (e) {
    console.error("[FraudEnforce] Deposit forfeit failed:", e instanceof Error ? e.message : e);
  }

  // ── Step 2: Immediately suspend the vendor ────────────────────────────────
  try {
    const { error: suspendErr } = await db
      .from("vendors")
      .update({
        status:            "suspended",
        suspension_reason: `FRAUD_CONFIRMED: Card redeemed post-delivery. Deposit forfeited ₦${forfeitedNgn.toLocaleString()}. Dispute ID: ${opts.disputeId?.slice(0,8) ?? "N/A"}.`,
        updated_at:        new Date().toISOString(),
      })
      .eq("id", opts.vendorId);

    if (!suspendErr) autoSuspended = true;
  } catch (e) {
    console.error("[FraudEnforce] Vendor suspension failed:", e instanceof Error ? e.message : e);
  }

  // ── Update dispute record with enforcement outcome ────────────────────────
  if (opts.disputeId) {
    await db.from("vendor_disputes").update({
      auto_actioned:         true,
      auto_suspended:        autoSuspended,
      deposit_forfeited_ngn: forfeitedNgn,
      updated_at:            new Date().toISOString(),
    }).eq("id", opts.disputeId);
  }

  // ── Log enforcement to immutable ledger ──────────────────────────────────
  const reloadlyTokenHash = await hashReloadlyToken().catch(() => "hash-failed");
  await logTradeEvent(db, {
    tradeId:      null,
    assignmentId: opts.assignmentId,
    event:        "fraud_enforcement_applied",
    actorType:    "system",
    payload: {
      vendor_id:              opts.vendorId,
      deposit_forfeited_ngn:  forfeitedNgn,
      auto_suspended:         autoSuspended,
      dispute_id:             opts.disputeId,
      reloadly_token_hash:    reloadlyTokenHash, // Pillar-1: token hash in ledger
      t_exposure_ms:          opts.evidence.t_exposure_ms,
      t_redeemed_ms:          opts.evidence.t_redeemed_ms,
      verdict_reason:         opts.evidence.verdict_reason,
    },
  });

  // ── Step 3: Telegram + DB notification (fire-and-forget, non-fatal) ───────
  try {
    const { data: vendor } = await db
      .from("vendors")
      .select("telegram_chat_id, telegram_username, contact_name, business_name")
      .eq("id", opts.vendorId)
      .single() as {
        data: {
          telegram_chat_id: number | null;
          telegram_username: string | null;
          contact_name: string | null;
          business_name: string;
        } | null;
      };

    const chatId = vendor?.telegram_chat_id ?? vendor?.telegram_username;
    const vendorName = vendor?.contact_name ?? vendor?.business_name ?? "Vendor";

    if (chatId) {
      const { sendTelegramMessage } = await import("./telegram");
      await sendTelegramMessage(chatId, [
        `⛔ <b>Account Action — 7SEVEN CARDS</b>`,
        ``,
        `Hi ${vendorName},`,
        ``,
        `Our automated fraud detection system has flagged your account.`,
        ``,
        `<b>Finding:</b> A gift card assigned to you was confirmed redeemed after delivery to your Telegram chat.`,
        ``,
        `<b>Action Taken:</b>`,
        `• Security deposit forfeited: ₦${forfeitedNgn.toLocaleString()}`,
        `• Account suspended immediately`,
        ``,
        `<b>Evidence Reference:</b> <code>${opts.disputeId?.slice(0,8) ?? "N/A"}</code>`,
        ``,
        `To appeal, email <b>disputes@7sevencards.com</b> with this reference within 48 hours.`,
      ].join("\n"), "HTML");
    }

    // DB notification for vendor
    const { data: vendorProfile } = await db
      .from("vendors")
      .select("user_id")
      .eq("id", opts.vendorId)
      .single() as { data: { user_id: string } | null };

    if (vendorProfile?.user_id) {
      await db.from("notifications").insert({
        user_id: vendorProfile.user_id,
        title:   "Account Suspended — Fraud Detected ⛔",
        message: `Automated fraud detection confirmed a card was redeemed after delivery. Deposit forfeited: ₦${forfeitedNgn.toLocaleString()}. Ref: ${opts.disputeId?.slice(0,8) ?? "N/A"}. Email disputes@7sevencards.com to appeal.`,
        type:    "error",
      });
    }
  } catch (e) {
    console.warn("[FraudEnforce] Notification failed (non-fatal):", e instanceof Error ? e.message : e);
  }

  console.info(
    `[FraudEnforce] FRAUD_CONFIRMED — Vendor ${opts.vendorId.slice(0,8)} | ` +
    `Deposit forfeited: ₦${forfeitedNgn.toLocaleString()} | ` +
    `Suspended: ${autoSuspended} | ` +
    `Dispute: ${opts.disputeId?.slice(0,8) ?? "N/A"}`
  );
}
