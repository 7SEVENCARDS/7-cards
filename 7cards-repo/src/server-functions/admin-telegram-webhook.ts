// =============================================================================
// Admin Telegram Bot Webhook Handler
// Route: POST /api/webhooks/telegram-admin
//
// This handler processes all updates from the ADMIN_TELEGRAM_BOT_TOKEN bot.
// It supports TWO classes of users:
//
//   1. ADMINS (linked via admin_telegram_links)
//      Full access: approve/reject trades, KYC, withdrawals, vendor rates,
//      reply to support tickets, /whoami, /start (link admin code),
//      all /reject_reason commands.
//
//   2. SUPPORT STAFF (linked via support_staff_telegram_links)
//      Restricted access: /reply <ticketId> <message> ONLY.
//      Cannot approve/reject anything. Cannot see admin actions.
//
//   3. UNLINKED users
//      Can only /start <code> to link as either admin or support staff.
//
// Inline button callbacks (admin-only):
//   mr_approve:<tradeId>      — approve manual review trade
//   mr_reject:<tradeId>       — prompts /mr_reject_reason command
//   wd_approve:<withdrawalId> — approve vendor withdrawal
//   wd_reject:<withdrawalId>  — prompts /wd_reject_reason command
//   kyc_approve:<userId>      — approve KYC
//   kyc_reject:<userId>       — prompts /kyc_reject_reason command
//   vr_approve:<vendorId>     — approve vendor rate
//   vr_reject:<vendorId>      — reject vendor rate
//
// Security:
//   • X-Telegram-Bot-Api-Secret-Token header validated against
//     ADMIN_TELEGRAM_WEBHOOK_SECRET env var
//   • Callbacks require the chatId to be in admin_telegram_links
//   • /reply works for both admin_telegram_links AND support_staff_telegram_links
//   • All DB writes use SUPABASE_SERVICE_ROLE_KEY (bypasses RLS)
//   • Idempotency: processed_webhook_events prevents double-processing
// =============================================================================

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

