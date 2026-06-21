import { Router } from "express";
import { requireApiKey } from "../../lib/api-auth.js";
import { rateLimitMiddleware } from "../../lib/rate-limit.js";
import { getDb, getGatewayUserId } from "../../lib/db.js";
import { verifyGiftCard } from "../../lib/reloadly.js";
import { dispatchTradeToVendors } from "../../lib/vendor-dispatch.js";
import { fireWebhookEvent } from "../../lib/webhook-delivery.js";

const router = Router();
router.use(requireApiKey);
router.use(rateLimitMiddleware);

// ── POST /v1/trades ──────────────────────────────────────────────────────────
// Submit a single gift card for verification and vendor dispatch.
router.post("/", async (req, res) => {
  const tenant = req.tenant!;
  const { brand, amount_usd, card_code, card_pin, customer_ref } = req.body as {
    brand?: string;
    amount_usd?: number;
    card_code?: string;
    card_pin?: string;
    customer_ref?: string;
  };

  if (!brand || !amount_usd || !card_code) {
    res.status(400).json({
      error: "Missing required fields",
      required: ["brand", "amount_usd", "card_code"],
    });
    return;
  }

  if (amount_usd <= 0 || amount_usd > 10_000) {
    res.status(400).json({ error: "amount_usd must be between 0 and 10000" });
    return;
  }

  const db = getDb();
  const gatewayUserId = getGatewayUserId();

  // Fetch current exchange rate for this brand
  const { data: rateRow } = await db
    .from("exchange_rates")
    .select("rate_per_dollar")
    .eq("brand", brand)
    .maybeSingle();

  const ratePerDollar = rateRow?.rate_per_dollar ?? 1485;
  const amountNgn = Math.round(amount_usd * ratePerDollar);

  // Create trade record (scanning status)
  const { data: trade, error: tradeErr } = await db
    .from("trades")
    .insert({
      user_id: gatewayUserId,
      type: "gift_card",
      brand,
      amount_usd,
      amount_ngn: amountNgn,
      exchange_rate: ratePerDollar,
      status: "scanning",
    })
    .select("id")
    .single();

  if (tradeErr || !trade) {
    res.status(500).json({ error: "Failed to create trade record" });
    return;
  }

  // Link to tenant
  await db.from("api_tenant_trades").insert({
    tenant_id: tenant.tenantId,
    trade_id: trade.id,
    customer_ref: customer_ref ?? null,
  });

  // Verify via Reloadly
  let verifyResult;
  try {
    verifyResult = await verifyGiftCard({ brand, cardCode: card_code, cardPin: card_pin, amountUsd: amount_usd });
  } catch (e) {
    await db.from("trades").update({ status: "invalid", failure_reason: String(e) }).eq("id", trade.id);
    fireWebhookEvent(tenant.tenantId, "trade.failed", {
      trade_id: trade.id, customer_ref, reason: String(e),
    }).catch(() => {});
    res.status(502).json({ error: "Verification service unavailable", trade_id: trade.id });
    return;
  }

  if (!verifyResult.success) {
    await db.from("trades").update({
      status: "invalid",
      failure_reason: verifyResult.failureReason ?? "Verification failed",
    }).eq("id", trade.id);

    fireWebhookEvent(tenant.tenantId, "trade.failed", {
      trade_id: trade.id,
      customer_ref,
      reason: verifyResult.failureReason,
    }).catch(() => {});

    res.status(422).json({
      trade_id: trade.id,
      status: "failed",
      reason: verifyResult.failureReason ?? "Card verification failed",
      customer_ref,
    });
    return;
  }

  // Manual review required
  if (verifyResult.requiresManualReview) {
    await db.from("trades").update({
      status: "pending_review",
      card_code: verifyResult.cardCode ?? card_code,
      card_pin: card_pin ?? null,
      requires_manual_review: true,
    }).eq("id", trade.id);

    fireWebhookEvent(tenant.tenantId, "trade.pending_review", {
      trade_id: trade.id, customer_ref, amount_usd, amount_ngn: amountNgn,
    }).catch(() => {});

    res.status(202).json({
      trade_id: trade.id,
      status: "pending_review",
      amount_ngn: amountNgn,
      exchange_rate: ratePerDollar,
      customer_ref,
      message: "Card flagged for manual review. You will be notified via webhook when complete.",
    });
    return;
  }

  // Card verified — dispatch to vendor
  await db.from("trades").update({
    status: "verified",
    card_code: verifyResult.cardCode ?? card_code,
    card_pin: card_pin ?? null,
  }).eq("id", trade.id);

  fireWebhookEvent(tenant.tenantId, "trade.verified", {
    trade_id: trade.id, customer_ref, amount_usd, amount_ngn: amountNgn,
  }).catch(() => {});

  const dispatchResult = await dispatchTradeToVendors({
    tradeId: trade.id,
    brand,
    amountUsd: amount_usd,
    amountNgn,
    cardCode: verifyResult.cardCode ?? card_code,
    cardPin: card_pin,
  }).catch(() => ({ ok: false, error: "Dispatch error" }));

  if (dispatchResult.ok) {
    fireWebhookEvent(tenant.tenantId, "trade.dispatched", {
      trade_id: trade.id, customer_ref,
      vendor_name: (dispatchResult as { vendorName?: string }).vendorName,
    }).catch(() => {});

    // Record 7% platform fee for this trade in the tenant's monthly billing cycle
    db.rpc("record_api_trade_fee", {
      p_tenant_id:  tenant.tenantId,
      p_trade_id:   trade.id,
      p_amount_ngn: amountNgn,
    } as never).catch((e: unknown) => {
      console.error("[billing] record_api_trade_fee failed:", e);
    });
  }

  res.status(201).json({
    trade_id: trade.id,
    status: "verified",
    amount_ngn: amountNgn,
    exchange_rate: ratePerDollar,
    customer_ref,
    dispatched: dispatchResult.ok,
  });
});

