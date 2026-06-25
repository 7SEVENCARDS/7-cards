import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { getServerSupabase } from "../lib/supabase.server";
import { requireUser } from "../lib/auth-server";
import { getEnv } from "../lib/worker-env";
import { assertNotRateLimited, clientIp, rlKey } from "../lib/rate-limiter";

// ─── Input whitelists (server-side) ──────────────────────────────────────────
const ALLOWED_BRANDS = new Set([
  "Apple","Amazon","Steam","Google Play","Xbox","PlayStation","Netflix","Spotify",
  "Razer Gold","Sephora","Nordstrom",
]);
const ALLOWED_REGIONS = new Set(["US","UK","EU","CA"]);

// ─── Submit a batch of cards (multi-card risk distribution) ──────────────────
// Each card is an independent trade. Cards are distributed across different
// vendors using round-robin rotation so no single vendor sees more than one
// card from the same batch — reducing single-vendor exposure risk.
//
// When only 1 vendor is available: sequential mode — only the first card is
// dispatched immediately. The rest are queued (batch_queued = true) and
// dispatched one at a time as each preceding card is processed.
export const submitCardBatch = createServerFn({ method: "POST" })
  .validator((d: {
    cards: Array<{
      cardCode:  string;
      cardPin?:  string;
      imagePath?: string;
      ocrResult?: {
        brand: string | null; code: string | null; pin: string | null;
        denomination: number | null; currency: string | null; country: string | null;
        confidence: number; riskScore: "low" | "medium" | "high";
        flags: string[]; rawText: string | null;
      };
    }>;
    brand:         string;
    amountUsd:     number;
    exchangeRate:  number;
    payoutMethod?: "bank" | "wallet";
    region?:       string;
  }) => d)
  .handler(async ({ data }) => {
    // ── Kill switch: new trades frozen? ──────────────────────────────────
    {
      const { assertNotKilled: aks, KILL_SWITCHES: KS } = await import("../lib/kill-switch");
      const dbLocal = await import("../lib/supabase.server").then(m => m.getServerSupabase());
      await aks(KS.NEW_TRADES, dbLocal, "New card submissions are temporarily paused.");
    }

    if (!data.cards.length || data.cards.length > 10) {
      throw new Error("Batch must have 1–10 cards");
    }

    // Validate brand and region
    if (!ALLOWED_BRANDS.has(data.brand)) {
      throw new Error(`Unrecognised brand: ${data.brand}`);
    }
    const region = data.region ?? "US";
    if (!ALLOWED_REGIONS.has(region)) {
      throw new Error(`Unrecognised region: ${region}`);
    }

    const userId = await requireUser();
    const db     = getServerSupabase();

    // Enforce per-trade USD limit based on user's verification tier
    const { getUserTradeTier, TRADE_TIER_LIMITS } = await import("../lib/db-helpers");
    const { tier } = await getUserTradeTier(db, userId);
    const { perTradeLimitUsd } = TRADE_TIER_LIMITS[tier];
    if (data.amountUsd > perTradeLimitUsd) {
      const msgs: Record<string, string> = {
        unverified:    `Verify your email to trade up to $500 per card. Your current limit is $${perTradeLimitUsd}.`,
        email_verified:`Complete KYC identity verification to trade up to $5,000 per card. Your current limit is $${perTradeLimitUsd}.`,
        kyc_verified:  `Upgrade to Premium to trade up to $10,000 per card. Your current limit is $${perTradeLimitUsd}.`,
        premium:       `Trade amount exceeds the maximum allowed.`,
      };
      throw new Error(msgs[tier] ?? `Amount exceeds your $${perTradeLimitUsd} per-trade limit.`);
    }

    const {
      getEligibleVendors,
      getDispatchStrategy,
      assignVendorsToCards,
      recordVendorAssignment,
    } = await import("../lib/batch-dispatch");

    const vendors  = await getEligibleVendors(db);
    if (vendors.length === 0) throw new Error("No active vendors available. Please try again shortly.");

    const strategy    = getDispatchStrategy(vendors.length, data.cards.length);
    const assignments = assignVendorsToCards(vendors, data.cards.length, strategy);
    const amountNgn   = Math.round(data.amountUsd * data.exchangeRate);

    // Create the batch tracking record
    const { data: batch, error: batchErr } = await db
      .from("card_submission_batches")
      .insert({
        user_id:           userId,
        brand:             data.brand,
        amount_usd:        data.amountUsd,
        exchange_rate:     data.exchangeRate,
        total_cards:       data.cards.length,
        payout_method:     data.payoutMethod ?? "bank",
        dispatch_strategy: strategy,
        vendor_count:      vendors.length,
      })
      .select("id")
      .single() as { data: { id: string } | null; error: unknown };

    if (batchErr || !batch) throw new Error("Failed to create batch record");

    // Verify allowance — check once for the whole batch
    const { checkVerificationAllowance } = await import("../lib/db-helpers");
    const allowance = await checkVerificationAllowance(db, userId);
    if (!allowance.allowed) {
      throw new Error(`Daily verification limit reached. Trade $25+ this week for unlimited access.`);
    }

    // ── Process each card sequentially (avoid Reloadly rate-limiting) ──────
    const results: Array<{
      position:            number;
      tradeId:             string | null;
      status:              "verified" | "queued" | "failed";
      failureReason?:      string;
      assignedVendorName?: string;
      assignedVendorId?:   string;
      amountNgn:           number;
    }> = [];

    const { logTradeEvent } = await import("../lib/audit-log");
    const { verifyUserGiftCard } = await import("../lib/reloadly");
    const { directDispatchToVendor } = await import("./vendor-broadcast");

    for (let i = 0; i < data.cards.length; i++) {
      const card    = data.cards[i];
      const { vendor, queued } = assignments[i];
      const position = i + 1;

      // Create trade row
      const { data: trade } = await db
        .from("trades")
        .insert({
          user_id:           userId,
          type:              "gift_card",
          brand:             data.brand,
          region:            region,
          amount_usd:        data.amountUsd,
          amount_ngn:        amountNgn,
          exchange_rate:     data.exchangeRate,
          status:            "scanning",
          batch_id:          batch.id,
          batch_position:    position,
          batch_queued:      queued,
          direct_vendor_id:  vendor.id,
          card_image_path:   card.imagePath ?? null,
        // ── OCR scan data (populated client-side before submission) ──
        ocr_brand:        card.ocrResult?.brand        ?? null,
        ocr_code:         card.ocrResult?.code         ?? null,
        ocr_pin:          card.ocrResult?.pin          ?? null,
        ocr_denomination: card.ocrResult?.denomination ?? null,
        ocr_currency:     card.ocrResult?.currency     ?? null,
        ocr_country:      card.ocrResult?.country      ?? null,
        ocr_confidence:   card.ocrResult?.confidence   ?? null,
        ocr_risk_score:   card.ocrResult?.riskScore    ?? null,
        ocr_flags:        card.ocrResult?.flags        ?? [],
        ocr_scanned_at:   card.ocrResult              ? new Date().toISOString() : null,
        })
        .select("id")
        .single() as { data: { id: string } | null };

      if (!trade) {
        results.push({ position, tradeId: null, status: "failed", failureReason: "Trade creation failed", amountNgn });
        continue;
      }

      // Verify via Reloadly
      try {
        const result = await verifyUserGiftCard({
          brand:     data.brand,
          cardCode:  card.cardCode,
          cardPin:   card.cardPin,
          amountUsd: data.amountUsd,
        });

        if (result.success) {
          // P0-1 fix: Set pending_review status when Reloadly flags manual review needed.
          const needsReview = result.requiresManualReview ?? false;
          await db.from("trades").update({
            status:                 needsReview ? "pending_review" : "verified",
            card_code:              result.cardCode,
            card_pin:               card.cardPin ?? null,
            requires_manual_review: needsReview,
          }).eq("id", trade.id);

          // Audit log — Pillar 1
          await logTradeEvent(db, {
            tradeId:   trade.id,
            event:     "card_verified",
            actorType: "user",
            actorId:   userId,
            payload: {
              brand:          data.brand,
              amount_usd:     data.amountUsd,
              batch_id:       batch.id,
              batch_position: position,
              strategy,
            },
          }).catch(() => {});

          // Admin email — fire-and-forget, non-critical
          import("../lib/email").then(async ({ sendAdminEmail, buildNewTradeEmailHtml }) => {
            await sendAdminEmail({
              subject: `🃏 New Trade: ${data.brand} ${Number(data.amountUsd).toFixed(2)} USD`,
              html: buildNewTradeEmailHtml({
                tradeId:   trade.id,
                userId,
                brand:     data.brand,
                amountUsd: data.amountUsd,
                amountNgn,
                status:    needsReview ? "pending_review" : "verified",
              }),
            });
          }).catch(() => {});

          if (!queued && !needsReview) {
            // P0-1 fix: Only dispatch when verified — never dispatch pending_review trades.
            const dispatchResult = await directDispatchToVendor({
              tradeId:       trade.id,
              vendorId:      vendor.id,
              brand:         data.brand,
              amountUsd:     data.amountUsd,
              amountNgn,
              batchPosition: position,
              batchTotal:    data.cards.length,
            }).catch(() => ({ ok: false, error: "dispatch failed" }));

            if (dispatchResult.ok) {
              await recordVendorAssignment(db, vendor.id).catch(() => {});
            }
          }

          results.push({
            position,
            tradeId:            trade.id,
            status:             needsReview ? "verified" : (queued ? "queued" : "verified"),
            assignedVendorName: vendor.business_name,
            assignedVendorId:   vendor.id,
            amountNgn,
          });
        } else {
          await db.from("trades").update({
            status:         "invalid",
            failure_reason: result.failureReason,
          }).eq("id", trade.id);

          results.push({
            position,
            tradeId:       trade.id,
            status:        "failed",
            failureReason: result.failureReason ?? "Card verification failed",
            amountNgn,
          });
        }
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : "Verification service error";
        await db.from("trades").update({ status: "invalid", failure_reason: errMsg }).eq("id", trade.id).catch(() => {});
        results.push({ position, tradeId: trade.id, status: "failed", failureReason: errMsg, amountNgn });
      }
    }

    // Sync batch counts
    await db.rpc("sync_batch_status", { p_batch_id: batch.id }).catch(() => {});

    return {
      batchId:       batch.id,
      strategy,
      vendorCount:   vendors.length,
      cards:         results,
      verifiedCount: results.filter(r => r.status === "verified").length,
      failedCount:   results.filter(r => r.status === "failed").length,
      queuedCount:   results.filter(r => r.status === "queued").length,
    };
  });

