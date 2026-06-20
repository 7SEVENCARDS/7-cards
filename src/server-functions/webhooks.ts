// ─────────────────────────────────────────────────────────────────────────────
// Webhook Handlers
// Mounted at: POST /api/webhooks/squadco
//             POST /api/webhooks/squadco-payment
//
// Squad Webhook Docs: https://squadinc.gitbook.io/squad-api-documentation/webhooks
//
// Squad signs every webhook with HMAC-SHA512 of the raw body using your
// SQUADCO_SECRET_KEY. The signature is in header `x-squad-encrypted-body`.
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
    const keyData = encoder.encode(secret);
    const msgData = encoder.encode(rawBody);

    const cryptoKey = await crypto.subtle.importKey(
      "raw", keyData,
      { name: "HMAC", hash: "SHA-512" },
      false, ["sign"]
    );

    const sigBuffer = await crypto.subtle.sign("HMAC", cryptoKey, msgData);
    const computed  = Array.from(new Uint8Array(sigBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    return computed.toLowerCase() === signature.toLowerCase();
  } catch {
    return false;
  }
}

// ─── Squad Payout Webhook (transfer.success / transfer.failed) ───────────────
// Squad calls this when a bank transfer payout is confirmed or fails.
export async function handleSquadPayoutWebhook(request: Request): Promise<Response> {
  const rawBody = await request.text();
  const signature = request.headers.get("x-squad-encrypted-body");

  // Verify signature — reject invalid requests
  const valid = await verifySquadSignature(rawBody, signature);
  if (!valid) {
    console.warn("[Webhook/Squad] Invalid signature — rejected");
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

  // Look up the trade for this payout
  const { data: trade } = await db
    .from("trades")
    .select("id, user_id, amount_ngn, status")
    .eq("squadco_transaction_ref", transactionRef)
    .maybeSingle();

  if (!trade) {
    console.warn(`[Webhook/Squad] No trade found for ref: ${transactionRef}`);
    return new Response(JSON.stringify({ received: true }), { status: 200 });
  }

  if (Event === "transfer.success") {
    // Already paid — idempotent
    if (trade.status === "paid") {
      return new Response(JSON.stringify({ received: true, skipped: "already_paid" }), { status: 200 });
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

    // DB notification
    await db.from("notifications").insert({
      user_id: trade.user_id,
      title: "Payment Confirmed! 🎉",
      message: `₦${Number(trade.amount_ngn).toLocaleString()} has been confirmed and sent to your bank account.`,
      type: "success",
    });

    // OneSignal push
    pushNotify(trade.user_id, "Payment Confirmed! 🎉",
      `₦${Number(trade.amount_ngn).toLocaleString()} sent to your bank.`,
      { tradeId: trade.id, type: "payout_success" }
    );

    // Referral commission (5% to referrer)
    try {
      const { creditReferrerCommission } = await import("./referrals");
      await creditReferrerCommission({
        data: { traderId: trade.user_id, tradeId: trade.id, tradeAmountNgn: Number(trade.amount_ngn) },
      });
    } catch { /* non-critical */ }

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

    pushNotify(trade.user_id, "Transfer Failed",
      "Your payout couldn't be sent. Tap to contact support.",
      { tradeId: trade.id, type: "payout_failed" }
    );
  }

  return new Response(JSON.stringify({ received: true, event: Event }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// ─── Squad Payment Webhook (charge.success — for premium subscriptions) ───────
// Squad calls this when a user successfully pays for Premium.
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

  // Find subscription by transaction ref
  const { data: sub } = await db
    .from("subscriptions")
    .select("id, user_id, status")
    .eq("transaction_ref", transactionRef)
    .maybeSingle();

  if (sub && sub.status !== "active") {
    // Activate it
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

    pushNotify(sub.user_id, "Welcome to 7SEVEN Premium! 🚀",
      "Unlimited verifications, better rates, priority support.",
      { type: "premium_activated" }
    );
  }

  return new Response(JSON.stringify({ received: true, event: Event }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
