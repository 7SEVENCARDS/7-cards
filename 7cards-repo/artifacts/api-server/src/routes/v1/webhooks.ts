import { randomBytes } from "crypto";
import { Router } from "express";
import { requireApiKey } from "../../lib/api-auth.js";
import { rateLimitMiddleware } from "../../lib/rate-limit.js";
import { getDb } from "../../lib/db.js";

const router = Router();
router.use(requireApiKey);
router.use(rateLimitMiddleware);

const ALLOWED_EVENTS = [
  "trade.verified",
  "trade.pending_review",
  "trade.failed",
  "trade.dispatched",
  "trade.paid",
  "support.ticket_created",
  "support.replied",
  "support.ticket_closed",
] as const;

function isValidHttpsUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:";
  } catch {
    return false;
  }
}

// ── POST /v1/webhooks ─────────────────────────────────────────────────────────
// Register a webhook endpoint. The signing secret is returned ONCE.
// Deliveries are signed: X-7Seven-Signature: sha256=<hmac-sha256>
router.post("/", async (req, res) => {
  const tenant = req.tenant!;
  const { url, events } = req.body as { url?: string; events?: string[] };

  if (!url || !isValidHttpsUrl(url)) {
    res.status(400).json({
      error: "url must be a valid HTTPS URL",
    });
    return;
  }

  if (!Array.isArray(events) || events.length === 0) {
    res.status(400).json({
      error: "events must be a non-empty array",
      allowed_events: ALLOWED_EVENTS,
    });
    return;
  }

  const invalid = events.filter(
    (e) => !ALLOWED_EVENTS.includes(e as (typeof ALLOWED_EVENTS)[number]),
  );
  if (invalid.length) {
    res.status(400).json({
      error: `Unknown event types: ${invalid.join(", ")}`,
      allowed_events: ALLOWED_EVENTS,
    });
    return;
  }

  const db = getDb();

  // Max 10 endpoints per tenant
  const { count } = await db
    .from("api_webhook_endpoints")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenant.tenantId)
    .eq("is_active", true)
    .then((r) => ({ count: r.count ?? 0 }));

  if (count >= 10) {
    res.status(409).json({ error: "Maximum 10 active webhook endpoints reached" });
    return;
  }

  const signingSecret = "whsec_" + randomBytes(24).toString("hex");

  const { data: endpoint, error } = await db
    .from("api_webhook_endpoints")
    .insert({
      tenant_id: tenant.tenantId,
      url,
      events,
      signing_secret: signingSecret,
    })
    .select("id, url, events, created_at")
    .single();

  if (error || !endpoint) {
    res.status(500).json({ error: "Failed to register webhook endpoint" });
    return;
  }

  res.status(201).json({
    id: endpoint.id,
    url: endpoint.url,
    events: endpoint.events,
    signing_secret: signingSecret, // shown ONCE — store securely
    created_at: endpoint.created_at,
    _note:
      "Store signing_secret securely. It will not be shown again. Use it to verify webhook signatures: HMAC-SHA256(secret, request_body).",
  });
});

// ── GET /v1/webhooks ──────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  const tenant = req.tenant!;
  const db = getDb();

  const { data: endpoints } = await db
    .from("api_webhook_endpoints")
    .select("id, url, events, is_active, failure_count, created_at")
    .eq("tenant_id", tenant.tenantId)
    .order("created_at", { ascending: false });

  res.json({ endpoints: endpoints ?? [] });
});

// ── DELETE /v1/webhooks/:id ───────────────────────────────────────────────────
router.delete("/:id", async (req, res) => {
  const tenant = req.tenant!;
  const { id } = req.params;
  const db = getDb();

  const { error } = await db
    .from("api_webhook_endpoints")
    .update({ is_active: false })
    .eq("id", id)
    .eq("tenant_id", tenant.tenantId);

  if (error) {
    res.status(500).json({ error: "Failed to delete endpoint" });
    return;
  }

  res.status(200).json({ id, deleted: true });
});

// ── GET /v1/webhooks/deliveries ───────────────────────────────────────────────
// Returns recent delivery attempts across all endpoints for debugging.
router.get("/deliveries", async (req, res) => {
  const tenant = req.tenant!;
  const limit = Math.min(Number(req.query.limit ?? 20), 100);
  const offset = Number(req.query.offset ?? 0);
  const endpoint_id = req.query.endpoint_id as string | undefined;
  const db = getDb();

  // Get tenant's endpoint IDs first
  const epQuery = db
    .from("api_webhook_endpoints")
    .select("id")
    .eq("tenant_id", tenant.tenantId);

  const { data: eps } = await epQuery;
  const epIds = (eps ?? []).map((e) => e.id);

  if (!epIds.length) {
    res.json({ deliveries: [], total: 0, limit, offset });
    return;
  }

  let q = db
    .from("api_webhook_deliveries")
    .select(
      "id, endpoint_id, event_type, attempt_count, last_attempt_at, last_status_code, delivered_at, created_at",
    )
    .in("endpoint_id", endpoint_id ? [endpoint_id] : epIds);

  const { data: deliveries } = await q
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  res.json({
    deliveries: (deliveries ?? []).map((d) => ({
      id: d.id,
      endpoint_id: d.endpoint_id,
      event: d.event_type,
      attempts: d.attempt_count,
      last_attempt_at: d.last_attempt_at,
      status_code: d.last_status_code,
      delivered: !!d.delivered_at,
      delivered_at: d.delivered_at,
      queued_at: d.created_at,
    })),
    limit,
    offset,
  });
});

export default router;