// ─── Get own trade history (recent) ──────────────────────────────────────────
export const getUserTrades = createServerFn({ method: "GET" })
  .validator((d: { userId?: string; limit?: number }) => d)
  .handler(async ({ data }) => {
    try {
      const userId = await requireUser();
      const db = getServerSupabase();
      const { data: trades, error } = await db
        .from("trades")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(data.limit ?? 10);

      if (error) throw error;
      return trades ?? [];
    } catch {
      return [];
    }
  });

// ─── Get current user's trade tier and limits ─────────────────────────────────
export const getTradeLimits = createServerFn({ method: "GET" })
  .validator((d: Record<string, never>) => d)
  .handler(async () => {
    const userId = await requireUser();
    const db = getServerSupabase();

    const { getUserTradeTier, TRADE_TIER_LIMITS, checkVerificationAllowance } = await import("../lib/db-helpers");
    const { tier, emailVerified, kycVerified, premium } = await getUserTradeTier(db, userId);
    const limits = TRADE_TIER_LIMITS[tier];
    const allowance = await checkVerificationAllowance(db, userId);

    return {
      tier,
      emailVerified,
      kycVerified,
      premium,
      perTradeLimitUsd: limits.perTradeLimitUsd,
      dailyVerifLimit: limits.dailyVerifLimit,
      dailyVerifRemaining: allowance.remaining ?? null,
      unlimited: allowance.unlimited,
    };
  });

