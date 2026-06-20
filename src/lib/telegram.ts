// ─────────────────────────────────────────────────────────────────────────────
// Telegram Bot API helper — for vendor notifications
// Set TELEGRAM_BOT_TOKEN in env to enable.
// Vendors must /start the bot before messages can be delivered.
// ─────────────────────────────────────────────────────────────────────────────

const TELEGRAM_API = "https://api.telegram.org";

function getBotToken() {
  return process.env.TELEGRAM_BOT_TOKEN ?? "";
}

export function isTelegramConfigured() {
  return !!process.env.TELEGRAM_BOT_TOKEN;
}

export async function sendTelegramMessage(
  chatId: string | number,
  text: string,
  parseMode: "HTML" | "Markdown" | "MarkdownV2" = "HTML"
): Promise<{ ok: boolean; error?: string }> {
  const token = getBotToken();
  if (!token) return { ok: false, error: "TELEGRAM_BOT_TOKEN not set" };

  try {
    const res = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: parseMode,
        disable_web_page_preview: true,
      }),
    });
    const data = (await res.json()) as { ok: boolean; description?: string };
    if (!data.ok) return { ok: false, error: data.description };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Network error" };
  }
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
    `🃏 <b>New Card Assignment — 7SEVEN CARDS</b>`,
    ``,
    `Hi ${opts.vendorName}! You have a new card to redeem.`,
    ``,
    `🎁 <b>Brand:</b> ${opts.brand}`,
    `💵 <b>Value:</b> $${opts.amountUsd.toFixed(2)} USD`,
    `💰 <b>NGN Credit:</b> ₦${opts.amountNgn.toLocaleString()}`,
    ``,
    `🔐 <b>Card Code:</b> <code>${opts.cardCode}</code>${pin}`,
    ``,
    `⚡ Please redeem immediately and mark as complete on the vendor portal:`,
    `${opts.portalUrl}/vendor`,
    ``,
    `Ref: <code>${opts.assignmentId.slice(0, 8)}</code>`,
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
    portalUrl: opts.portalUrl ?? "https://7sevencards.com",
  });
  return sendTelegramMessage(opts.telegramChatId, text, "HTML");
}
