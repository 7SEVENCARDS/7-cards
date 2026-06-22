// ─────────────────────────────────────────────────────────────────────────────
// Telegram Bot API helper — vendor bot + admin bot
// VENDOR BOT: TELEGRAM_BOT_TOKEN, webhook at /api/webhooks/telegram
// ADMIN BOT:  ADMIN_TELEGRAM_BOT_TOKEN, webhook at /api/webhooks/telegram-admin
// All outbound calls use fetchWithTimeout (P1-8 fix).
// ─────────────────────────────────────────────────────────────────────────────

import { fetchWithTimeout } from "./fetch-with-timeout";
import { getEnv } from "./worker-env";

const TELEGRAM_API = "https://api.telegram.org";

// ── Token helpers ─────────────────────────────────────────────────────────────
function getVendorBotToken() {
  return getEnv("TELEGRAM_BOT_TOKEN") ?? "";
}

function getAdminBotToken() {
  return getEnv("ADMIN_TELEGRAM_BOT_TOKEN") ?? "";
}

export function isTelegramConfigured() {
  return !!getEnv("TELEGRAM_BOT_TOKEN");
}

export function isAdminBotConfigured() {
  return !!getEnv("ADMIN_TELEGRAM_BOT_TOKEN");
}

// ── Generic send (shared by both bots) ───────────────────────────────────────
async function sendMessage(
  token: string,
  chatId: string | number,
  text: string,
  extra: Record<string, unknown> = {},
): Promise<{ ok: boolean; messageId?: number; error?: string }> {
  if (!token) return { ok: false, error: "Bot token not set" };
  try {
    const res = await fetchWithTimeout(`${TELEGRAM_API}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        ...extra,
      }),
    });
    const data = (await res.json()) as { ok: boolean; result?: { message_id: number }; description?: string };
    if (!data.ok) return { ok: false, error: data.description };
    return { ok: true, messageId: data.result?.message_id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Network error" };
  }
}

// ── Vendor bot: send message ──────────────────────────────────────────────────
export async function sendTelegramMessage(
  chatId: string | number,
  text: string,
  parseMode: "HTML" | "Markdown" | "MarkdownV2" = "HTML",
): Promise<{ ok: boolean; messageId?: number; error?: string }> {
  const token = getVendorBotToken();
  if (!token) return { ok: false, error: "TELEGRAM_BOT_TOKEN not set" };
  try {
    const res = await fetchWithTimeout(`${TELEGRAM_API}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: parseMode,
        disable_web_page_preview: true,
      }),
    });
    const data = (await res.json()) as { ok: boolean; result?: { message_id: number }; description?: string };
    if (!data.ok) return { ok: false, error: data.description };
    return { ok: true, messageId: data.result?.message_id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Network error" };
  }
}

// ── Admin bot: send message with optional inline keyboard ─────────────────────
export async function sendAdminBotMessage(
  chatId: string | number,
  text: string,
  inlineKeyboard?: Array<Array<{ text: string; callback_data: string }>>,
): Promise<{ ok: boolean; messageId?: number; error?: string }> {
  const token = getAdminBotToken();
  const extra: Record<string, unknown> = {};
  if (inlineKeyboard) {
    extra.reply_markup = { inline_keyboard: inlineKeyboard };
  }
  return sendMessage(token, chatId, text, extra);
}

// ── Admin bot: edit message text ──────────────────────────────────────────────
export async function editAdminBotMessage(
  chatId: string | number,
  messageId: number,
  text: string,
  inlineKeyboard?: Array<Array<{ text: string; callback_data: string }>>,
): Promise<{ ok: boolean; error?: string }> {
  const token = getAdminBotToken();
  if (!token) return { ok: false, error: "ADMIN_TELEGRAM_BOT_TOKEN not set" };
  try {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    };
    if (inlineKeyboard) body.reply_markup = { inline_keyboard: inlineKeyboard };
    const res = await fetchWithTimeout(`${TELEGRAM_API}/bot${token}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as { ok: boolean; description?: string };
    return { ok: data.ok, error: data.description };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Network error" };
  }
}

// ── Admin bot: answer callback query (clears loading spinner) ─────────────────
export async function answerCallbackQuery(
  callbackQueryId: string,
  text?: string,
  showAlert = false,
): Promise<void> {
  const token = getAdminBotToken();
  if (!token) return;
  try {
    await fetchWithTimeout(`${TELEGRAM_API}/bot${token}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: showAlert }),
    });
  } catch { /* non-critical */ }
}