// ── POST /v1/trades/batch ─────────────────────────────────────────────────────
// Submit 1–10 cards in one call. Cards are processed sequentially to respect
// Reloadly rate limits. Each card gets its own trade_id.
router.post("/batch", async (req, res) => {
  const tenant = req.tenant!;
  const { brand, amount_usd, cards, batch_ref } = req.body as {
    brand?: string;
    amount_usd?: number;
    cards?: Array<{ card_code: string; card_pin?: string; customer_ref?: string }>;
    batch_ref?: string;
  };

  if (!brand || !amount_usd || !Array.isArray(cards) || cards.length === 0) {
    res.status(400).json({
      error: "Missing required fields",
      required: ["brand", "amount_usd", "cards"],
    });
    return;
  }

  if (cards.length > 10) {
    res.status(400).json({ error: "Maximum 10 cards per batch" });
    return;
  }

  const db = getDb();
  const gatewayUserId = getGatewayUserId();

  const { data: rateRow } = await db
    .from("exchange_rates")
    .select("rate_per_dollar")
    .eq("brand", brand)
    .maybeSingle();

  const ratePerDollar = rateRow?.rate_per_dollar ?? 1485;
  const amountNgn = Math.round(amount_usd * ratePerDollar);

  const results: Array<{
    position: number;
    trade_id: string | null;
    status: string;
    customer_ref?: string;
    reason?: string;
  }> = [];

  for (let i = 0; i < cards.length; i++) {
    const card = cards[i]!;
    const position = i + 1;

    const { data: trade } = await db
      .from("trades")
      .insert({
        user_id: gatewayUserId,
        type: "gift_card",
        brand,
        amount_usd,
        amount_ngn: amountNgn,
        exchange_rate: ratePerDollar,
        status: "scanning",
        batch_position: position,
      })
      .select("id")
      .single();

    if (!trade) {
      results.push({ position, trade_id: null, status: "failed", reason: "Trade creation failed" });
      continue;
    }

    await db.from("api_tenant_trades").insert({
      tenant_id: tenant.tenantId,
      trade_id: trade.id,
      customer_ref: card.customer_ref ?? null,
      batch_ref: batch_ref ?? null,
    });

    let verifyResult;
    try {
      verifyResult = await verifyGiftCard({
        brand,
        cardCode: card.card_code,
        cardPin: card.card_pin,
        amountUsd: amount_usd,
      });
    } catch (e) {
      await db.from("trades").update({ status: "invalid", failure_reason: String(e) }).eq("id", trade.id);
      fireWebhookEvent(tenant.tenantId, "trade.failed", {
        trade_id: trade.id, customer_ref: card.customer_ref, batch_ref, reason: String(e),
      }).catch(() => {});
      results.push({ position, trade_id: trade.id, status: "failed", customer_ref: card.customer_ref, reason: String(e) });
      continue;
    }

    if (!verifyResult.success) {
      await db.from("trades").update({ status: "invalid", failure_reason: verifyResult.failureReason }).eq("id", trade.id);
      fireWebhookEvent(tenant.tenantId, "trade.failed", {
        trade_id: trade.id, customer_ref: card.customer_ref, batch_ref, reason: verifyResult.failureReason,
      }).catch(() => {});
      results.push({ position, trade_id: trade.id, status: "failed", customer_ref: card.customer_ref, reason: verifyResult.failureReason });
      continue;
    }

    if (verifyResult.requiresManualReview) {
      await db.from("trades").update({ status: "pending_review", card_code: verifyResult.cardCode ?? card.card_code, requires_manual_review: true }).eq("id", trade.id);
      fireWebhookEvent(tenant.tenantId, "trade.pending_review", { trade_id: trade.id, customer_ref: card.customer_ref, batch_ref }).catch(() => {});
      results.push({ position, trade_id: trade.id, status: "pending_review", customer_ref: card.customer_ref });
      continue;
    }

    await db.from("trades").update({ status: "verified", card_code: verifyResult.cardCode ?? card.card_code, card_pin: card.card_pin ?? null }).eq("id", trade.id);
    fireWebhookEvent(tenant.tenantId, "trade.verified", { trade_id: trade.id, customer_ref: card.customer_ref, batch_ref, amount_usd, amount_ngn: amountNgn }).catch(() => {});

    const dispatchResult = await dispatchTradeToVendors({
      tradeId: trade.id, brand, amountUsd: amount_usd, amountNgn,
      cardCode: verifyResult.cardCode ?? card.card_code, cardPin: card.card_pin,
      batchPosition: position, batchTotal: cards.length,
    }).catch(() => ({ ok: false }));

    if (dispatchResult.ok) {
      fireWebhookEvent(tenant.tenantId, "trade.dispatched", { trade_id: trade.id, customer_ref: card.customer_ref, batch_ref }).catch(() => {});

      db.rpc("record_api_trade_fee", {
        p_tenant_id:  tenant.tenantId,
        p_trade_id:   trade.id,
        p_amount_ngn: amountNgn,
      } as never).catch((e: unknown) => {
        console.error("[billing] batch record_api_trade_fee failed:", e);
      });
    }

    results.push({ position, trade_id: trade.id, status: "verified", customer_ref: card.customer_ref });
  }

  res.status(201).json({
    batch_ref,
    brand,
    amount_usd,
    amount_ngn: amountNgn,
    exchange_rate: ratePerDollar,
    total: cards.length,
    results,
  });
});