// ─── DB client (service role — bypasses all RLS) ──────────────────────────────
function getDb() {
  return createClient(
    process.env.VITE_SUPABASE_URL ?? "",
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

// ─── Idempotency ──────────────────────────────────────────────────────────────
async function isAlreadyProcessed(db: ReturnType<typeof getDb>, eventKey: string): Promise<boolean> {
  const { data } = await db
    .from("processed_webhook_events")
    .select("event_key")
    .eq("event_key", eventKey)
    .maybeSingle();
  return !!data;
}

async function markProcessed(db: ReturnType<typeof getDb>, eventKey: string): Promise<void> {
  await db.from("processed_webhook_events")
    .insert({ event_key: eventKey, source: "telegram_admin_callback", status: "done" })
    .onConflict("event_key").ignore();
}

// ─── Identity resolution ──────────────────────────────────────────────────────
type Identity =
  | { role: "admin";   adminId: string }
  | { role: "support"; staffId: string; staffName: string; isActive: boolean }
  | { role: "none" };

async function resolveIdentity(db: ReturnType<typeof getDb>, telegramUserId: number): Promise<Identity> {
  // Check admin first
  const { data: admin } = await db
    .from("admin_telegram_links")
    .select("admin_id")
    .eq("telegram_chat_id", telegramUserId)
    .maybeSingle();
  if (admin) return { role: "admin", adminId: admin.admin_id };

  // Check support staff
  const { data: staff } = await db
    .from("support_staff_telegram_links")
    .select("id, staff_name, is_active")
    .eq("telegram_chat_id", telegramUserId)
    .maybeSingle();
  if (staff) return { role: "support", staffId: staff.id, staffName: staff.staff_name, isActive: staff.is_active };

  return { role: "none" };
}

// ─── /start <code> — link flow (works for both admin codes and staff codes) ───
async function handleStartCode(
  db: ReturnType<typeof getDb>,
  chatId: number,
  telegramUserId: number,
  username: string | undefined,
  code: string,
): Promise<string> {
  const upperCode = code.toUpperCase().trim();

  // ── Admin link code ──
  if (!upperCode.startsWith("STAFF-")) {
    const { data: linkCode } = await db
      .from("admin_telegram_link_codes")
      .select("admin_id, expires_at, used_at")
      .eq("code", upperCode)
      .maybeSingle();

    if (!linkCode) {
      // Fall through to try staff codes
    } else if (linkCode.used_at) {
      return "⚠️ This admin code has already been used. Generate a new one from the admin panel.";
    } else if (new Date(linkCode.expires_at) < new Date()) {
      return "⏰ This admin code has expired. Generate a new one from the admin panel.";
    } else {
      // Consume code
      await db.from("admin_telegram_link_codes")
        .update({ used_at: new Date().toISOString() })
        .eq("code", upperCode);

      // Upsert link
      await db.from("admin_telegram_links").upsert({
        admin_id: linkCode.admin_id,
        telegram_chat_id: chatId,
        telegram_username: username ?? null,
      }, { onConflict: "telegram_chat_id" });

      return [
        `✅ <b>Admin account linked!</b>`,
        ``,
        `You will now receive real-time notifications for:`,
        `• 🔍 Manual review trades`,
        `• 💸 Vendor withdrawals`,
        `• 🪪 KYC submissions`,
        `• 📈 Vendor rate requests`,
        ``,
        `Use /whoami to confirm your account.`,
      ].join("\n");
    }
  }

  // ── Support staff link code ──
  const { data: staffCode } = await db
    .from("support_staff_telegram_link_codes")
    .select("staff_name, created_by, expires_at, used_at")
    .eq("code", upperCode)
    .maybeSingle();

  if (!staffCode) return "❌ Invalid code. Ask an admin to generate a new one.";
  if (staffCode.used_at) return "⚠️ This code has already been used. Ask an admin for a new one.";
  if (new Date(staffCode.expires_at) < new Date()) return "⏰ This code has expired. Ask an admin for a new one.";

  // Consume code
  await db.from("support_staff_telegram_link_codes")
    .update({ used_at: new Date().toISOString() })
    .eq("code", upperCode);

  // Upsert staff link
  await db.from("support_staff_telegram_links").upsert({
    telegram_chat_id: chatId,
    telegram_username: username ?? null,
    staff_name: staffCode.staff_name,
    added_by_admin_id: staffCode.created_by,
    is_active: true,
  }, { onConflict: "telegram_chat_id" });

  return [
    `✅ <b>Support staff account linked!</b>`,
    ``,
    `Welcome, <b>${staffCode.staff_name}</b>! 👋`,
    ``,
    `You can reply to customer support tickets with:`,
    `<code>/reply &lt;ticketId&gt; your message here</code>`,
    ``,
    `You will see new support tickets posted in the support group.`,
  ].join("\n");
}

// ─── Callback query handler (admin-only) ──────────────────────────────────────
async function handleCallback(
  db: ReturnType<typeof getDb>,
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

  const colonIdx = callbackData.indexOf(":");
  const action = callbackData.slice(0, colonIdx);
  const itemId = callbackData.slice(colonIdx + 1);

  try {
    switch (action) {
      case "mr_approve": await handleManualReviewApprove(db, itemId, adminId, callbackQueryId); break;
      case "mr_reject":
        await sendAdminBotMessage(chatId,
          `To reject trade <code>${itemId.slice(0, 8)}</code>, send:\n/mr_reject_reason ${itemId} your reason`);
        await answerCallbackQuery(callbackQueryId, "Send /mr_reject_reason");
        return;
      case "wd_approve": await handleWithdrawalApprove(db, itemId, adminId, callbackQueryId); break;
      case "wd_reject":
        await sendAdminBotMessage(chatId,
          `To reject withdrawal <code>${itemId.slice(0, 8)}</code>, send:\n/wd_reject_reason ${itemId} your reason`);
        await answerCallbackQuery(callbackQueryId, "Send /wd_reject_reason");
        return;
      case "kyc_approve": await handleKYCApprove(db, itemId, adminId, callbackQueryId); break;
      case "kyc_reject":
        await sendAdminBotMessage(chatId,
          `To reject KYC <code>${itemId.slice(0, 8)}</code>, send:\n/kyc_reject_reason ${itemId} your reason`);
        await answerCallbackQuery(callbackQueryId, "Send /kyc_reject_reason");
        return;
      case "vr_approve": await handleVendorRateApprove(db, itemId, adminId, callbackQueryId); break;
      case "vr_reject":  await handleVendorRateReject(db, itemId, adminId, callbackQueryId);  break;
      default:
        await answerCallbackQuery(callbackQueryId, "Unknown action.", true);
        return;
    }
    await markProcessed(db, eventKey);
  } catch (e) {
    console.error("[AdminTelegramWebhook] Callback error:", e);
    await answerCallbackQuery(callbackQueryId, "⚠️ Action failed. Check logs.", true);
  }
}

// ─── Action handlers ──────────────────────────────────────────────────────────

async function handleManualReviewApprove(
  db: ReturnType<typeof getDb>,
  tradeId: string,
  adminId: string,
  cqId: string,
): Promise<void> {
  const { data: trade } = await db
    .from("trades")
    .update({ status: "verified", requires_manual_review: false })
    .eq("id", tradeId)
    .eq("status", "pending_review")
    .select("id, user_id, brand, amount_usd, amount_ngn, direct_vendor_id, batch_position")
    .maybeSingle();

  if (!trade) { await answerCallbackQuery(cqId, "Already handled.", true); return; }

  await db.from("notifications").insert({
    user_id: trade.user_id,
    title: "Card Verified ✅",
    message: "Your gift card has been manually verified and your payout is being processed.",
    type: "success",
  });
  await db.from("admin_audit_log").insert({
    admin_id: adminId, action: "manual_trade_approve", target_id: tradeId,
    meta: { via: "telegram_bot" },
  }).catch(() => {});

  // Deferred vendor dispatch
  if (trade.direct_vendor_id) {
    Promise.resolve().then(async () => {
      try {
        const { directDispatchToVendor } = await import("./vendor-broadcast");
        await directDispatchToVendor({
          tradeId: trade.id, vendorId: trade.direct_vendor_id!,
          brand: trade.brand, amountUsd: Number(trade.amount_usd),
          amountNgn: Number(trade.amount_ngn),
          batchPosition: trade.batch_position ?? 1, batchTotal: 1,
        });
      } catch (e) { console.error("[AdminTelegramWebhook] Deferred dispatch:", e); }
    });
  }

  await resolveAdminNotifications("manual_review", tradeId,
    `✅ <b>Manual Review — Approved</b>\n\nTrade <code>${tradeId.slice(0, 8)}</code> (${trade.brand} $${trade.amount_usd}) approved.`);
  await answerCallbackQuery(cqId, "✅ Approved and dispatched.");
}

async function handleWithdrawalApprove(
  db: ReturnType<typeof getDb>,
  withdrawalId: string,
  adminId: string,
  cqId: string,
): Promise<void> {
  const { data: wd } = await db
    .from("vendor_withdrawal_requests")
    .select("status, amount_ngn")
    .eq("id", withdrawalId)
    .maybeSingle();

  if (!wd) { await answerCallbackQuery(cqId, "Not found.", true); return; }
  if (wd.status !== "pending") { await answerCallbackQuery(cqId, "Already processed.", true); return; }

  const { adminApproveWithdrawal } = await import("./vendors");
  await adminApproveWithdrawal({ data: { withdrawalId } });
  await db.from("admin_audit_log").insert({
    admin_id: adminId, action: "approve_withdrawal", target_id: withdrawalId,
    meta: { via: "telegram_bot" },
  }).catch(() => {});

  await resolveAdminNotifications("withdrawal", withdrawalId,
    `✅ <b>Withdrawal — Approved</b>\n\n<code>${withdrawalId.slice(0, 8)}</code> ₦${Number(wd.amount_ngn).toLocaleString()} approved.`);
  await answerCallbackQuery(cqId, "✅ Withdrawal approved.");
}

async function handleKYCApprove(
  db: ReturnType<typeof getDb>,
  userId: string,
  adminId: string,
  cqId: string,
): Promise<void> {
  await db.from("profiles").update({ kyc_status: "verified" }).eq("id", userId);
  await db.from("notifications").insert({
    user_id: userId,
    title: "KYC Approved! ✅",
    message: "Your identity has been verified. You can now trade without limits.",
    type: "success",
  });
  await db.from("admin_audit_log").insert({
    admin_id: adminId, action: "kyc_approve", target_id: userId,
    meta: { via: "telegram_bot" },
  }).catch(() => {});
  await resolveAdminNotifications("kyc", userId,
    `✅ <b>KYC — Approved</b>\n\nUser <code>${userId.slice(0, 8)}</code> verified.`);
  await answerCallbackQuery(cqId, "✅ KYC approved.");
}

async function handleVendorRateApprove(
  db: ReturnType<typeof getDb>,
  vendorId: string,
  adminId: string,
  cqId: string,
): Promise<void> {
  await db.rpc("approve_vendor_rate", { p_vendor_id: vendorId, p_admin_id: adminId });
  await db.from("admin_audit_log").insert({
    admin_id: adminId, action: "approve_vendor_rate", target_id: vendorId,
    meta: { via: "telegram_bot" },
  }).catch(() => {});
  await resolveAdminNotifications("vendor_rate", vendorId,
    `✅ <b>Vendor Rate — Approved</b>\n\nVendor <code>${vendorId.slice(0, 8)}</code> rate approved.`);
  await answerCallbackQuery(cqId, "✅ Rate approved.");
}

async function handleVendorRateReject(
  db: ReturnType<typeof getDb>,
  vendorId: string,
  adminId: string,
  cqId: string,
): Promise<void> {
  await db.rpc("reject_vendor_rate", { p_vendor_id: vendorId, p_admin_id: adminId });
  await db.from("admin_audit_log").insert({
    admin_id: adminId, action: "reject_vendor_rate", target_id: vendorId,
    meta: { via: "telegram_bot" },
  }).catch(() => {});
  await resolveAdminNotifications("vendor_rate", vendorId,
    `❌ <b>Vendor Rate — Rejected</b>\n\nVendor <code>${vendorId.slice(0, 8)}</code> rate rejected.`);
  await answerCallbackQuery(cqId, "Rate rejected.");
}

// ─── Text command router ──────────────────────────────────────────────────────
async function handleTextCommand(
  db: ReturnType<typeof getDb>,
  chatId: number,
  telegramUserId: number,
  text: string,
  username: string | undefined,
  identity: Identity,
): Promise<void> {
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();

  // /start <code> — works for anyone (links admin or support staff)
  if (cmd === "/start" && parts[1]) {
    const reply = await handleStartCode(db, chatId, telegramUserId, username, parts[1]);
    await sendAdminBotMessage(chatId, reply);
    return;
  }

  // Unlinked — can only /start
  if (identity.role === "none") {
    await sendAdminBotMessage(chatId,
      "⚠️ Your Telegram is not linked. Ask an admin to generate a link code for you.");
    return;
  }

  // Support staff — /reply only
  if (identity.role === "support") {
    if (!identity.isActive) {
      await sendAdminBotMessage(chatId, "⚠️ Your support staff access has been deactivated. Contact an admin.");
      return;
    }

    if (cmd === "/reply" && parts.length >= 3) {
      const ticketId = parts[1];
      const message = parts.slice(2).join(" ");
      // Use staff's link ID as the "admin_id" in the audit log
      const ok = await adminReplyToTicket(ticketId, message, identity.staffId);
      await sendAdminBotMessage(chatId,
        ok
          ? `✅ Reply sent to ticket <code>${ticketId.slice(0, 8)}</code>.`
          : `❌ Ticket not found: <code>${ticketId.slice(0, 8)}</code>.`
      );
    } else {
      await sendAdminBotMessage(chatId,
        `<b>Support Staff Commands:</b>\n\n/reply &lt;ticketId&gt; &lt;message&gt; — reply to a support ticket`);
    }
    return;
  }

  // ADMIN — full access
  const { adminId } = identity as { role: "admin"; adminId: string };

  if (cmd === "/whoami") {
    const { data: admin } = await db.from("profiles")
      .select("full_name, role").eq("id", adminId).maybeSingle();
    await sendAdminBotMessage(chatId,
      `👤 <b>Admin Account</b>\nName: ${admin?.full_name ?? "Unknown"}\nRole: ${admin?.role ?? "admin"}\nID: <code>${adminId.slice(0, 8)}</code>`);
    return;
  }

  if (cmd === "/reply" && parts.length >= 3) {
    const ticketId = parts[1];
    const message = parts.slice(2).join(" ");
    const ok = await adminReplyToTicket(ticketId, message, adminId);
    await sendAdminBotMessage(chatId,
      ok
        ? `✅ Reply sent to ticket <code>${ticketId.slice(0, 8)}</code>.`
        : `❌ Ticket not found: <code>${ticketId.slice(0, 8)}</code>.`);
    return;
  }

  if (cmd === "/mr_reject_reason" && parts.length >= 3) {
    const tradeId = parts[1];
    const reason = parts.slice(2).join(" ");
    const eventKey = `tg_admin_cmd:mr_reject:${tradeId}`;
    if (await isAlreadyProcessed(db, eventKey)) {
      await sendAdminBotMessage(chatId, "Already processed."); return;
    }
    const { data: updated } = await db.from("trades")
      .update({ status: "invalid", requires_manual_review: false, failure_reason: reason })
      .eq("id", tradeId).eq("status", "pending_review")
      .select("user_id").maybeSingle();
    if (updated) {
      await db.from("notifications").insert({
        user_id: updated.user_id, title: "Card Rejected",
        message: `Your gift card was not accepted: ${reason}`, type: "error",
      });
      await db.from("admin_audit_log").insert({
        admin_id: adminId, action: "manual_trade_reject", target_id: tradeId,
        meta: { reason, via: "telegram_bot" },
      }).catch(() => {});
      await resolveAdminNotifications("manual_review", tradeId,
        `❌ <b>Manual Review — Rejected</b>\n\nTrade <code>${tradeId.slice(0, 8)}</code> rejected.\nReason: ${reason}`);
      await markProcessed(db, eventKey);
      await sendAdminBotMessage(chatId, `✅ Trade <code>${tradeId.slice(0, 8)}</code> rejected.`);
    } else {
      await sendAdminBotMessage(chatId, `❌ Trade not found or already handled.`);
    }
    return;
  }

  if (cmd === "/wd_reject_reason" && parts.length >= 3) {
    const withdrawalId = parts[1];
    const reason = parts.slice(2).join(" ");
    const eventKey = `tg_admin_cmd:wd_reject:${withdrawalId}`;
    if (await isAlreadyProcessed(db, eventKey)) {
      await sendAdminBotMessage(chatId, "Already processed."); return;
    }
    try {
      const { adminRejectWithdrawal } = await import("./vendors");
      await adminRejectWithdrawal({ data: { withdrawalId, reason } });
      await db.from("admin_audit_log").insert({
        admin_id: adminId, action: "reject_withdrawal", target_id: withdrawalId,
        meta: { reason, via: "telegram_bot" },
      }).catch(() => {});
      await resolveAdminNotifications("withdrawal", withdrawalId,
        `❌ <b>Withdrawal — Rejected</b>\n\n<code>${withdrawalId.slice(0, 8)}</code> rejected.\nReason: ${reason}`);
      await markProcessed(db, eventKey);
      await sendAdminBotMessage(chatId, `✅ Withdrawal <code>${withdrawalId.slice(0, 8)}</code> rejected.`);
    } catch {
      await sendAdminBotMessage(chatId, `❌ Failed to reject withdrawal.`);
    }
    return;
  }

  if (cmd === "/kyc_reject_reason" && parts.length >= 3) {
    const userId = parts[1];
    const reason = parts.slice(2).join(" ");
    const eventKey = `tg_admin_cmd:kyc_reject:${userId}`;
    if (await isAlreadyProcessed(db, eventKey)) {
      await sendAdminBotMessage(chatId, "Already processed."); return;
    }
    await db.from("profiles").update({ kyc_status: "rejected" }).eq("id", userId);
    await db.from("notifications").insert({
      user_id: userId, title: "KYC Needs Attention",
      message: `Your KYC was not approved: ${reason}. Please re-submit.`, type: "error",
    });
    await db.from("admin_audit_log").insert({
      admin_id: adminId, action: "kyc_reject", target_id: userId,
      meta: { reason, via: "telegram_bot" },
    }).catch(() => {});
    await resolveAdminNotifications("kyc", userId,
      `❌ <b>KYC — Rejected</b>\n\nUser <code>${userId.slice(0, 8)}</code> rejected.\nReason: ${reason}`);
    await markProcessed(db, eventKey);
    await sendAdminBotMessage(chatId, `✅ KYC <code>${userId.slice(0, 8)}</code> rejected.`);
    return;
  }

  // Fallback: help
  await sendAdminBotMessage(chatId, [
    `<b>7SEVEN Admin Bot</b>`,
    ``,
    `<b>Commands:</b>`,
    `/start &lt;code&gt; — link your account`,
    `/whoami — show linked admin`,
    `/reply &lt;ticketId&gt; &lt;message&gt; — reply to support ticket`,
    `/mr_reject_reason &lt;tradeId&gt; &lt;reason&gt; — reject manual review trade`,
    `/wd_reject_reason &lt;withdrawalId&gt; &lt;reason&gt; — reject withdrawal`,
    `/kyc_reject_reason &lt;userId&gt; &lt;reason&gt; — reject KYC`,
  ].join("\n"));
}

// =============================================================================
// Main webhook handler — exported, mounted in server.ts
// =============================================================================
export async function handleAdminTelegramWebhook(request: Request): Promise<Response> {
  const ok200 = new Response(JSON.stringify({ ok: true }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });

  // Validate secret header
  const webhookSecret = process.env.ADMIN_TELEGRAM_WEBHOOK_SECRET;
  if (webhookSecret) {
    const incoming = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (incoming !== webhookSecret) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    }
  }

  let update: TelegramUpdate;
  try {
    update = (await request.json()) as TelegramUpdate;
  } catch {
    return ok200;
  }

  // Return 200 immediately — process async (Telegram retries if we time out)
  Promise.resolve().then(async () => {
    try {
      const db = getDb();

      if (update.callback_query) {
        const cq = update.callback_query;
        const chatId = cq.message?.chat.id ?? cq.from.id;
        const identity = await resolveIdentity(db, cq.from.id);

        // Callbacks are admin-only
        if (identity.role !== "admin") {
          await answerCallbackQuery(cq.id, "⚠️ Admin access required.", true);
          return;
        }
        if (cq.data) {
          await handleCallback(db, cq.id, cq.data, chatId, identity.adminId);
        }
        return;
      }

      if (update.message?.text) {
        const msg = update.message;
        const chatId = msg.chat.id;
        const telegramUserId = msg.from?.id ?? chatId;
        const identity = await resolveIdentity(db, telegramUserId);
        await handleTextCommand(db, chatId, telegramUserId, msg.text, msg.from?.username, identity);
      }
    } catch (e) {
      console.error("[AdminTelegramWebhook] Unhandled error:", e);
    }
  });

  return ok200;
}