// ─── Create a new trade ───────────────────────────────────────────────────────
export const createTrade = createServerFn({ method: "POST" })
  .validator((d: {
    type: "gift_card" | "crypto";
    brand: string;
    amountUsd: number;
    exchangeRate: number;
    region?: string;
  }) => d)
  .handler(async ({ data }) => {
    const userId = await requireUser();

    // Rate limit: 5 trade creations per user per 2 minutes
    assertNotRateLimited(rlKey("create_trade:user", userId), 5, 2 * 60 * 1_000);
    // Rate limit: 20 trade creations per IP per 2 minutes (secondary abuse guard)
    const ip = clientIp(getRequest());
    assertNotRateLimited(rlKey("create_trade:ip", ip), 20, 2 * 60 * 1_000);

    const db = getServerSupabase();

    // Enforce per-trade USD limit based on user's verification tier
    const { getUserTradeTier, TRADE_TIER_LIMITS } = await import("../lib/db-helpers");
    const { tier } = await getUserTradeTier(db, userId);
    const { perTradeLimitUsd } = TRADE_TIER_LIMITS[tier];
    if (data.amountUsd > perTradeLimitUsd) {
      const msgs: Record<string, string> = {
        unverified:    `Verify your email to trade up to $500 per card. Your current limit is $${perTradeLimitUsd}.`,
        email_verified:`Complete KYC identity verification to trade up to $5,000 per card. Your current limit is $${perTradeLimitUsd}.`,
        kyc_verified:  `Upgrade to Premium to trade up to $10,000 per card. Your current limit is $${perTradeLimitUsd}.`,
        premium:       `Trade amount exceeds the maximum allowed.`,
      };
      throw new Error(msgs[tier] ?? `Amount exceeds your $${perTradeLimitUsd} per-trade limit.`);
    }

    // Validate brand and region against whitelist
    if (data.type === "gift_card" && !ALLOWED_BRANDS.has(data.brand)) {
      throw new Error(`Unrecognised brand: ${data.brand}`);
    }
    const region = data.region ?? "US";
    if (!ALLOWED_REGIONS.has(region)) {
      throw new Error(`Unrecognised region: ${region}`);
    }

    const amountNgn = Math.round(data.amountUsd * data.exchangeRate);

    const { data: trade, error } = await db
      .from("trades")
      .insert({
        user_id:       userId,
        type:          data.type,
        brand:         data.brand,
        amount_usd:    data.amountUsd,
        amount_ngn:    amountNgn,
        exchange_rate: data.exchangeRate,
        status:        "pending",
        region,
      })
      .select()
      .single();

    if (error) {
      console.error("[Trades] createTrade DB error:", error.message);
      throw new Error("Failed to create trade. Please try again.");
    }
    return trade;
  });

