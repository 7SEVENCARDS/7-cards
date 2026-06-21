// =============================================================================
// Admin Telegram Bot — Server Functions
//
// Covers:
//   • Admin account ↔ Telegram linking (one-time codes, admin-only)
//   • Support staff Telegram linking (admin generates codes, staff links)
//   • Fan-out notifications to all linked admins (inline keyboards)
//   • Resolve notifications (edit all admin copies on action)
//   • Typed push helpers: manual_review, withdrawal, KYC, vendor_rate
//   • Webhook registration (admin-only)
//
// Bot separation:
//   ADMIN_TELEGRAM_BOT_TOKEN   — admin bot (approve/reject actions)
//   SUPPORT_TELEGRAM_CHAT_ID   — group/channel that receives support tickets
//
// Only admins (profiles.role = 'admin') can:
//   - Generate admin link codes
//   - Generate support staff link codes
//   - View/remove support staff
//   - Register webhooks
// =============================================================================

import { createServerFn } from "@tanstack/react-start";
import { getServerSupabase } from "../lib/supabase.server";
import { requireAdmin } from "../lib/auth-server";
import { isAdminBotConfigured, fanOutToAdmins } from "../lib/telegram";

const ADMIN_CODE_TTL_MINUTES = 10;
const STAFF_CODE_TTL_MINUTES = 30;

// =============================================================================
// ADMIN TELEGRAM LINKING
// =============================================================================

// ─── Generate a one-time link code for the current admin ─────────────────────
export const generateAdminTelegramLinkCode = createServerFn({ method: "POST" })
  .validator((d: Record<string, never>) => d)
  .handler(async () => {
    const adminId = await requireAdmin();
    if (!isAdminBotConfigured()) {
      return { success: false, error: "Admin bot not configured (ADMIN_TELEGRAM_BOT_TOKEN missing)." };
    }

    const db = getServerSupabase();
    const code = crypto.randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase();
    const expiresAt = new Date(Date.now() + ADMIN_CODE_TTL_MINUTES * 60_000).toISOString();

    const { error } = await db.from("admin_telegram_link_codes").insert({
      code,
      admin_id: adminId,
      expires_at: expiresAt,
    });

    if (error) throw new Error(`Failed to create link code: ${error.message}`);

    const botUsername = process.env.ADMIN_TELEGRAM_BOT_USERNAME ?? "SevenCardsAdminBot";
    return {
      success: true,
      code,
      expiresAt,
      deepLink: `https://t.me/${botUsername}?start=${code}`,
      instructions: `Open Telegram → start a chat with @${botUsername} → send /start ${code}`,
    };
  });

// ─── Check current admin's Telegram link status ───────────────────────────────
export const getAdminTelegramStatus = createServerFn({ method: "GET" })
  .validator((d: Record<string, never>) => d)
  .handler(async () => {
    const adminId = await requireAdmin();
    const db = getServerSupabase();

    const { data: link } = await db
      .from("admin_telegram_links")
      .select("telegram_chat_id, telegram_username, linked_at")
      .eq("admin_id", adminId)
      .maybeSingle();

    return {
      linked: !!link,
      telegramUsername: link?.telegram_username ?? null,
      linkedAt: link?.linked_at ?? null,
    };
  });

// ─── Unlink current admin's Telegram ─────────────────────────────────────────
export const unlinkAdminTelegram = createServerFn({ method: "POST" })
  .validator((d: Record<string, never>) => d)
  .handler(async () => {
    const adminId = await requireAdmin();
    const db = getServerSupabase();
    await db.from("admin_telegram_links").delete().eq("admin_id", adminId);
    return { success: true };
  });

// =============================================================================
// SUPPORT STAFF TELEGRAM MANAGEMENT (admin-only)
// =============================================================================

