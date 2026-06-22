// ─────────────────────────────────────────────────────────────────────────────
// Webhook Handlers
// Mounted at: POST /api/webhooks/squadco/payout
//             POST /api/webhooks/squadco/payment
//             POST /api/webhooks/telegram
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
import { getEnv } from "../lib/worker-env";

// ─── Admin Supabase (bypasses RLS — webhook has no user session) ──────────────
function getAdminDb() {
  const url = getEnv("VITE_SUPABASE_URL") ?? "";
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

// ─── HMAC-SHA512 signature verification ──────────────────────────────────────
async function verifySquadSignature(
  rawBody: string,
  signature: string | null
): Promise<boolean> {
  const secret = getEnv("SQUADCO_SECRET_KEY");
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
async function claimWebhookEvent(
  db: ReturnType<typeof getAdminDb>,
  eventKey: string,
  source: string,
): Promise<boolean> {
  const { error } = await db
    .from("processed_webhook_events")
    .insert({ event_key: eventKey, source, status: "processing" });

  if (!error) return true;

  if (error.code === "23505") {
    console.info(`[Webhook] Duplicate event skipped: ${eventKey}`);
    return false;
  }

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

  const eventKey = `squadco:payout:${transactionRef}:${Event}`;
  const claimed = await claimWebhookEvent(db, eventKey, "squadco_payout");
  if (!claimed) {
    return new Response(
      JSON.stringify({ received: true, skipped: "duplicate" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

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

      await db.rpc("increment_wallet_balance", {
        p_user_id: trade.user_id,
        p_currency: "NGN",
        p_amount: trade.amount_ngn,
      });

      const xp = 50 + (Number(trade.amount_ngn) > 100_000 ? 25 : 0);
      await db.rpc("award_trade_xp", { p_user_id: trade.user_id, p_xp: xp });

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

// ─── Squad Payment Webhook (charge.success) ───────────────────────────────────
// Handles two sub-cases:
//   A. Premium subscription payments (meta.type = undefined or "subscription")
//   B. Vendor assignment VAN payments (meta.type = "vendor_assignment_van")
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
      customer_identifier?: string;
      virtual_account_number?: string;
      meta?: Record<string, string>;
      meta_data?: string;
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

  const eventKey = `squadco:payment:${transactionRef}:${Event}`;
  const claimed = await claimWebhookEvent(db, eventKey, "squadco_payment");
  if (!claimed) {
    return new Response(
      JSON.stringify({ received: true, skipped: "duplicate" }),
      { status: 200 },
    );
  }

  try {
    // Parse meta_data if present (JSON string from Squad)
    let meta: Record<string, string> = Data.meta ?? {};
    if (!meta.type && Data.meta_data) {
      try { meta = JSON.parse(Data.meta_data); } catch { /* ignore */ }
    }

    // ── Case B: Vendor assignment VAN payment ─────────────────────────────────
    if (meta.type === "vendor_assignment_van" && meta.assignment_id) {
      await handleVendorAssignmentPayment(db, {
        eventKey,
        assignmentId: meta.assignment_id,
        tradeId: meta.trade_id,
        amountPaidKobo: Data.amount ?? 0,
        squadRef: transactionRef,
      });
      return new Response(
        JSON.stringify({ received: true, event: Event, type: "vendor_assignment" }),
        { status: 200 },
      );
    }

    // ── Case A: Premium subscription payment ──────────────────────────────────
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

// ─── Internal: settle a vendor assignment VAN payment ────────────────────────
async function handleVendorAssignmentPayment(
  db: ReturnType<typeof getAdminDb>,
  opts: {
    eventKey: string;
    assignmentId: string;
    tradeId?: string;
    amountPaidKobo: number;
    squadRef: string;
  }
): Promise<void> {
  // Fetch the assignment and its linked trade
  const { data: assignment } = await db
    .from("vendor_card_assignments")
    .select("id, vendor_id, trade_id, van_paid, van_amount_ngn")
    .eq("id", opts.assignmentId)
    .maybeSingle() as {
      data: {
        id: string;
        vendor_id: string;
        trade_id: string | null;
        van_paid: boolean;
        van_amount_ngn: number | null;
      } | null;
    };

  if (!assignment) {
    console.warn(`[Webhook/VAN] Assignment not found: ${opts.assignmentId}`);
    await markWebhookDone(db, opts.eventKey, "done");
    return;
  }

  if (assignment.van_paid) {
    // Already credited — idempotent
    await markWebhookDone(db, opts.eventKey, "done");
    return;
  }

  const tradeId = assignment.trade_id ?? opts.tradeId;
  if (!tradeId) {
    console.error(`[Webhook/VAN] No trade_id on assignment ${opts.assignmentId}`);
    await markWebhookDone(db, opts.eventKey, "failed", "No trade_id");
    return;
  }

  // Fetch the trade to get user_id and amount
  const { data: trade } = await db
    .from("trades")
    .select("id, user_id, amount_ngn, status")
    .eq("id", tradeId)
    .single() as {
      data: { id: string; user_id: string; amount_ngn: number; status: string } | null;
    };

  if (!trade) {
    console.error(`[Webhook/VAN] Trade not found: ${tradeId}`);
    await markWebhookDone(db, opts.eventKey, "failed", "Trade not found");
    return;
  }

  const amountNgn = Number(assignment.van_amount_ngn ?? trade.amount_ngn);

  // Mark assignment VAN as paid
  await db.from("vendor_card_assignments").update({
    van_paid: true,
    van_paid_at: new Date().toISOString(),
    van_squad_ref: opts.squadRef,
    status: "redeemed",
    redeemed_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
  }).eq("id", opts.assignmentId);

  // Credit vendor wallet for the trade commission
  // (vendor earns the difference between what they pay and what we credit user)
  // For now, credit the vendor the full NGN (they handle the rate themselves)
  const { data: vendorWallet } = await db
    .from("vendor_wallets")
    .select("balance")
    .eq("vendor_id", assignment.vendor_id)
    .single() as { data: { balance: number } | null };

  if (vendorWallet !== null) {
    await db.rpc("increment_vendor_wallet_balance", {
      p_vendor_id: assignment.vendor_id,
      p_amount: amountNgn,
    });

    const { data: updWallet } = await db
      .from("vendor_wallets")
      .select("balance")
      .eq("vendor_id", assignment.vendor_id)
      .single() as { data: { balance: number } | null };

    await db.from("vendor_transactions").insert({
      vendor_id: assignment.vendor_id,
      type: "card_redemption",
      amount: amountNgn,
      balance_after: updWallet?.balance ?? null,
      description: `VAN payment received for ${tradeId.slice(0, 8)} — credited`,
      reference: opts.assignmentId,
    });

    // Update vendor total_redeemed
    await db.rpc("increment_vendor_total_redeemed", {
      p_vendor_id: assignment.vendor_id,
    }).catch(() => null); // RPC may not exist yet — non-fatal
  }

  // Credit user's NGN wallet
  await db.rpc("increment_wallet_balance", {
    p_user_id: trade.user_id,
    p_currency: "NGN",
    p_amount: amountNgn,
  });

  // Mark trade as paid
  const xp = 50 + (amountNgn > 100_000 ? 25 : 0);
  await db.rpc("award_trade_xp", { p_user_id: trade.user_id, p_xp: xp });

  await db.from("trades").update({
    status: "paid",
    xp_earned: xp,
    settled_at: new Date().toISOString(),
    payout_method: "vendor",
    squadco_transaction_ref: opts.squadRef,
  }).eq("id", tradeId);

  // Notify user
  await db.from("notifications").insert({
    user_id: trade.user_id,
    title: "Payment Received! 🎉",
    message: `₦${amountNgn.toLocaleString()} has been credited to your 7SEVEN wallet.`,
    type: "success",
  });

  pushNotify(
    trade.user_id,
    "Payment Received! 🎉",
    `₦${amountNgn.toLocaleString()} is in your wallet.`,
    { tradeId, type: "vendor_van_paid" },
  );

  // Referral commission — non-critical
  try {
    const { creditReferrerCommissionFn } = await import("../lib/db-helpers");
    await creditReferrerCommissionFn(db, trade.user_id, tradeId, amountNgn);
  } catch { /* non-fatal */ }

  await markWebhookDone(db, opts.eventKey, "done");

  console.info(`[Webhook/VAN] Assignment ${opts.assignmentId.slice(0, 8)} settled — ₦${amountNgn.toLocaleString()} credited to user ${trade.user_id.slice(0, 8)}`);
}

// ─── Telegram Webhook (POST /api/webhooks/telegram) ───────────────────────────
// Telegram sends updates when a vendor replies to the bot.
// Validated via X-Telegram-Bot-Api-Secret-Token header.
export async function handleTelegramWebhook(request: Request): Promise<Response> {
  // Validate secret token if configured
  const secret = getEnv("TELEGRAM_WEBHOOK_SECRET");
  if (secret) {
    const incoming = request.headers.get("x-telegram-bot-api-secret-token");
    if (incoming !== secret) {
      console.warn("[Webhook/Telegram] Invalid secret token — rejected");
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  let update: {
    update_id: number;
    message?: {
      message_id: number;
      from?: { id: number; username?: string; first_name?: string };
      chat: { id: number };
      text?: string;
    };
  };

  try {
    update = await request.json() as typeof update;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400 });
  }

  const message = update.message;
  if (!message?.text || !message.chat?.id) {
    // Not a text message — ignore silently (Telegram expects 200)
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }

  const chatId = message.chat.id;
  const text = message.text;
  const username = message.from?.username;

  // Process asynchronously — must return 200 to Telegram within 5s
  // We use a micro-task so the response is sent before processing completes
  Promise.resolve().then(async () => {
    try {
      const { handleTelegramReply } = await import("./vendor-broadcast");
      await handleTelegramReply({ chatId, messageText: text, telegramUsername: username });
    } catch (e) {
      console.error("[Webhook/Telegram] handleTelegramReply failed:", e instanceof Error ? e.message : e);
    }
  });

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
