// ─────────────────────────────────────────────────────────────────────────────
// Webhook Handlers
// Mounted at: POST /api/webhooks/squadco/payout
//             POST /api/webhooks/squadco/payment
//
// Squad Webhook Docs: https://squadinc.gitbook.io/squad-api-documentation/webhooks
//
// Squad signs every webhook with HMAC-SHA512 of the raw body using your
// SQUADCO_SECRET_KEY. The signature is in header `x-squad-encrypted-body`.
//
// Idempotency: every event is keyed in `processed_webhook_events` before
// processing begins. A unique constraint on event_key means a second delivery
// of the same event fails fast and returns 200 without re-running the handler.
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from "@supabase/supabase-js";
import { pushNotify } from "../lib/onesignal";

// ─── Admin Supabase (bypasses RLS — webhook has no user session) ──────────────
function getAdminDb() {
  const url = process.env.VITE_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

// ─── HMAC-SHA512 signature verification ──────────────────────────────────────
async function verifySquadSignature(
  rawBody: string,
  signature: string | null
): Promise<boolean> {
  const secret = process.env.SQUADCO_SECRET_KEY;
  if (!secret || !signature) return false;

  try {
    const encoder = new TextEncoder();
    const cryptoKey = await crypto.subtle.importKey(
      "raw", encoder.encode(secret),
      { name: "HMAC", hash: "SHA-512" },
      false, ["sign"]
    );
    const sigBuffer = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(rawBody));
    const computed = Array.from(new Uint8Array(sigBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return computed.toLowerCase() === signature.toLowerCase();
  } catch {
    return false;
  }
}

// ─── Webhook event deduplication ─────────────────────────────────────────────
// Returns true if the event was successfully claimed (first delivery).
// Returns false if the event was already claimed (duplicate — skip).
// Errors other than unique-violation are logged but do not block processing.
async function claimWebhookEvent(
  db: ReturnType<typeof getAdminDb>,
  eventKey: string,
  source: string,
): Promise<boolean> {
  const { error } = await db
    .from("processed_webhook_events")
    .insert({ event_key: eventKey, source, status: "processing" });

  if (!error) return true; // claimed

  if (error.code === "23505") {
    // Unique constraint violation — another worker already claimed this event
    console.info(`[Webhook] Duplicate event skipped: ${eventKey}`);
    return false;
  }

  // Unexpected DB error — log and allow processing to continue rather than
  // silently dropping the event. This trades dedup safety for delivery safety,
  // which is the right call when the alternative is a missed payment.
  console.error(`[Webhook] dedup insert failed (non-critical): ${error.message}`);
  return true;
}

async function markWebhookDone(
  db: ReturnType<typeof getAdminDb>,
  eventKey: string,
  status: "done" | "failed",
  errorMsg?: string,
): Promise<void> {
  await db
    .from("processed_webhook_events")
    .update({
      status,
      completed_at: new Date().toISOString(),
      ...(errorMsg ? { error_msg: errorMsg.slice(0, 500) } : {}),
    })
    .eq("event_key", eventKey);
}

// ─── Squad Payout Webhook (transfer.success / transfer.failed) ───────────────
export async function handleSquadPayoutWebhook(request: Request): Promise<Response> {
  const rawBody = await request.text();
  const signature = request.headers.get("x-squad-encrypted-body");

  const valid = await verifySquadSignature(rawBody, signature);
  if (!valid) {
    console.warn("[Webhook/Payout] Invalid signature — rejected");
    return new Response(JSON.stringify({ error: "Invalid signature" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  let payload: {
    Event: string;
    Data: {
      transaction_reference?: string;
      amount?: number;
      currency?: string;
      status?: string;
      narration?: string;
    };
  };

  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { Event, Data } = payload;
  const transactionRef = Data.transaction_reference;

  if (!transactionRef) {
    return new Response(JSON.stringify({ received: true }), { status: 200 });
  }

  const db = getAdminDb();

  // ── Idempotency check ──────────────────────────────────────────────────────
  const eventKey = `squadco:payout:${transactionRef}:${Event}`;
  const claimed = await claimWebhookEvent(db, eventKey, "squadco_payout");
  if (!claimed) {
    return new Response(
      JSON.stringify({ received: true, skipped: "duplicate" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  // ── Look up the trade ──────────────────────────────────────────────────────
  const { data: trade } = await db
    .from("trades")
    .select("id, user_id, amount_ngn, status")
    .eq("squadco_transaction_ref", transactionRef)
    .maybeSingle();

  if (!trade) {
    console.warn(`[Webhook/Payout] No trade found for ref: ${transactionRef}`);
    await markWebhookDone(db, eventKey, "done");
    return new Response(JSON.stringify({ received: true }), { status: 200 });
  }

  try {
    if (Event === "transfer.success") {
      // Already paid — idempotent
      if (trade.status === "paid") {
        await markWebhookDone(db, eventKey, "done");
        return new Response(
          JSON.stringify({ received: true, skipped: "already_paid" }),
          { status: 200 },
        );
      }

      await db.from("trades").update({
        status: "paid",
        settled_at: new Date().toISOString(),
      }).eq("id", trade.id);

      // Credit wallet
      await db.rpc("increment_wallet_balance", {
        p_user_id: trade.user_id,
        p_currency: "NGN",
        p_amount: trade.amount_ngn,
      });

      // Award XP
      const xp = 50 + (Number(trade.amount_ngn) > 100_000 ? 25 : 0);
      await db.rpc("award_trade_xp", { p_user_id: trade.user_id, p_xp: xp });

      // Notify
      await db.from("notifications").insert({
        user_id: trade.user_id,
        title: "Payment Confirmed! 🎉",
        message: `₦${Number(trade.amount_ngn).toLocaleString()} has been confirmed and sent to your bank account.`,
        type: "success",
      });

      pushNotify(
        trade.user_id,
        "Payment Confirmed! 🎉",
        `₦${Number(trade.amount_ngn).toLocaleString()} sent to your bank.`,
        { tradeId: trade.id, type: "payout_success" },
      );

      // Referral commission — non-critical, must not block settlement
      try {
        const { creditReferrerCommissionFn } = await import("../lib/db-helpers");
        await creditReferrerCommissionFn(db, trade.user_id, trade.id, Number(trade.amount_ngn));
      } catch (e) {
        console.warn("[Webhook/Payout] Referral commission failed (non-fatal):", e instanceof Error ? e.message : e);
      }

    } else if (Event === "transfer.failed") {
      await db.from("trades").update({
        status: "failed",
        failure_reason: Data.narration ?? "Bank transfer declined",
      }).eq("id", trade.id);

      await db.from("notifications").insert({
        user_id: trade.user_id,
        title: "Transfer Failed",
        message: "Your bank transfer failed. Please check your account details and contact support.",
        type: "error",
      });

      pushNotify(
        trade.user_id,
        "Transfer Failed",
        "Your payout couldn't be sent. Tap to contact support.",
        { tradeId: trade.id, type: "payout_failed" },
      );
    }

    await markWebhookDone(db, eventKey, "done");

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Webhook/Payout] Processing failed for ${eventKey}:`, msg);
    await markWebhookDone(db, eventKey, "failed", msg);
    // Return 200 so Squad doesn't retry — the event was received; we'll
    // investigate via the processed_webhook_events table.
    return new Response(
      JSON.stringify({ received: true, error: "internal" }),
      { status: 200 },
    );
  }

  return new Response(
    JSON.stringify({ received: true, event: Event }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

// ─── Squad Payment Webhook (charge.success — for premium subscriptions) ───────
export async function handleSquadPaymentWebhook(request: Request): Promise<Response> {
  const rawBody = await request.text();
  const signature = request.headers.get("x-squad-encrypted-body");

  const valid = await verifySquadSignature(rawBody, signature);
  if (!valid) {
    return new Response(JSON.stringify({ error: "Invalid signature" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  let payload: {
    Event: string;
    Data: {
      transaction_ref?: string;
      payment_ref?: string;
      amount?: number;
      customer_email?: string;
      meta?: Record<string, string>;
    };
  };

  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400 });
  }

  const { Event, Data } = payload;

  if (Event !== "charge.success") {
    return new Response(JSON.stringify({ received: true }), { status: 200 });
  }

  const transactionRef = Data.transaction_ref;
  if (!transactionRef) {
    return new Response(JSON.stringify({ received: true }), { status: 200 });
  }

  const db = getAdminDb();

  // ── Idempotency check ──────────────────────────────────────────────────────
  const eventKey = `squadco:payment:${transactionRef}:${Event}`;
  const claimed = await claimWebhookEvent(db, eventKey, "squadco_payment");
  if (!claimed) {
    return new Response(
      JSON.stringify({ received: true, skipped: "duplicate" }),
      { status: 200 },
    );
  }

  try {
    const { data: sub } = await db
      .from("subscriptions")
      .select("id, user_id, status")
      .eq("transaction_ref", transactionRef)
      .maybeSingle();

    if (sub && sub.status !== "active") {
      const expiresAt = new Date();
      expiresAt.setMonth(expiresAt.getMonth() + 1);

      await db.from("subscriptions").update({
        status: "active",
        payment_ref: Data.payment_ref ?? null,
        expires_at: expiresAt.toISOString(),
      }).eq("id", sub.id);

      await db.from("profiles").update({ premium: true }).eq("id", sub.user_id);

      await db.from("notifications").insert({
        user_id: sub.user_id,
        title: "Welcome to 7SEVEN Premium! 🚀",
        message: "Your Premium subscription is now active. Enjoy higher limits and better rates!",
        type: "success",
      });

      pushNotify(
        sub.user_id,
        "Welcome to 7SEVEN Premium! 🚀",
        "Unlimited verifications, better rates, priority support.",
        { type: "premium_activated" },
      );
    }

    await markWebhookDone(db, eventKey, "done");

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Webhook/Payment] Processing failed for ${eventKey}:`, msg);
    await markWebhookDone(db, eventKey, "failed", msg);
  }

  return new Response(
    JSON.stringify({ received: true, event: Event }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}
