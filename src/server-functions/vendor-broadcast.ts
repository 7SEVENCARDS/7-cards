// ─────────────────────────────────────────────────────────────────────────────
// Vendor Telegram Broadcast Engine
//
// Flow:
//   1. verifyGiftCard() succeeds in trades.ts
//   2. broadcastTradeToVendors() is called (fire-and-forget)
//   3. All active vendors with telegram_chat_id get "Card available — reply YES"
//   4. POST /api/webhooks/telegram receives vendor's reply
//   5. handleTelegramReply() processes it atomically
//   6. Winner gets card code + a one-time Squad VAN for the NGN amount
//   7. Vendor pays VAN → Squad fires charge.success → user auto-credited
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from "@supabase/supabase-js";
import { createServerFn } from "@tanstack/react-start";
import { requireVendorAuth } from "../lib/auth-server";
import { getServerSupabase } from "../lib/supabase.server";

function getAdminDb() {
  const url = process.env.VITE_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

// ── 1. Broadcast to all active vendors ───────────────────────────────────────
// Called from verifyGiftCard after a successful card scan.
export async function broadcastTradeToVendors(opts: {
  tradeId: string;
  brand: string;
  amountUsd: number;
  amountNgn: number;
}): Promise<void> {
  const db = getAdminDb();
  const {
    buildBroadcastMessage,
    sendTelegramMessage,
    isTelegramConfigured,
  } = await import("../lib/telegram");

  if (!isTelegramConfigured()) {
    console.warn("[Broadcast] TELEGRAM_BOT_TOKEN not set — skipping broadcast");
    return;
  }

  // Create the broadcast record (unique on trade_id — idempotent)
  const { data: broadcast, error: bErr } = await db
    .from("vendor_trade_broadcasts")
    .insert({
      trade_id: opts.tradeId,
      brand: opts.brand,
      amount_usd: opts.amountUsd,
      amount_ngn: opts.amountNgn,
      status: "pending",
    })
    .select("id")
    .single();

  if (bErr) {
    // Unique constraint — broadcast already created (idempotent)
    if (bErr.code === "23505") return;
    console.error("[Broadcast] Failed to create broadcast:", bErr.message);
    return;
  }

  const broadcastId = broadcast.id as string;

  // Fetch all active vendors with a Telegram chat ID
  const { data: vendors } = await db
    .from("vendors")
    .select("id, contact_name, business_name, telegram_chat_id")
    .eq("status", "active")
    .not("telegram_chat_id", "is", null) as {
      data: Array<{
        id: string;
        contact_name: string | null;
        business_name: string;
        telegram_chat_id: number;
      }> | null;
    };

  if (!vendors || vendors.length === 0) {
    console.warn("[Broadcast] No active vendors with Telegram chat IDs.");
    return;
  }

  // Send the broadcast message to each vendor concurrently
  const messages = await Promise.allSettled(
    vendors.map(async (v) => {
      const text = buildBroadcastMessage({
        vendorName: v.contact_name ?? v.business_name,
        brand: opts.brand,
        amountUsd: opts.amountUsd,
        amountNgn: opts.amountNgn,
        broadcastId,
        expiresMinutes: 15,
      });

      const result = await sendTelegramMessage(v.telegram_chat_id, text, "HTML");

      // Log the message for auditing
      await db.from("vendor_broadcast_messages").insert({
        broadcast_id: broadcastId,
        vendor_id: v.id,
        telegram_message_id: result.messageId ?? null,
      });

      return result;
    })
  );

  const sent = messages.filter(m => m.status === "fulfilled" && (m as PromiseFulfilledResult<{ ok: boolean }>).value.ok).length;
  console.info(`[Broadcast] ${broadcastId.slice(0, 8)}: sent to ${sent}/${vendors.length} vendors`);
}

// ── 2. Handle incoming Telegram message (reply "YES") ────────────────────────
// Called from POST /api/webhooks/telegram in server.ts.
export async function handleTelegramReply(opts: {
  chatId: number;
  messageText: string;
  telegramUsername?: string;
}): Promise<void> {
  const db = getAdminDb();

  const text = opts.messageText.trim().toUpperCase();
  const isClaim = text === "YES" || text === "CLAIM" || text === "TAKE" || text === "YES!";

  if (!isClaim) {
    // Unrecognised message — send a helpful nudge
    const { sendTelegramMessage } = await import("../lib/telegram");
    await sendTelegramMessage(
      opts.chatId,
      [
        `👋 <b>7SEVEN CARDS Vendor Bot</b>`,
        ``,
        `When a new card is available, you'll get a message here.`,
        `Reply <b>YES</b> to claim it first!`,
        ``,
        `🔗 Vendor portal: https://7sevencards.com/vendor`,
      ].join("\n"),
      "HTML"
    );
    return;
  }

  // Find the vendor by telegram_chat_id
  const { data: vendor } = await db
    .from("vendors")
    .select("id, status, contact_name, business_name")
    .eq("telegram_chat_id", opts.chatId)
    .maybeSingle() as {
      data: {
        id: string;
        status: string;
        contact_name: string | null;
        business_name: string;
      } | null;
    };

  const { sendTelegramMessage, buildAlreadyClaimedMessage } = await import("../lib/telegram");

  if (!vendor) {
    await sendTelegramMessage(
      opts.chatId,
      [
        `❌ <b>Vendor Not Found</b>`,
        ``,
        `Your Telegram account is not linked to any 7SEVEN vendor profile.`,
        `Please update your Telegram username in the vendor portal and try again.`,
        ``,
        `🔗 https://7sevencards.com/vendor`,
      ].join("\n"),
      "HTML"
    );
    return;
  }

  if (vendor.status !== "active") {
    await sendTelegramMessage(
      opts.chatId,
      `⛔ Your vendor account is <b>${vendor.status}</b>. Please contact support to restore access.`,
      "HTML"
    );
    return;
  }

  // Find the most recent pending broadcast not yet claimed
  const { data: broadcast } = await db
    .from("vendor_trade_broadcasts")
    .select("id, brand, amount_usd, amount_ngn, trade_id, expires_at")
    .eq("status", "pending")
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle() as {
      data: {
        id: string;
        brand: string;
        amount_usd: number;
        amount_ngn: number;
        trade_id: string;
        expires_at: string;
      } | null;
    };

  if (!broadcast) {
    await sendTelegramMessage(
      opts.chatId,
      [
        `⏳ <b>No Active Offers</b>`,
        ``,
        `There are no available cards right now.`,
        `We'll send you a message when the next one arrives!`,
      ].join("\n"),
      "HTML"
    );
    return;
  }

  const vendorName = vendor.contact_name ?? vendor.business_name;

  // Atomically claim the broadcast
  const { data: claimResult } = await db.rpc("claim_vendor_broadcast", {
    p_broadcast_id: broadcast.id,
    p_vendor_id: vendor.id,
  }) as { data: Array<{ claimed: boolean; out_assignment_id: string | null }> | null };

  const claimed = claimResult?.[0]?.claimed ?? false;
  const assignmentId = claimResult?.[0]?.out_assignment_id ?? null;

  if (!claimed || !assignmentId) {
    // Another vendor won the race
    await sendTelegramMessage(opts.chatId, buildAlreadyClaimedMessage(), "HTML");
    return;
  }

  // Fetch card code + pin from the trade
  const { data: trade } = await db
    .from("trades")
    .select("card_code, card_pin")
    .eq("id", broadcast.trade_id)
    .single() as { data: { card_code: string; card_pin: string | null } | null };

  const { buildCardAssignmentMessage } = await import("../lib/telegram");

  // Send card details to the winner
  await sendTelegramMessage(
    opts.chatId,
    buildCardAssignmentMessage({
      vendorName,
      brand: broadcast.brand,
      amountUsd: Number(broadcast.amount_usd),
      amountNgn: Number(broadcast.amount_ngn),
      cardCode: trade?.card_code ?? "(contact admin)",
      cardPin: trade?.card_pin ?? null,
      assignmentId,
      portalUrl: "https://7sevencards.com",
    }),
    "HTML"
  );

  // Provision a Squad one-time VAN for this assignment and send it to the vendor
  // Fire-and-forget — the assignment is already created; VAN failure is recoverable
  provisionAssignmentVAN(db, {
    assignmentId,
    vendorChatId: opts.chatId,
    vendorName,
    amountNgn: Number(broadcast.amount_ngn),
    tradeId: broadcast.trade_id,
  }).catch(e =>
    console.error("[Broadcast] VAN provisioning failed:", e instanceof Error ? e.message : e)
  );
}

// ── 3. Provision a one-time Squad virtual account per assignment ───────────────
async function provisionAssignmentVAN(
  db: ReturnType<typeof getAdminDb>,
  opts: {
    assignmentId: string;
    vendorChatId: number;
    vendorName: string;
    amountNgn: number;
    tradeId: string;
  }
): Promise<void> {
  const squadKey = process.env.SQUADCO_SECRET_KEY ?? "";
  const env = process.env.SQUADCO_ENV === "production" ? "api-d" : "sandbox-api-d";
  const customerRef = `7S-VAN-${opts.assignmentId.slice(0, 8)}-${Date.now()}`;
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

  if (!squadKey) {
    console.warn("[Broadcast] SQUADCO_SECRET_KEY not set — skipping VAN provisioning");
    return;
  }

  const vanRes = await fetch(`https://${env}.squadco.com/virtual-account`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${squadKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      customer_identifier: customerRef,
      amount: Math.round(opts.amountNgn),
      preferred_bank: "wema-bank",
      expiry_date: expiresAt.slice(0, 10).replace(/-/g, "/"),
      callback_url: `${process.env.APP_URL ?? "https://7sevencards.com"}/api/webhooks/squadco/payment`,
      is_permanent: false,
      beneficiary_account: "0000000000",
      meta_data: JSON.stringify({
        assignment_id: opts.assignmentId,
        trade_id: opts.tradeId,
        type: "vendor_assignment_van",
      }),
    }),
  });

  const vanData = await vanRes.json() as {
    success?: boolean;
    data?: {
      virtual_account_number?: string;
      bank_name?: string;
      customer_name?: string;
      customer_identifier?: string;
      id?: string;
    };
    message?: string;
  };

  if (!vanData.success || !vanData.data?.virtual_account_number) {
    console.error("[Broadcast] Squad VAN creation failed:", vanData.message);
    return;
  }

  const accountNumber = vanData.data.virtual_account_number;
  const bankName = vanData.data.bank_name ?? "Wema Bank";
  const accountName = vanData.data.customer_name ?? "7SEVEN CARDS";
  const squadAccountId = vanData.data.customer_identifier ?? customerRef;

  // Persist VAN details onto the assignment
  await db
    .from("vendor_card_assignments")
    .update({
      van_account_number: accountNumber,
      van_bank_name: bankName,
      van_amount_ngn: opts.amountNgn,
      van_squad_account_id: squadAccountId,
    })
    .eq("id", opts.assignmentId);

  // Also store in vendor_virtual_accounts for the wallet tab
  await db.from("vendor_virtual_accounts").insert({
    vendor_id: await getVendorIdForAssignment(db, opts.assignmentId),
    account_number: accountNumber,
    bank_name: bankName,
    account_name: accountName,
    amount_expected: opts.amountNgn,
    reference: customerRef,
    squad_account_id: squadAccountId,
    expires_at: expiresAt,
    purpose: "assignment",
    assignment_id: opts.assignmentId,
  }).then(() => null).catch(() => null); // Non-fatal if column doesn't exist yet

  // Send VAN to vendor via Telegram
  const { buildVANPaymentMessage, sendTelegramMessage } = await import("../lib/telegram");

  await sendTelegramMessage(
    opts.vendorChatId,
    buildVANPaymentMessage({
      vendorName: opts.vendorName,
      accountNumber,
      bankName,
      accountName,
      amountNgn: opts.amountNgn,
      assignmentId: opts.assignmentId,
      expiresAt,
    }),
    "HTML"
  );
}

