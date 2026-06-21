import { createHmac } from "crypto";
import { getDb } from "./db.js";

export type WebhookEvent =
  | "trade.verified"
  | "trade.pending_review"
  | "trade.failed"
  | "trade.dispatched"
  | "trade.paid"
  | "support.ticket_created"
  | "support.replied"
  | "support.ticket_closed";

export interface WebhookPayload {
  event: WebhookEvent;
  tenant_id: string;
  timestamp: string;
  data: Record<string, unknown>;
}

const MAX_ATTEMPTS = 4;
const BACKOFF_MS = [0, 30_000, 120_000, 600_000];

export async function fireWebhookEvent(
  tenantId: string,
  event: WebhookEvent,
  data: Record<string, unknown>,
): Promise<void> {
  const db = getDb();

  const { data: endpoints } = await db
    .from("api_webhook_endpoints")
    .select("id, url, signing_secret")
    .eq("tenant_id", tenantId)
    .eq("is_active", true)
    .contains("events", [event]);

  if (!endpoints?.length) return;

  const payload: WebhookPayload = {
    event,
    tenant_id: tenantId,
    timestamp: new Date().toISOString(),
    data,
  };

  for (const ep of endpoints) {
    const { data: delivery } = await db
      .from("api_webhook_deliveries")
      .insert({ endpoint_id: ep.id, event_type: event, payload })
      .select("id")
      .single();

    if (!delivery?.id) continue;

    scheduleDelivery(ep.id, delivery.id, ep.url, ep.signing_secret, payload, 0);
  }
}

function scheduleDelivery(
  endpointId: string,
  deliveryId: string,
  url: string,
  secret: string,
  payload: WebhookPayload,
  attempt: number,
): void {
  const delayMs = BACKOFF_MS[attempt] ?? 600_000;
  setTimeout(
    () => attemptDelivery(endpointId, deliveryId, url, secret, payload, attempt),
    delayMs,
  ).unref();
}

async function attemptDelivery(
  endpointId: string,
  deliveryId: string,
  url: string,
  secret: string,
  payload: WebhookPayload,
  attempt: number,
): Promise<void> {
  const db = getDb();
  const body = JSON.stringify(payload);
  const sig = createHmac("sha256", secret).update(body).digest("hex");

  let statusCode: number | null = null;
  let responseText = "";
  let success = false;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-7Seven-Signature": `sha256=${sig}`,
        "X-7Seven-Event": payload.event,
        "X-7Seven-Delivery": deliveryId,
        "User-Agent": "7Seven-Webhooks/1.0",
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });

    statusCode = res.status;
    responseText = (await res.text().catch(() => "")).slice(0, 500);
    success = res.ok;
  } catch (e) {
    responseText = (e instanceof Error ? e.message : String(e)).slice(0, 500);
  }

  const updateData: Record<string, unknown> = {
    attempt_count: attempt + 1,
    last_attempt_at: new Date().toISOString(),
    last_status_code: statusCode,
    last_response: responseText,
  };

  if (success) {
    updateData.delivered_at = new Date().toISOString();
    await db
      .from("api_webhook_deliveries")
      .update(updateData)
      .eq("id", deliveryId);
    return;
  }

  await db
    .from("api_webhook_deliveries")
    .update(updateData)
    .eq("id", deliveryId);

  if (attempt + 1 < MAX_ATTEMPTS) {
    scheduleDelivery(endpointId, deliveryId, url, secret, payload, attempt + 1);
  } else {
    await db
      .from("api_webhook_endpoints")
      .update({ failure_count: db.rpc("failure_count_increment" as never) })
      .eq("id", endpointId)
      .catch(() => {});
  }
}