// ── GET /v1/trades ────────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  const tenant = req.tenant!;
  const limit = Math.min(Number(req.query.limit ?? 20), 100);
  const offset = Number(req.query.offset ?? 0);
  const status = req.query.status as string | undefined;
  const customer_ref = req.query.customer_ref as string | undefined;
  const batch_ref = req.query.batch_ref as string | undefined;

  const db = getDb();

  let tenantTradeQuery = db
    .from("api_tenant_trades")
    .select("trade_id, customer_ref, batch_ref, created_at")
    .eq("tenant_id", tenant.tenantId);

  if (customer_ref) tenantTradeQuery = tenantTradeQuery.eq("customer_ref", customer_ref);
  if (batch_ref) tenantTradeQuery = tenantTradeQuery.eq("batch_ref", batch_ref);

  const { data: tenantTrades, error } = await tenantTradeQuery
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    res.status(500).json({ error: "Failed to fetch trades" });
    return;
  }

  if (!tenantTrades?.length) {
    res.json({ trades: [], total: 0, limit, offset });
    return;
  }

  const tradeIds = tenantTrades.map((t) => t.trade_id);
  let tradeQuery = db
    .from("trades")
    .select("id, brand, amount_usd, amount_ngn, exchange_rate, status, failure_reason, batch_position, created_at, updated_at")
    .in("id", tradeIds);

  if (status) tradeQuery = tradeQuery.eq("status", status);

  const { data: trades } = await tradeQuery;
  const tradeMap = new Map((trades ?? []).map((t) => [t.id, t]));

  const result = tenantTrades
    .map((tt) => {
      const trade = tradeMap.get(tt.trade_id);
      if (!trade) return null;
      return {
        trade_id: trade.id,
        customer_ref: tt.customer_ref,
        batch_ref: tt.batch_ref,
        brand: trade.brand,
        amount_usd: trade.amount_usd,
        amount_ngn: trade.amount_ngn,
        exchange_rate: trade.exchange_rate,
        status: trade.status,
        failure_reason: trade.failure_reason,
        submitted_at: trade.created_at,
        updated_at: trade.updated_at,
      };
    })
    .filter(Boolean);

  res.json({ trades: result, total: result.length, limit, offset });
});

// ── GET /v1/trades/:id ────────────────────────────────────────────────────────
router.get("/:id", async (req, res) => {
  const tenant = req.tenant!;
  const { id } = req.params;
  const db = getDb();

  const { data: tenantTrade } = await db
    .from("api_tenant_trades")
    .select("customer_ref, batch_ref")
    .eq("tenant_id", tenant.tenantId)
    .eq("trade_id", id)
    .single();

  if (!tenantTrade) {
    res.status(404).json({ error: "Trade not found" });
    return;
  }

  const { data: trade } = await db
    .from("trades")
    .select("id, brand, region, amount_usd, amount_ngn, exchange_rate, status, failure_reason, batch_position, created_at, updated_at")
    .eq("id", id)
    .single();

  if (!trade) {
    res.status(404).json({ error: "Trade not found" });
    return;
  }

  res.json({
    trade_id: trade.id,
    customer_ref: tenantTrade.customer_ref,
    batch_ref: tenantTrade.batch_ref,
    brand: trade.brand,
    region: trade.region,
    amount_usd: trade.amount_usd,
    amount_ngn: trade.amount_ngn,
    exchange_rate: trade.exchange_rate,
    status: trade.status,
    failure_reason: trade.failure_reason,
    batch_position: trade.batch_position,
    submitted_at: trade.created_at,
    updated_at: trade.updated_at,
  });
});

export default router;