async function getVendorIdForAssignment(
  db: ReturnType<typeof getAdminDb>,
  assignmentId: string
): Promise<string> {
  const { data } = await db
    .from("vendor_card_assignments")
    .select("vendor_id")
    .eq("id", assignmentId)
    .single() as { data: { vendor_id: string } | null };
  return data?.vendor_id ?? "";
}

// ── 4. Server function: vendor fetches their recent broadcast claim status ────
export const getMyBroadcastClaims = createServerFn({ method: "GET" })
  .handler(async () => {
    const userId = await requireVendorAuth();
    const db = getServerSupabase();
    const { data: vendor } = await db
      .from("vendors")
      .select("id")
      .eq("user_id", userId)
      .single() as { data: { id: string } | null };
    if (!vendor) return [];

    const { data } = await db
      .from("vendor_trade_broadcasts")
      .select("id, brand, amount_usd, amount_ngn, status, claimed_at, created_at, expires_at")
      .eq("claimed_by_vendor_id", vendor.id)
      .order("created_at", { ascending: false })
      .limit(20);

    return data ?? [];
  });

// ── 5. Admin endpoint: register the Telegram bot webhook ─────────────────────
export const adminRegisterTelegramWebhook = createServerFn({ method: "POST" })
  .validator((d: { webhookUrl: string }) => d)
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("../lib/auth-server");
    await requireAdmin();
    const { registerTelegramWebhook } = await import("../lib/telegram");
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
    const ok = await registerTelegramWebhook(data.webhookUrl, secret);
    return { ok };
  });