// ─── Generate a link code for a support staff member ─────────────────────────
// ONLY admins can call this. The code is given to the support staff member
// who then DMs /start <code> to the admin bot. They are then registered as
// support staff — able to use /reply but nothing else.
export const generateSupportStaffLinkCode = createServerFn({ method: "POST" })
  .validator((d: { staffName: string }) => d)
  .handler(async ({ data }) => {
    const adminId = await requireAdmin();
    if (!isAdminBotConfigured()) {
      return { success: false, error: "Admin bot not configured (ADMIN_TELEGRAM_BOT_TOKEN missing)." };
    }
    if (!data.staffName?.trim()) {
      return { success: false, error: "Staff name is required." };
    }

    const db = getServerSupabase();
    const code = "STAFF-" + crypto.randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase();
    const expiresAt = new Date(Date.now() + STAFF_CODE_TTL_MINUTES * 60_000).toISOString();

    const { error } = await db.from("support_staff_telegram_link_codes").insert({
      code,
      staff_name: data.staffName.trim(),
      created_by: adminId,
      expires_at: expiresAt,
    });

    if (error) throw new Error(`Failed to create staff link code: ${error.message}`);

    const botUsername = process.env.ADMIN_TELEGRAM_BOT_USERNAME ?? "SevenCardsAdminBot";
    return {
      success: true,
      code,
      staffName: data.staffName.trim(),
      expiresAt,
      deepLink: `https://t.me/${botUsername}?start=${code}`,
      instructions: `Give ${data.staffName.trim()} this code. They open Telegram → @${botUsername} → send /start ${code}`,
    };
  });

// ─── List all linked support staff ───────────────────────────────────────────
export const getSupportStaffList = createServerFn({ method: "GET" })
  .validator((d: Record<string, never>) => d)
  .handler(async () => {
    await requireAdmin();
    const db = getServerSupabase();

    const { data, error } = await db
      .from("support_staff_telegram_links")
      .select("id, staff_name, telegram_username, linked_at, is_active, added_by_admin_id")
      .order("linked_at", { ascending: false });

    if (error) throw error;
    return (data ?? []) as Array<{
      id: string;
      staff_name: string;
      telegram_username: string | null;
      linked_at: string;
      is_active: boolean;
      added_by_admin_id: string;
    }>;
  });

// ─── Deactivate / remove a support staff member ───────────────────────────────
export const removeSupportStaff = createServerFn({ method: "POST" })
  .validator((d: { linkId: string }) => d)
  .handler(async ({ data }) => {
    await requireAdmin();
    const db = getServerSupabase();

    // Soft-delete: mark inactive (keeps audit trail)
    const { error } = await db
      .from("support_staff_telegram_links")
      .update({ is_active: false })
      .eq("id", data.linkId);

    if (error) throw error;
    return { success: true };
  });

// =============================================================================
// WEBHOOK REGISTRATION (admin-only)
// =============================================================================