// ── Register webhook ──────────────────────────────────────────────────────────
export async function registerTelegramWebhook(webhookUrl: string, secretToken?: string): Promise<boolean> {
  const token = getVendorBotToken();
  if (!token) return false;
  try {
    const res = await fetchWithTimeout(`${TELEGRAM_API}/bot${token}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: webhookUrl,
        allowed_updates: ["message"],
        ...(secretToken ? { secret_token: secretToken } : {}),
      }),
    });
    const data = (await res.json()) as { ok: boolean };
    return data.ok;
  } catch { return false; }
}

export async function registerAdminTelegramWebhook(webhookUrl: string, secretToken?: string): Promise<boolean> {
  const token = getAdminBotToken();
  if (!token) return false;
  try {
    const res = await fetchWithTimeout(`${TELEGRAM_API}/bot${token}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: webhookUrl,
        allowed_updates: ["message", "callback_query"],
        ...(secretToken ? { secret_token: secretToken } : {}),
      }),
    });
    const data = (await res.json()) as { ok: boolean };
    return data.ok;
  } catch { return false; }
}

// ── Fan-out: send to all linked admin chats ────────────────────────────────────
// Returns array of {chatId, messageId} for resolving later.
export async function fanOutToAdmins(
  adminChatIds: bigint[],
  text: string,
  inlineKeyboard?: Array<Array<{ text: string; callback_data: string }>>,
): Promise<Array<{ chatId: bigint; messageId: number }>> {
  const sent: Array<{ chatId: bigint; messageId: number }> = [];
  for (const chatId of adminChatIds) {
    const result = await sendAdminBotMessage(Number(chatId), text, inlineKeyboard);
    if (result.ok && result.messageId) {
      sent.push({ chatId, messageId: result.messageId });
    }
  }
  return sent;
}

// ── Vendor bot: message builders ──────────────────────────────────────────────
export function buildBroadcastMessage(opts: {
  vendorName: string;
  brand: string;
  amountUsd: number;
  amountNgn: number;
  broadcastId: string;
  expiresMinutes?: number;
}): string {
  return [
    `🃏 <b>Card Available — 7SEVEN CARDS</b>`,
    ``,
    `Hey ${opts.vendorName}! A new card just came in.`,
    ``,
    `🎁 <b>Brand:</b> ${opts.brand}`,
    `💵 <b>Value:</b> $${opts.amountUsd.toFixed(2)} USD`,
    `💰 <b>NGN Payout:</b> ₦${Math.round(opts.amountNgn).toLocaleString()}`,
    ``,
    `⚡ <b>Reply YES to claim it.</b>`,
    `First vendor to reply gets assigned.`,
    ``,
    `⏳ Offer expires in ${opts.expiresMinutes ?? 15} minutes.`,
    `Ref: <code>${opts.broadcastId.slice(0, 8)}</code>`,
  ].join("\n");
}

export function buildCardAssignmentMessage(opts: {
  brand: string;
  amountUsd: number;
  amountNgn: number;
  cardCode: string;
  cardPin?: string | null;
  assignmentId: string;
  vendorName: string;
  portalUrl: string;
}): string {
  const pin = opts.cardPin ? `\n🔑 <b>PIN:</b> <code>${opts.cardPin}</code>` : "";
  return [
    `🎉 <b>You Got It! Card Assigned — 7SEVEN CARDS</b>`,
    ``,
    `Hi ${opts.vendorName}! You claimed the card first.`,
    ``,
    `🎁 <b>Brand:</b> ${opts.brand}`,
    `💵 <b>Value:</b> $${opts.amountUsd.toFixed(2)} USD`,
    `💰 <b>NGN Payout:</b> ₦${Math.round(opts.amountNgn).toLocaleString()}`,
    ``,
    `🔐 <b>Card Code:</b> <code>${opts.cardCode}</code>${pin}`,
    ``,
    `👉 Redeem the card and await your payment account below.`,
    ``,
    `Ref: <code>${opts.assignmentId.slice(0, 8)}</code>`,
  ].join("\n");
}

