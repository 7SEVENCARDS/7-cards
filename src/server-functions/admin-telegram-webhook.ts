// ─────────────────────────────────────────────────────────────────────────────
// Admin Telegram Bot Webhook Handler
// Route: POST /api/webhooks/telegram-admin
// Processes incoming updates from the admin bot (ADMIN_TELEGRAM_BOT_TOKEN).
//
// Supported interactions:
//   /start <code>     — link admin Telegram account using a one-time code
//   /reply <ticketId> <msg>  — reply to a support ticket from the support group
//   /whoami           — show linked admin info
//   callback_query    — inline button actions (approve/reject)
//
// Inline button callback_data formats:
//   mr_approve:<tradeId>      — approve manual review trade
//   mr_reject:<tradeId>       — reject manual review trade (prompts reason)
//   wd_approve:<withdrawalId> — approve vendor withdrawal
//   wd_reject:<withdrawalId>  — reject vendor withdrawal
//   kyc_approve:<userId>      — approve user KYC
//   kyc_reject:<userId>       — reject user KYC
//   vr_approve:<vendorId>     — approve vendor rate submission
//   vr_reject:<vendorId>      — reject vendor rate submission
//
// Security:
//   Validates ADMIN_TELEGRAM_WEBHOOK_SECRET header (X-Telegram-Bot-Api-Secret-Token).
//   All DB writes use service-role key — never anon key.
//   Idempotency: checks processed_webhook_events table (source='telegram_admin_callback').
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from "@supabase/supabase-js";
import { answerCallbackQuery, sendAdminBotMessage } from "../lib/telegram";
import { resolveAdminNotifications } from "./admin-telegram";
import { adminReplyToTicket } from "./support";

type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; username?: string; first_name?: string };
    chat: { id: number };
    text?: string;
  };
  callback_query?: {
    id: string;
    from: { id: number; username?: string; first_name?: string };
    message?: { message_id: number; chat: { id: number } };
    data?: string;
  };
};