// ─── Register both bot webhooks with Telegram ─────────────────────────────────
// Calls setWebhook on the Telegram Bot API for the admin bot.
// The vendor bot webhook is unchanged (handled by existing registration flow).
// Webhook URL: https://<VITE_PUBLIC_BASE_URL>/api/webhooks/telegram-admin
export const registerAdminTelegramWebhook = createServerFn({ method: "POST" })
  .validator((d: Record<string, never>) => d)
  .handler(async () => {
    await requireAdmin();

    const adminBotToken = process.env.ADMIN_TELEGRAM_BOT_TOKEN;
    const webhookSecret = process.env.ADMIN_TELEGRAM_WEBHOOK_SECRET;
    const baseUrl = process.env.VITE_PUBLIC_BASE_URL;

    if (!adminBotToken) return { success: false, error: "ADMIN_TELEGRAM_BOT_TOKEN not set." };
    if (!baseUrl) return { success: false, error: "VITE_PUBLIC_BASE_URL not set." };

    const webhookUrl = `${baseUrl.replace(/\/$/, "")}/api/webhooks/telegram-admin`;

    try {
      const { registerAdminTelegramWebhook: register } = await import("../lib/telegram");
      const result = await register(webhookUrl, webhookSecret);
      return { success: result.ok, webhookUrl, description: result.description ?? null };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  });

// =============================================================================
// INTERNAL HELPERS (not exported as server functions — called server-side only)
// =============================================================================

// ─── Get all linked admin chat IDs ────────────────────────────────────────────
export async function getAllLinkedAdminChatIds(): Promise<bigint[]> {
  try {
    const { createClient } = await import("@supabase/supabase-js");
    const db = createClient(
      process.env.VITE_SUPABASE_URL ?? "",
      process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
      { auth: { autoRefreshToken: false, persistSession: false } }
    );
    const { data } = await db
      .from("admin_telegram_links")
      .select("telegram_chat_id");
    return (data ?? []).map((r: { telegram_chat_id: number }) => BigInt(r.telegram_chat_id));
  } catch {
    return [];
  }
}

// ─── Send a fan-out notification + track in DB ────────────────────────────────
export async function sendAdminNotification(opts: {
  itemType: "manual_review" | "withdrawal" | "kyc" | "vendor_rate" | "dispute" | "fraud" | "payout_failed" | "support";
  itemId: string;
  text: string;
  inlineKeyboard?: Array<Array<{ text: string; callback_data: string }>>;
}): Promise<void> {
  if (!isAdminBotConfigured()) return;

  const chatIds = await getAllLinkedAdminChatIds();
  if (!chatIds.length) return;

  const sent = await fanOutToAdmins(chatIds, opts.text, opts.inlineKeyboard);
  if (!sent.length) return;

  try {
    const { createClient } = await import("@supabase/supabase-js");
    const db = createClient(
      process.env.VITE_SUPABASE_URL ?? "",
      process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
      { auth: { autoRefreshToken: false, persistSession: false } }
    );
    await db.from("admin_telegram_notifications").insert(
      sent.map(({ chatId, messageId }) => ({
        item_type: opts.itemType,
        item_id: opts.itemId,
        telegram_chat_id: Number(chatId),
        telegram_message_id: messageId,
      }))
    );
  } catch (e) {
    console.error("[AdminTelegram] Failed to record notifications:", e);
  }
}

// ─── Resolve all fan-out copies (edit all admin messages to show outcome) ─────
export async function resolveAdminNotifications(
  itemType: string,
  itemId: string,
  resolvedText: string,
): Promise<void> {
  if (!isAdminBotConfigured()) return;

  try {
    const { createClient } = await import("@supabase/supabase-js");
    const db = createClient(
      process.env.VITE_SUPABASE_URL ?? "",
      process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    const { data: notifs } = await db
      .from("admin_telegram_notifications")
      .select("telegram_chat_id, telegram_message_id")
      .eq("item_type", itemType)
      .eq("item_id", itemId)
      .is("resolved_at", null);

    if (!notifs?.length) return;

    const { editAdminBotMessage } = await import("../lib/telegram");
    await Promise.allSettled(
      notifs.map(({ telegram_chat_id, telegram_message_id }: { telegram_chat_id: number; telegram_message_id: number }) =>
        editAdminBotMessage(telegram_chat_id, telegram_message_id, resolvedText)
      )
    );

    await db
      .from("admin_telegram_notifications")
      .update({ resolved_at: new Date().toISOString() })
      .eq("item_type", itemType)
      .eq("item_id", itemId)
      .is("resolved_at", null);
  } catch (e) {
    console.error("[AdminTelegram] resolveAdminNotifications failed:", e);
  }
}

// =============================================================================
// PUSH NOTIFICATION HELPERS
// =============================================================================

export async function notifyAdminManualReview(opts: {
  tradeId: string;
  brand: string;
  amountUsd: number;
  amountNgn: number;
  userName: string;
  userId: string;
}): Promise<void> {
  const text = [
    `🔍 <b>Manual Review Required</b>`,
    ``,
    `<b>Brand:</b> ${opts.brand}`,
    `<b>Value:</b> $${opts.amountUsd.toFixed(2)} · ₦${Math.round(opts.amountNgn).toLocaleString()}`,
    `<b>User:</b> ${opts.userName} [<code>${opts.userId.slice(0, 8)}</code>]`,
    `<b>Trade:</b> <code>${opts.tradeId.slice(0, 8)}</code>`,
    ``,
    `Tap to action:`,
  ].join("\n");

  await sendAdminNotification({
    itemType: "manual_review",
    itemId: opts.tradeId,
    text,
    inlineKeyboard: [[
      { text: "✅ Approve", callback_data: `mr_approve:${opts.tradeId}` },
      { text: "❌ Reject",  callback_data: `mr_reject:${opts.tradeId}` },
    ]],
  });
}

export async function notifyAdminWithdrawal(opts: {
  withdrawalId: string;
  vendorMoniker: string;
  amountNgn: number;
  bankName: string;
  accountNumber: string;
}): Promise<void> {
  const text = [
    `💸 <b>Withdrawal Request</b>`,
    ``,
    `<b>Vendor:</b> ${opts.vendorMoniker}`,
    `<b>Amount:</b> ₦${Math.round(opts.amountNgn).toLocaleString()}`,
    `<b>Bank:</b> ${opts.bankName}`,
    `<b>Account:</b> ****${opts.accountNumber.slice(-4)}`,
    `<b>ID:</b> <code>${opts.withdrawalId.slice(0, 8)}</code>`,
  ].join("\n");

  await sendAdminNotification({
    itemType: "withdrawal",
    itemId: opts.withdrawalId,
    text,
    inlineKeyboard: [[
      { text: "✅ Approve Payout", callback_data: `wd_approve:${opts.withdrawalId}` },
      { text: "❌ Reject",         callback_data: `wd_reject:${opts.withdrawalId}` },
    ]],
  });
}

export async function notifyAdminKYC(opts: {
  userId: string;
  userName: string;
  kycType: string;
}): Promise<void> {
  const text = [
    `🪪 <b>KYC Submission</b>`,
    ``,
    `<b>User:</b> ${opts.userName}`,
    `<b>Type:</b> ${opts.kycType}`,
    `<b>ID:</b> <code>${opts.userId.slice(0, 8)}</code>`,
  ].join("\n");

  await sendAdminNotification({
    itemType: "kyc",
    itemId: opts.userId,
    text,
    inlineKeyboard: [[
      { text: "✅ Approve KYC", callback_data: `kyc_approve:${opts.userId}` },
      { text: "❌ Reject KYC",  callback_data: `kyc_reject:${opts.userId}` },
    ]],
  });
}

export async function notifyAdminVendorRate(opts: {
  vendorId: string;
  vendorMoniker: string;
  pendingRate: number;
  currentRate: number;
}): Promise<void> {
  const delta = opts.pendingRate - opts.currentRate;
  const deltaStr = (delta >= 0 ? "+" : "") + delta.toFixed(2);
  const text = [
    `📈 <b>Vendor Rate Submission</b>`,
    ``,
    `<b>Vendor:</b> ${opts.vendorMoniker}`,
    `<b>Proposed Rate:</b> ₦${opts.pendingRate.toFixed(2)}/$ (${deltaStr} from current ₦${opts.currentRate.toFixed(2)})`,
  ].join("\n");

  await sendAdminNotification({
    itemType: "vendor_rate",
    itemId: opts.vendorId,
    text,
    inlineKeyboard: [[
      { text: "✅ Approve Rate", callback_data: `vr_approve:${opts.vendorId}` },
      { text: "❌ Reject Rate",  callback_data: `vr_reject:${opts.vendorId}` },
    ]],
  });
}
