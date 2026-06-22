// ─────────────────────────────────────────────────────────────────────────────
// Admin Telegram Bot — Server Functions
// Links admin accounts to Telegram, generates one-time link codes,
// and sends fan-out notifications (manual review, withdrawals, KYC, disputes).
// Uses ADMIN_TELEGRAM_BOT_TOKEN (separate from the vendor bot).
// ─────────────────────────────────────────────────────────────────────────────

import { createServerFn } from "@tanstack/react-start";
import { getServerSupabase } from "../lib/supabase.server";
import { getEnv } from "../lib/worker-env";
import { requireAdmin } from "../lib/auth-server";
import { isAdminBotConfigured, fanOutToAdmins } from "../lib/telegram";

const CODE_TTL_MINUTES = 10;

// ─── Generate a one-time link code for the current admin ──────────────────────
// The admin DMs /start <code> to the admin bot to link their Telegram.
export const generateAdminTelegramLinkCode = createServerFn({ method: "POST" })
  .validator((d: Record<string, never>) => d)
  .handler(async () => {
    const adminId = await requireAdmin();
    if (!isAdminBotConfigured()) {
      return { success: false, error: "Admin bot token not configured (ADMIN_TELEGRAM_BOT_TOKEN)." };
    }

    const db = getServerSupabase();
    const code = crypto.randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase();
    const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60_000).toISOString();

    await db.from("admin_telegram_link_codes").insert({
      code,
      admin_id: adminId,
      expires_at: expiresAt,
    });

    const botUsername = getEnv("ADMIN_TELEGRAM_BOT_USERNAME") ?? "SevenCardsAdminBot";
    return {
      success: true,
      code,
      expiresAt,
      deepLink: `https://t.me/${botUsername}?start=${code}`,
      instructions: `Open Telegram and start a chat with @${botUsername}, then send /start ${code} to link your account.`,
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

// ─── Unlink admin Telegram ────────────────────────────────────────────────────
export const unlinkAdminTelegram = createServerFn({ method: "POST" })
  .validator((d: Record<string, never>) => d)
  .handler(async () => {
    const adminId = await requireAdmin();
    const db = getServerSupabase();
    await db.from("admin_telegram_links").delete().eq("admin_id", adminId);
    return { success: true };
  });

// ─── Internal: get all linked admin chat IDs ─────────────────────────────────
export async function getAllLinkedAdminChatIds(): Promise<bigint[]> {
  try {
    const { createClient } = await import("@supabase/supabase-js");
    const db = createClient(
      getEnv("VITE_SUPABASE_URL") ?? "",
      getEnv("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { autoRefreshToken: false, persistSession: false } }
    );
    const { data } = await db.from("admin_telegram_links").select("telegram_chat_id");
    return (data ?? []).map((r: { telegram_chat_id: number }) => BigInt(r.telegram_chat_id));
  } catch {
    return [];
  }
}

// ─── Internal: send a fan-out notification + track in DB ─────────────────────
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
      getEnv("VITE_SUPABASE_URL") ?? "",
      getEnv("SUPABASE_SERVICE_ROLE_KEY") ?? "",
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

// ─── Internal: resolve all fan-out copies (edit all admin messages) ───────────
export async function resolveAdminNotifications(
  itemType: string,
  itemId: string,
  resolvedText: string,
): Promise<void> {
  if (!isAdminBotConfigured()) return;

  try {
    const { createClient } = await import("@supabase/supabase-js");
    const db = createClient(
      getEnv("VITE_SUPABASE_URL") ?? "",
      getEnv("SUPABASE_SERVICE_ROLE_KEY") ?? "",
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

// ─── Push notification: new manual review trade ────────────────────────────────
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
      { text: "❌ Reject", callback_data: `mr_reject:${opts.tradeId}` },
    ]],
  });
}

// ─── Push notification: new withdrawal request ────────────────────────────────
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
      { text: "❌ Reject", callback_data: `wd_reject:${opts.withdrawalId}` },
    ]],
  });
}

// ─── Push notification: new KYC submission ────────────────────────────────────
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
      { text: "❌ Reject KYC", callback_data: `kyc_reject:${opts.userId}` },
    ]],
  });
}

// ─── Push notification: new vendor rate submission ────────────────────────────
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
      { text: "❌ Reject Rate", callback_data: `vr_reject:${opts.vendorId}` },
    ]],
  });
}