export function buildVANPaymentMessage(opts: {
  vendorName: string;
  accountNumber: string;
  bankName: string;
  accountName: string;
  amountNgn: number;
  assignmentId: string;
  expiresAt?: string;
}): string {
  const expiry = opts.expiresAt
    ? `\n⏰ <b>Expires:</b> ${new Date(opts.expiresAt).toLocaleString("en-NG", { timeZone: "Africa/Lagos", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "short" })} WAT`
    : "";
  return [
    `💳 <b>Payment Account Ready — 7SEVEN CARDS</b>`,
    ``,
    `Hi ${opts.vendorName}! Transfer the exact amount below to complete this trade:`,
    ``,
    `🏦 <b>Bank:</b> ${opts.bankName}`,
    `📱 <b>Account Number:</b> <code>${opts.accountNumber}</code>`,
    `👤 <b>Account Name:</b> ${opts.accountName}`,
    `💰 <b>Amount:</b> <b>₦${Math.round(opts.amountNgn).toLocaleString()}</b>`,
    `${expiry}`,
    ``,
    `⚠️ Transfer the <b>exact amount</b>. The user is credited automatically once payment clears.`,
    ``,
    `Ref: <code>${opts.assignmentId.slice(0, 8)}</code>`,
  ].filter(Boolean).join("\n");
}

export function buildAlreadyClaimedMessage(): string {
  return [
    `⚡ <b>Too Slow!</b>`,
    ``,
    `Another vendor already claimed this card.`,
    `Stay tuned — the next one could be yours!`,
    ``,
    `🔗 7SEVEN Vendor Portal: https://7evencards.xyz/vendor`,
  ].join("\n");
}

export async function sendVendorCardNotification(opts: {
  telegramChatId: string | number;
  vendorName: string;
  brand: string;
  amountUsd: number;
  amountNgn: number;
  cardCode: string;
  cardPin?: string | null;
  assignmentId: string;
  portalUrl?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const text = buildCardAssignmentMessage({
    ...opts,
    portalUrl: opts.portalUrl ?? "https://7evencards.xyz",
  });
  return sendTelegramMessage(opts.telegramChatId, text, "HTML");
}

export async function sendWithdrawalApprovedNotification(opts: {
  telegramChatId: string | number;
  vendorName: string;
  amountNgn: number;
  bankName: string;
  accountNumber: string;
  squadcoRef: string;
}): Promise<{ ok: boolean; error?: string }> {
  const text = [
    `✅ <b>Withdrawal Approved — 7SEVEN CARDS</b>`,
    ``,
    `Hi ${opts.vendorName}! Your withdrawal has been processed.`,
    ``,
    `💸 <b>Amount:</b> ₦${opts.amountNgn.toLocaleString()}`,
    `🏦 <b>Bank:</b> ${opts.bankName}`,
    `💳 <b>Account:</b> ${opts.accountNumber}`,
    ``,
    `Your funds are on their way. Please allow up to 10 minutes for the credit to reflect.`,
    ``,
    `📋 Ref: <code>${opts.squadcoRef.slice(0, 16)}</code>`,
  ].join("\n");
  return sendTelegramMessage(opts.telegramChatId, text, "HTML");
}

export async function sendTierPromotionNotification(opts: {
  telegramChatId: string | number;
  vendorName: string;
  totalRedeemed: number;
}): Promise<{ ok: boolean; error?: string }> {
  const text = [
    `⭐ <b>Congratulations — You're Now a Premium Vendor!</b>`,
    ``,
    `Hi ${opts.vendorName}! Your hard work has paid off. 🎉`,
    ``,
    `You've been <b>promoted to Premium tier</b> on 7SEVEN CARDS.`,
    ``,
    `📊 Cards redeemed so far: <b>${opts.totalRedeemed}</b>`,
    ``,
    `<b>Premium perks:</b>`,
    `• Priority card assignments`,
    `• Higher daily limits`,
    `• Dedicated support`,
    `• Early access to high-value cards`,
    ``,
    `Keep up the great work! 🚀`,
    `🔗 https://7evencards.xyz/vendor`,
  ].join("\n");
  return sendTelegramMessage(opts.telegramChatId, text, "HTML");
}

export async function sendWithdrawalRejectedNotification(opts: {
  telegramChatId: string | number;
  vendorName: string;
  amountNgn: number;
  reason?: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  const reasonLine = opts.reason ? `\n📝 <b>Reason:</b> ${opts.reason}` : "";
  const text = [
    `❌ <b>Withdrawal Rejected — 7SEVEN CARDS</b>`,
    ``,
    `Hi ${opts.vendorName}, your withdrawal request has been rejected.`,
    ``,
    `💰 <b>Amount:</b> ₦${opts.amountNgn.toLocaleString()} has been <b>returned to your wallet</b>.${reasonLine}`,
    ``,
    `If you think this is a mistake, please contact support or submit a new request with correct bank details.`,
    ``,
    `🔗 Vendor portal: https://7evencards.xyz/vendor`,
  ].join("\n");
  return sendTelegramMessage(opts.telegramChatId, text, "HTML");
}