// ─── Verify gift card via Reloadly ────────────────────────────────────────────
export const verifyGiftCard = createServerFn({ method: "POST" })
  .validator((d: {
    tradeId: string;
    cardCode: string;
    cardPin?: string;
    brand: string;
    amountUsd: number;
    recipientEmail?: string;
  }) => d)
  .handler(async ({ data }) => {
    const userId = await requireUser();

    // Rate limit: 10 verifications per user per 5 minutes — stops credential stuffing
    assertNotRateLimited(rlKey("verify_card:user", userId), 10, 5 * 60 * 1_000);
    // Rate limit: 30 verifications per IP per 5 minutes — secondary guard against
    // shared-account or proxy-based brute-force of card codes via Reloadly
    const ip = clientIp(getRequest());
    assertNotRateLimited(rlKey("verify_card:ip", ip), 30, 5 * 60 * 1_000);

    const db = getServerSupabase();

    // Verify the trade belongs to this user
    const { data: trade } = await db
      .from("trades")
      .select("id, user_id, status, amount_ngn")
      .eq("id", data.tradeId)
      .single();

    if (!trade || trade.user_id !== userId) {
      return { success: false, reason: "Trade not found or access denied." };
    }

    // Verification allowance check
    const { checkVerificationAllowance, addVerificationUsage } = await import("../lib/db-helpers");
    const allowance = await checkVerificationAllowance(db, userId);

    if (!allowance.allowed) {
      await db.from("trades").update({
        status: "failed",
        failure_reason: "DAILY_LIMIT_REACHED",
      }).eq("id", data.tradeId);

      return {
        success: false,
        limitReached: true,
        reason: `You've used your 3 free daily verifications. Trade $25+ this week or $50+ this month for unlimited access, or upgrade to Premium.`,
        allowance,
      };
    }

    // Mark trade as scanning
    await db.from("trades").update({ status: "scanning" }).eq("id", data.tradeId);

    // Record usage for free-tier users
    if (!allowance.unlimited) {
      try {
        await addVerificationUsage(db, userId, data.tradeId);
      } catch { /* non-critical */ }
    }

    try {
      const { verifyUserGiftCard } = await import("../lib/reloadly");

      const result = await verifyUserGiftCard({
        brand: data.brand,
        cardCode: data.cardCode,
        cardPin: data.cardPin,
        amountUsd: data.amountUsd,
      });

      if (result.success) {
        // P0-1 fix: pending_review is a real status — do NOT set status='verified'
        // when the card requires manual admin review. Admin approves → status='verified'.
        const needsReview = result.requiresManualReview ?? false;
        await db.from("trades").update({
          status: needsReview ? "pending_review" : "verified",
          card_code: result.cardCode,
          card_pin: data.cardPin ?? null,
          requires_manual_review: needsReview,
          reloadly_transaction_id: result.productId ? String(result.productId) : null,
        }).eq("id", data.tradeId);

        // ── PILLAR 1: Log 'card_verified' — Reloadly_Token + Timestamp + Actor ──
        // The hash of (reloadly_token | server_ts_ms | user_id | trade_id | event)
        // becomes the cryptographic proof that this card passed Reloadly at this
        // exact moment. If Reloadly is ever accused of returning stale data, this
        // entry's hash mismatch will expose any tampering.
        try {
          const { logTradeEvent, hashReloadlyToken } = await import("../lib/audit-log");
          const reloadlyTokenHash = await hashReloadlyToken().catch(() => "hash-unavailable");
          await logTradeEvent(db, {
            tradeId:  data.tradeId,
            event:    "card_verified",
            actorType: "user",
            actorId:  userId,
            payload: {
              brand:               data.brand,
              amount_usd:          data.amountUsd,
              reloadly_product_id: result.productId ?? null,
              reloadly_balance:    result.balance ?? null,
              reloadly_currency:   result.currency ?? null,
              reloadly_token_hash: reloadlyTokenHash, // Pillar-1 anchor
              requires_manual_review: result.requiresManualReview ?? false,
            },
          });
        } catch (e) {
          console.warn("[AuditLog] card_verified log failed (non-fatal):", e instanceof Error ? e.message : e);
        }

        // Admin email — fire-and-forget, non-critical
        import("../lib/email").then(async ({ sendAdminEmail, buildNewTradeEmailHtml }) => {
          await sendAdminEmail({
            subject: `🃏 New Trade: ${data.brand} ${Number(data.amountUsd).toFixed(2)} USD`,
            html: buildNewTradeEmailHtml({
              tradeId:   data.tradeId,
              userId,
              brand:     data.brand,
              amountUsd: data.amountUsd,
              amountNgn: Number((trade as { amount_ngn?: number }).amount_ngn ?? 0),
              status:    needsReview ? "pending_review" : "verified",
            }),
          });
        }).catch(() => {});

        // P0-1 fix: Only broadcast to vendors when NOT requiring manual review.
        // Pending-review trades enter the vendor pipeline only after admin approval.
        if (!needsReview) {
          try {
            const { broadcastTradeToVendors } = await import("./vendor-broadcast");
            const { data: tradeRow } = await db
              .from("trades")
              .select("brand, amount_usd, amount_ngn")
              .eq("id", data.tradeId)
              .single() as { data: { brand: string; amount_usd: number; amount_ngn: number } | null };
            if (tradeRow) {
              broadcastTradeToVendors({
                tradeId: data.tradeId,
                brand: tradeRow.brand,
                amountUsd: Number(tradeRow.amount_usd),
                amountNgn: Number(tradeRow.amount_ngn),
              }).catch(e =>
                console.warn("[Trades] Broadcast failed (non-fatal):", e instanceof Error ? e.message : e)
              );
            }
          } catch (e) {
            console.warn("[Trades] Broadcast import failed (non-fatal):", e instanceof Error ? e.message : e);
          }
        }

        return {
          success: true,
          tradeId: data.tradeId,
          requiresManualReview: result.requiresManualReview,
          allowance,
        };
      } else {
        await db.from("trades").update({
          status: "invalid",
          failure_reason: result.failureReason,
        }).eq("id", data.tradeId);

        return { success: false, reason: result.failureReason ?? "Card verification failed" };
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[Trades] verifyGiftCard error:", msg);

      await db.from("trades").update({
        status: "invalid",
        failure_reason: "Verification service error",
      }).eq("id", data.tradeId);

      return { success: false, reason: "Card verification failed. Please check your card details and try again." };
    }
  });

// ─── Process payout via Squadco ───────────────────────────────────────────────
// SECURITY: All payout values come from the database — the client only supplies
// the trade ID. Amount, bank code, account number, and account name are never
// accepted from the client; this prevents parameter-tampering attacks.
export const processPayout = createServerFn({ method: "POST" })
  .validator((d: { tradeId: string; payoutMethod?: "bank" | "wallet" }) => d)
  .handler(async ({ data }) => {
    const userId = await requireUser();
    const db = getServerSupabase();

    // ── Kill switch: withdrawals frozen? ────────────────────────────────
    const { assertNotKilled, KILL_SWITCHES } = await import("../lib/kill-switch");
    await assertNotKilled(
      KILL_SWITCHES.WITHDRAWALS,
      db,
      "Withdrawals are temporarily paused for maintenance. Please try again shortly."
    );

    // Fetch trade from DB — verify ownership and status
    const { data: trade, error: tradeErr } = await db
      .from("trades")
      .select("id, user_id, amount_ngn, status, requires_manual_review")
      .eq("id", data.tradeId)
      .single();

    if (tradeErr || !trade) {
      return { success: false, reason: "Trade not found." };
    }
    if (trade.user_id !== userId) {
      return { success: false, reason: "Access denied." };
    }
    // P0-1 fix: Explicitly block payout when trade is pending_review.
    // The old code relied on status !== "verified" but pending_review trades were
    // mistakenly set to "verified", so payout could proceed before admin approval.
    if (trade.status === "pending_review" || trade.requires_manual_review === true) {
      return { success: false, reason: "Your card is pending manual review by our team. You will be notified once it's approved and your payout can proceed." };
    }
    if (trade.status !== "verified") {
      return { success: false, reason: "This trade cannot be paid out yet — please complete verification or contact support." };
    }

    const amountNgn = Number(trade.amount_ngn);
    const payoutMethod = data.payoutMethod ?? "bank";

    // ── Atomic compare-and-swap: prevent double-payout race condition ──────
    // Two concurrent requests for the same trade would both read status="verified"
    // then both proceed to payout. The WHERE status='verified' ensures only ONE
    // request wins the UPDATE; the other receives 0 rows and is rejected.
    // This is an atomic DB-level operation — no application-level locks needed.
    const { data: grabbed, error: grabErr } = await db
      .from("trades")
      .update({ status: "processing", payout_method: payoutMethod })
      .eq("id", data.tradeId)
      .eq("status", "verified")
      .eq("user_id", userId)
      .select("id")
      .single();

    if (grabErr || !grabbed) {
      return {
        success: false,
        reason: "This trade is already being processed, was already paid, or is no longer available. Refresh to see the latest status.",
      };
    }

    // ── wallet credit path (no Squad payout) ──────────────────────────────
    if (payoutMethod === "wallet") {
      const xp = 50 + (amountNgn > 100_000 ? 25 : 0);
      await db.rpc("increment_wallet_balance", { p_user_id: userId, p_currency: "NGN", p_amount: amountNgn });
      await db.rpc("award_trade_xp", { p_user_id: userId, p_xp: xp });
      await db.from("trades").update({
        status: "paid", xp_earned: xp,
        settled_at: new Date().toISOString(), payout_method: "wallet",
      }).eq("id", data.tradeId);
      // GAP 5: Null out card credentials after terminal state (NDPR compliance)
      await db.from("trades").update({ card_code: null, card_pin: null })
        .eq("id", data.tradeId).eq("status", "paid").catch(() => {});
      // GAP 7: NFIU threshold check — non-fatal
      try {
        const { checkNfiuThreshold } = await import("../lib/nfiu");
        await checkNfiuThreshold(db, userId, amountNgn);
      } catch { /* non-critical */ }
      await db.from("notifications").insert({
        user_id: userId, title: "Wallet Credited! 💰",
        message: `₦${amountNgn.toLocaleString()} has been added to your 7SEVEN wallet.`,
        type: "success",
      });
      try {
        const { pushNotify } = await import("../lib/onesignal");
        pushNotify(userId, "Wallet Credited! 💰",
          `₦${amountNgn.toLocaleString()} is in your wallet — ready to swap to crypto.`,
          { tradeId: data.tradeId, type: "wallet_credit" }
        );
      } catch { /* non-critical */ }
      try {
        const { creditReferrerCommissionFn } = await import("../lib/db-helpers");
        await creditReferrerCommissionFn(db, userId, data.tradeId, amountNgn);
      } catch { /* non-critical */ }
      return { success: true, transactionRef: "WALLET-" + data.tradeId, walletCredit: true };
    }

    // ── Bank transfer path (Squad) ────────────────────────────────────────
    // Fetch the user's default payout account from DB — never from client
    const { data: payoutAccount } = await db
      .from("payout_accounts")
      .select("bank_code, account_number, account_name")
      .eq("user_id", userId)
      .eq("is_default", true)
      .single();

    if (!payoutAccount) {
      return { success: false, reason: "No default payout account found. Please add a bank account first." };
    }

    // status is already "processing" from the atomic CAS above — proceed directly to payout.
    try {
      const { initiatePayout } = await import("../lib/squadco");

      const result = await initiatePayout({
        tradeId: data.tradeId,
        amountNgn,
        bankCode: payoutAccount.bank_code,
        accountNumber: payoutAccount.account_number,
        accountName: payoutAccount.account_name,
        narration: "7SEVEN CARDS gift card payout",
      });

      if (result.success) {
        await db.rpc("increment_wallet_balance", {
          p_user_id: userId,
          p_currency: "NGN",
          p_amount: amountNgn,
        });

        const xp = 50 + (amountNgn > 100_000 ? 25 : 0);
        await db.rpc("award_trade_xp", { p_user_id: userId, p_xp: xp });

        await db.from("trades").update({
          status: "paid",
          squadco_transaction_ref: result.transactionRef,
          squadco_payment_id: result.paymentId,
          xp_earned: xp,
          settled_at: new Date().toISOString(),
        }).eq("id", data.tradeId);
        // GAP 5: Null out card credentials after terminal state (NDPR compliance)
        await db.from("trades").update({ card_code: null, card_pin: null })
          .eq("id", data.tradeId).eq("status", "paid").catch(() => {});
        // GAP 7: NFIU threshold check — non-fatal
        try {
          const { checkNfiuThreshold } = await import("../lib/nfiu");
          await checkNfiuThreshold(db, userId, amountNgn);
        } catch { /* non-critical */ }

        await db.from("notifications").insert({
          user_id: userId,
          title: "Payment Sent! 🎉",
          message: `₦${amountNgn.toLocaleString()} has been sent to your bank account.`,
          type: "success",
        });

        try {
          const { pushNotify } = await import("../lib/onesignal");
          pushNotify(userId, "Payment Sent! 🎉",
            `₦${amountNgn.toLocaleString()} is on its way to your bank.`,
            { tradeId: data.tradeId, type: "payout" }
          );
        } catch { /* non-critical */ }

        try {
          const { creditReferrerCommissionFn } = await import("../lib/db-helpers");
          await creditReferrerCommissionFn(db, userId, data.tradeId, amountNgn);
        } catch { /* non-critical */ }

        return { success: true, transactionRef: result.transactionRef };
      } else {
        console.error("[Trades] processPayout Squad error:", result.message);
        await db.from("trades").update({
          status: "failed",
          failure_reason: result.message,
        }).eq("id", data.tradeId);
        // GAP 5: Null out card credentials on failed terminal state (NDPR compliance)
        await db.from("trades").update({ card_code: null, card_pin: null })
          .eq("id", data.tradeId).eq("status", "failed").catch(() => {});

        return { success: false, reason: "Payment transfer failed. Please contact support if this persists." };
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const isConfig = msg.includes("not configured");

      if (isConfig) {
        // Demo mode — only allowed when IS_DEMO_MODE=true
        if (getEnv("IS_DEMO_MODE") !== "true") {
          await db.from("trades").update({
            status: "failed",
            failure_reason: "Payment provider not configured",
          }).eq("id", data.tradeId);
          return { success: false, reason: "Payment service is unavailable. Please contact support." };
        }

        const xp = 50;
        await db.rpc("award_trade_xp", { p_user_id: userId, p_xp: xp });
        await db.rpc("increment_wallet_balance", {
          p_user_id: userId,
          p_currency: "NGN",
          p_amount: amountNgn,
        });

        await db.from("trades").update({
          status: "paid",
          xp_earned: xp,
          settled_at: new Date().toISOString(),
        }).eq("id", data.tradeId);
        // GAP 5: Null out card credentials after terminal state (NDPR compliance)
        await db.from("trades").update({ card_code: null, card_pin: null })
          .eq("id", data.tradeId).eq("status", "paid").catch(() => {});

        await db.from("notifications").insert({
          user_id: userId,
          title: "Payment Sent! 🎉",
          message: `₦${amountNgn.toLocaleString()} has been credited to your wallet (demo).`,
          type: "success",
        });

        try {
          const { pushNotify } = await import("../lib/onesignal");
          pushNotify(userId, "Payment Sent! 🎉",
            `₦${amountNgn.toLocaleString()} credited to your wallet.`,
            { tradeId: data.tradeId, type: "payout_demo" }
          );
        } catch { /* non-critical */ }

        try {
          const { creditReferrerCommissionFn } = await import("../lib/db-helpers");
          await creditReferrerCommissionFn(db, userId, data.tradeId, amountNgn);
        } catch { /* non-critical */ }

        return { success: true, transactionRef: "DEMO-" + data.tradeId, demo: true };
      }

      await db.from("trades").update({ status: "failed", failure_reason: msg }).eq("id", data.tradeId);
      // GAP 5: Null out card credentials on failed terminal state (NDPR compliance)
      await db.from("trades").update({ card_code: null, card_pin: null })
        .eq("id", data.tradeId).eq("status", "failed").catch(() => {});
      return { success: false, reason: "Payment service unavailable" };
    }
  });

// ─── Get paginated + filtered trade history ────────────────────────────────────
export const getTradeHistory = createServerFn({ method: "GET" })
  .validator((d: {
    userId?: string;
    page?: number;
    pageSize?: number;
    status?: string;
    type?: string;
  }) => d)
  .handler(async ({ data }) => {
    try {
      const userId = await requireUser();
      const db = getServerSupabase();
      const page = data.page ?? 0;
      const size = data.pageSize ?? 20;
      const from = page * size;
      const to = from + size - 1;

      let query = db
        .from("trades")
        .select(
          "id,type,brand,region,amount_usd,amount_ngn,exchange_rate,status,failure_reason,xp_earned,settled_at,created_at",
          { count: "exact" }
        )
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .range(from, to);

      if (data.status && data.status !== "all") query = query.eq("status", data.status);
      if (data.type   && data.type   !== "all") query = query.eq("type",   data.type);

      const { data: trades, error, count } = await query;
      if (error) throw error;
      return { trades: trades ?? [], total: count ?? 0, page, pageSize: size };
    } catch {
      return { trades: [], total: 0, page: 0, pageSize: 20 };
    }
  });

// ─── Get single trade status ───────────────────────────────────────────────────
// Verifies the trade belongs to the session user before returning it.
export const getTradeStatus = createServerFn({ method: "GET" })
  .validator((d: { tradeId: string }) => d)
  .handler(async ({ data }) => {
    const userId = await requireUser();
    const db = getServerSupabase();
    const { data: trade, error } = await db
      .from("trades")
      .select("*")
      .eq("id", data.tradeId)
      .eq("user_id", userId)
      .single();

    if (error || !trade) return null;
    return trade;
  });