function getAdminDb() {
  return createClient(
    process.env.VITE_SUPABASE_URL ?? "",
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

// ─── Idempotency guard ────────────────────────────────────────────────────────
async function isAlreadyProcessed(db: ReturnType<typeof getAdminDb>, eventKey: string): Promise<boolean> {
  const { data } = await db
    .from("processed_webhook_events")
    .select("id")
    .eq("event_key", eventKey)
    .maybeSingle();
  return !!data;
}

async function markProcessed(db: ReturnType<typeof getAdminDb>, eventKey: string): Promise<void> {
  await db.from("processed_webhook_events").insert({
    event_key: eventKey,
    source: "telegram_admin_callback",
    status: "done",
  }).onConflict("event_key").ignore();
}

// ─── Auth: verify this chat belongs to a linked admin ─────────────────────────
async function getLinkedAdminId(db: ReturnType<typeof getAdminDb>, chatId: number): Promise<string | null> {
  const { data } = await db
    .from("admin_telegram_links")
    .select("admin_id")
    .eq("telegram_chat_id", chatId)
    .maybeSingle();
  return data?.admin_id ?? null;
}

// ─── Link code flow ───────────────────────────────────────────────────────────
async function handleLinkCode(
  db: ReturnType<typeof getAdminDb>,
  chatId: number,
  username: string | undefined,
  code: string,
): Promise<string> {
  const { data: linkCode } = await db
    .from("admin_telegram_link_codes")
    .select("admin_id, expires_at, used_at")
    .eq("code", code.toUpperCase().trim())
    .maybeSingle();

  if (!linkCode) return "❌ Invalid link code. Generate a new one from the admin panel.";
  if (linkCode.used_at) return "⚠️ This code has already been used. Generate a new one.";
  if (new Date(linkCode.expires_at) < new Date()) return "⏰ This code has expired. Generate a new one.";

  // Mark code used
  await db
    .from("admin_telegram_link_codes")
    .update({ used_at: new Date().toISOString() })
    .eq("code", code.toUpperCase().trim());

  // Upsert link
  await db.from("admin_telegram_links").upsert({
    admin_id: linkCode.admin_id,
    telegram_chat_id: chatId,
    telegram_username: username ?? null,
  }, { onConflict: "telegram_chat_id" });

  return `✅ <b>Admin Telegram linked successfully!</b>\n\nYou will now receive real-time notifications for:\n• 🔍 Manual review trades\n• 💸 Vendor withdrawals\n• 🪪 KYC submissions\n• 📈 Vendor rate requests\n\nUse /whoami to confirm your account.`;
}

// ─── Callback query handler ───────────────────────────────────────────────────
async function handleCallback(
  db: ReturnType<typeof getAdminDb>,
  callbackQueryId: string,
  callbackData: string,
  chatId: number,
  adminId: string,
): Promise<void> {
  const eventKey = `tg_admin_cb:${callbackData}`;

  if (await isAlreadyProcessed(db, eventKey)) {
    await answerCallbackQuery(callbackQueryId, "Already processed.", true);
    return;
  }

  const [action, itemId] = callbackData.split(":");

  try {
    switch (action) {
      case "mr_approve":
        await handleManualReviewApprove(db, itemId, adminId, callbackQueryId, chatId);
        break;
      case "mr_reject":
        await sendAdminBotMessage(chatId, `To reject trade <code>${itemId.slice(0, 8)}</code>, reply with:\n/mr_reject_reason ${itemId} your reason here`);
        await answerCallbackQuery(callbackQueryId, "Send /mr_reject_reason command.");
        break;
      case "wd_approve":
        await handleWithdrawalApprove(db, itemId, adminId, callbackQueryId, chatId);
        break;
      case "wd_reject":
        await sendAdminBotMessage(chatId, `To reject withdrawal <code>${itemId.slice(0, 8)}</code>, reply with:\n/wd_reject_reason ${itemId} your reason here`);
        await answerCallbackQuery(callbackQueryId, "Send /wd_reject_reason command.");
        break;
      case "kyc_approve":
        await handleKYCApprove(db, itemId, adminId, callbackQueryId, chatId);
        break;
      case "kyc_reject":
        await sendAdminBotMessage(chatId, `To reject KYC for user <code>${itemId.slice(0, 8)}</code>, reply with:\n/kyc_reject_reason ${itemId} your reason here`);
        await answerCallbackQuery(callbackQueryId, "Send /kyc_reject_reason command.");
        break;
      case "vr_approve":
        await handleVendorRateApprove(db, itemId, adminId, callbackQueryId, chatId);
        break;
      case "vr_reject":
        await handleVendorRateReject(db, itemId, adminId, callbackQueryId, chatId);
        break;
      default:
        await answerCallbackQuery(callbackQueryId, "Unknown action.", true);
        return;
    }

    await markProcessed(db, eventKey);
  } catch (e) {
    console.error("[AdminTelegramWebhook] Callback error:", e);
    await answerCallbackQuery(callbackQueryId, "⚠️ Action failed. Check server logs.", true);
  }
}

async function handleManualReviewApprove(
  db: ReturnType<typeof getAdminDb>,
  tradeId: string,
  adminId: string,
  callbackQueryId: string,
  chatId: number,
): Promise<void> {
  const { data: updated } = await db
    .from("trades")
    .update({ status: "verified", requires_manual_review: false })
    .eq("id", tradeId)
    .eq("status", "pending_review")
    .select("id, user_id, brand, amount_usd, amount_ngn, direct_vendor_id, batch_position")
    .maybeSingle();

  if (!updated) {
    await answerCallbackQuery(callbackQueryId, "Already handled.", true);
    return;
  }

  await db.from("notifications").insert({
    user_id: updated.user_id,
    title: "Card Verified ✅",
    message: "Your gift card has been manually verified. Your payout is being processed.",
    type: "success",
  });

  await db.from("admin_audit_log").insert({
    admin_id: adminId,
    action: "manual_trade_approve",
    target_id: tradeId,
    meta: { via: "telegram_bot" },
  }).catch(() => {});

  if (updated.direct_vendor_id) {
    Promise.resolve().then(async () => {
      try {
        const { directDispatchToVendor } = await import("./vendor-broadcast");
        await directDispatchToVendor({
          tradeId: updated.id,
          vendorId: updated.direct_vendor_id!,
          brand: updated.brand,
          amountUsd: Number(updated.amount_usd),
          amountNgn: Number(updated.amount_ngn),
          batchPosition: updated.batch_position ?? 1,
          batchTotal: 1,
        });
      } catch (e) {
        console.error("[AdminTelegramWebhook] Deferred dispatch failed:", e);
      }
    });
  }

  await resolveAdminNotifications("manual_review", tradeId, `✅ <b>Manual Review — Approved</b>\n\nTrade <code>${tradeId.slice(0, 8)}</code> (${updated.brand} $${updated.amount_usd}) approved and dispatched.`);
  await answerCallbackQuery(callbackQueryId, "✅ Approved and dispatched.");
}

async function handleWithdrawalApprove(
  db: ReturnType<typeof getAdminDb>,
  withdrawalId: string,
  adminId: string,
  callbackQueryId: string,
  chatId: number,
): Promise<void> {
  const { data: wd } = await db
    .from("vendor_withdrawal_requests")
    .select("*")
    .eq("id", withdrawalId)
    .maybeSingle();

  if (!wd) {
    await answerCallbackQuery(callbackQueryId, "Withdrawal not found.", true);
    return;
  }

  if (wd.status !== "pending") {
    await answerCallbackQuery(callbackQueryId, "Already processed.", true);
    return;
  }

  // §4.2 fix: use approveWithdrawalImpl (plain function, no session cookie required)
  // instead of calling adminApproveWithdrawal createServerFn directly, which would
  // crash because requireAdmin() → getWebRequest() reads a Supabase auth cookie that
  // doesn't exist in the Telegram webhook context. The impl function accepts an
  // explicit adminId derived from the linked-chat lookup already performed above.
  const { approveWithdrawalImpl } = await import("./vendors");
  await approveWithdrawalImpl(db as ReturnType<typeof import("../lib/supabase.server").getServerSupabase>, adminId, withdrawalId);
  await db.from("admin_audit_log").insert({
    admin_id: adminId,
    action: "approve_withdrawal",
    target_id: withdrawalId,
    meta: { via: "telegram_bot" },
  }).catch(() => {});

  await resolveAdminNotifications("withdrawal", withdrawalId, `✅ <b>Withdrawal — Approved</b>\n\nWithdrawal <code>${withdrawalId.slice(0, 8)}</code> of ₦${Number(wd.amount_ngn).toLocaleString()} approved.`);
  await answerCallbackQuery(callbackQueryId, "✅ Withdrawal approved.");
}

async function handleKYCApprove(
  db: ReturnType<typeof getAdminDb>,
  userId: string,
  adminId: string,
  callbackQueryId: string,
  chatId: number,
): Promise<void> {
  await db.from("profiles").update({ kyc_status: "verified" }).eq("id", userId);
  await db.from("notifications").insert({
    user_id: userId,
    title: "KYC Approved! ✅",
    message: "Your identity has been verified. You can now trade without limits.",
    type: "success",
  });
  await db.from("admin_audit_log").insert({
    admin_id: adminId,
    action: "kyc_approve",
    target_id: userId,
    meta: { via: "telegram_bot" },
  }).catch(() => {});

  await resolveAdminNotifications("kyc", userId, `✅ <b>KYC — Approved</b>\n\nUser <code>${userId.slice(0, 8)}</code> KYC approved.`);
  await answerCallbackQuery(callbackQueryId, "✅ KYC approved.");
}

async function handleVendorRateApprove(
  db: ReturnType<typeof getAdminDb>,
  vendorId: string,
  adminId: string,
  callbackQueryId: string,
  chatId: number,
): Promise<void> {
  await db.rpc("approve_vendor_rate", { p_vendor_id: vendorId, p_admin_id: adminId });
  await db.from("admin_audit_log").insert({
    admin_id: adminId,
    action: "approve_vendor_rate",
    target_id: vendorId,
    meta: { via: "telegram_bot" },
  }).catch(() => {});

  await resolveAdminNotifications("vendor_rate", vendorId, `✅ <b>Vendor Rate — Approved</b>\n\nRate approved for vendor <code>${vendorId.slice(0, 8)}</code>.`);
  await answerCallbackQuery(callbackQueryId, "✅ Rate approved.");
}

async function handleVendorRateReject(
  db: ReturnType<typeof getAdminDb>,
  vendorId: string,
  adminId: string,
  callbackQueryId: string,
  chatId: number,
): Promise<void> {
  await db.rpc("reject_vendor_rate", { p_vendor_id: vendorId, p_admin_id: adminId });
  await db.from("admin_audit_log").insert({
    admin_id: adminId,
    action: "reject_vendor_rate",
    target_id: vendorId,
    meta: { via: "telegram_bot" },
  }).catch(() => {});

  await resolveAdminNotifications("vendor_rate", vendorId, `❌ <b>Vendor Rate — Rejected</b>\n\nRate rejected for vendor <code>${vendorId.slice(0, 8)}</code>.`);
  await answerCallbackQuery(callbackQueryId, "Rate rejected.");
}

// ─── Text command handler ─────────────────────────────────────────────────────
async function handleTextCommand(
  db: ReturnType<typeof getAdminDb>,
  chatId: number,
  text: string,
  username: string | undefined,
  adminId: string | null,
): Promise<void> {
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();

  // /start <code> — link flow
  if (cmd === "/start" && parts[1]) {
    const reply = await handleLinkCode(db, chatId, username, parts[1]);
    await sendAdminBotMessage(chatId, reply);
    return;
  }

  // All commands below require a linked admin
  if (!adminId) {
    await sendAdminBotMessage(chatId, "⚠️ Your Telegram is not linked to an admin account. Generate a link code from the admin panel.");
    return;
  }

  // /whoami
  if (cmd === "/whoami") {
    const { data: admin } = await db.from("profiles").select("full_name, role").eq("id", adminId).maybeSingle();
    await sendAdminBotMessage(chatId, `👤 <b>Linked Admin</b>\nName: ${admin?.full_name ?? "Unknown"}\nRole: ${admin?.role ?? "admin"}\nAdmin ID: <code>${adminId.slice(0, 8)}</code>`);
    return;
  }

  // /reply <ticketId> <message> — support reply
  if (cmd === "/reply" && parts.length >= 3) {
    const ticketId = parts[1];
    const message = parts.slice(2).join(" ");
    const ok = await adminReplyToTicket(ticketId, message, adminId);
    await sendAdminBotMessage(chatId, ok ? `✅ Reply sent to ticket <code>${ticketId.slice(0, 8)}</code>.` : `❌ Ticket not found: <code>${ticketId.slice(0, 8)}</code>.`);
    return;
  }

  // /mr_reject_reason <tradeId> <reason>
  if (cmd === "/mr_reject_reason" && parts.length >= 3) {
    const tradeId = parts[1];
    const reason = parts.slice(2).join(" ");
    const eventKey = `tg_admin_cmd:mr_reject:${tradeId}`;
    if (!await isAlreadyProcessed(db, eventKey)) {
      const { data: updated } = await db.from("trades")
        .update({ status: "invalid", requires_manual_review: false, failure_reason: reason })
        .eq("id", tradeId).eq("status", "pending_review")
        .select("user_id").maybeSingle();
      if (updated) {
        await db.from("notifications").insert({ user_id: updated.user_id, title: "Card Rejected", message: `Your gift card was not accepted: ${reason}`, type: "error" });
        await db.from("admin_audit_log").insert({ admin_id: adminId, action: "manual_trade_reject", target_id: tradeId, meta: { reason, via: "telegram_bot" } }).catch(() => {});
        await resolveAdminNotifications("manual_review", tradeId, `❌ <b>Manual Review — Rejected</b>\n\nTrade <code>${tradeId.slice(0, 8)}</code> rejected. Reason: ${reason}`);
        await markProcessed(db, eventKey);
        await sendAdminBotMessage(chatId, `✅ Trade <code>${tradeId.slice(0, 8)}</code> rejected.`);
      } else {
        await sendAdminBotMessage(chatId, `❌ Trade not found or already handled.`);
      }
    } else {
      await sendAdminBotMessage(chatId, `Already processed.`);
    }
    return;
  }

  // /wd_reject_reason <withdrawalId> <reason>
  if (cmd === "/wd_reject_reason" && parts.length >= 3) {
    const withdrawalId = parts[1];
    const reason = parts.slice(2).join(" ");
    const eventKey = `tg_admin_cmd:wd_reject:${withdrawalId}`;
    if (!await isAlreadyProcessed(db, eventKey)) {
      try {
        // §4.2 fix: use rejectWithdrawalImpl (no session cookie) instead of
        // adminRejectWithdrawal createServerFn (would crash — requires auth cookie).
        // Also fixes the field-name mismatch: original passed { withdrawalId } but
        // the createServerFn validator expected { requestId }.
        const { rejectWithdrawalImpl } = await import("./vendors");
        await rejectWithdrawalImpl(db as ReturnType<typeof import("../lib/supabase.server").getServerSupabase>, adminId, withdrawalId, reason);
        await db.from("admin_audit_log").insert({ admin_id: adminId, action: "reject_withdrawal", target_id: withdrawalId, meta: { reason, via: "telegram_bot" } }).catch(() => {});
        await resolveAdminNotifications("withdrawal", withdrawalId, `❌ <b>Withdrawal — Rejected</b>\n\nWithdrawal <code>${withdrawalId.slice(0, 8)}</code> rejected. Reason: ${reason}`);
        await markProcessed(db, eventKey);
        await sendAdminBotMessage(chatId, `✅ Withdrawal <code>${withdrawalId.slice(0, 8)}</code> rejected.`);
      } catch {
        await sendAdminBotMessage(chatId, `❌ Failed to reject withdrawal.`);
      }
    } else {
      await sendAdminBotMessage(chatId, `Already processed.`);
    }
    return;
  }

  // /kyc_reject_reason <userId> <reason>
  if (cmd === "/kyc_reject_reason" && parts.length >= 3) {
    const userId = parts[1];
    const reason = parts.slice(2).join(" ");
    const eventKey = `tg_admin_cmd:kyc_reject:${userId}`;
    if (!await isAlreadyProcessed(db, eventKey)) {
      await db.from("profiles").update({ kyc_status: "rejected" }).eq("id", userId);
      await db.from("notifications").insert({ user_id: userId, title: "KYC Needs Attention", message: `Your KYC was not approved: ${reason}. Please re-submit.`, type: "error" });
      await db.from("admin_audit_log").insert({ admin_id: adminId, action: "kyc_reject", target_id: userId, meta: { reason, via: "telegram_bot" } }).catch(() => {});
      await resolveAdminNotifications("kyc", userId, `❌ <b>KYC — Rejected</b>\n\nUser <code>${userId.slice(0, 8)}</code> KYC rejected. Reason: ${reason}`);
      await markProcessed(db, eventKey);
      await sendAdminBotMessage(chatId, `✅ KYC for <code>${userId.slice(0, 8)}</code> rejected.`);
    } else {
      await sendAdminBotMessage(chatId, `Already processed.`);
    }
    return;
  }

  // Unknown — show help
  await sendAdminBotMessage(chatId, [
    `<b>7SEVEN Admin Bot</b>`,
    ``,
    `<b>Commands:</b>`,
    `/start &lt;code&gt; — link your account`,
    `/whoami — show linked admin info`,
    `/reply &lt;ticketId&gt; &lt;message&gt; — reply to support ticket`,
    `/mr_reject_reason &lt;tradeId&gt; &lt;reason&gt; — reject a manual review trade`,
    `/wd_reject_reason &lt;withdrawalId&gt; &lt;reason&gt; — reject a withdrawal`,
    `/kyc_reject_reason &lt;userId&gt; &lt;reason&gt; — reject a KYC submission`,
  ].join("\n"));
}

// ─── Main webhook handler (exported, called from server.ts) ───────────────────
export async function handleAdminTelegramWebhook(request: Request): Promise<Response> {
  const ok = new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

  // Validate secret token
  const webhookSecret = process.env.ADMIN_TELEGRAM_WEBHOOK_SECRET;
  if (webhookSecret) {
    const incomingSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (incomingSecret !== webhookSecret) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    }
  }

  let update: TelegramUpdate;
  try {
    update = (await request.json()) as TelegramUpdate;
  } catch {
    return ok;
  }

  // Process async — return 200 immediately (Telegram timeout is 5s)
  Promise.resolve().then(async () => {
    try {
      const db = getAdminDb();

      if (update.callback_query) {
        const cq = update.callback_query;
        const chatId = cq.message?.chat.id ?? cq.from.id;
        const adminId = await getLinkedAdminId(db, cq.from.id);
        if (!adminId) {
          await answerCallbackQuery(cq.id, "⚠️ Not linked to an admin account.", true);
          return;
        }
        if (cq.data) {
          await handleCallback(db, cq.id, cq.data, chatId, adminId);
        }
        return;
      }

      if (update.message?.text) {
        const msg = update.message;
        const chatId = msg.chat.id;
        const adminId = await getLinkedAdminId(db, msg.from?.id ?? chatId);
        await handleTextCommand(db, chatId, msg.text, msg.from?.username, adminId);
      }
    } catch (e) {
      console.error("[AdminTelegramWebhook] Unhandled error:", e);
    }
  });

  return ok;
}
