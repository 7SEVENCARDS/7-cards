import { getDb } from "./db.js";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const TG_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

async function sendTelegramMessage(
  chatId: string,
  text: string,
  opts: Record<string, unknown> = {},
): Promise<boolean> {
  if (!TELEGRAM_BOT_TOKEN) return false;
  try {
    const res = await fetch(`${TG_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", ...opts }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface DispatchResult {
  ok: boolean;
  vendorId?: string;
  vendorName?: string;
  error?: string;
}

export async function dispatchTradeToVendors(opts: {
  tradeId: string;
  brand: string;
  amountUsd: number;
  amountNgn: number;
  cardCode: string;
  cardPin?: string;
  batchPosition?: number;
  batchTotal?: number;
}): Promise<DispatchResult> {
  const db = getDb();

  const { data: vendors } = await db
    .from("vendor_profiles")
    .select("id, business_name, telegram_chat_id, round_robin_position")
    .eq("is_active", true)
    .eq("kyc_status", "verified")
    .not("telegram_chat_id", "is", null)
    .order("round_robin_position", { ascending: true })
    .limit(1);

  if (!vendors?.length) {
    return { ok: false, error: "No active vendors available" };
  }

  const vendor = vendors[0];

  const posStr =
    opts.batchPosition && opts.batchTotal && opts.batchTotal > 1
      ? `\n📦 Card ${opts.batchPosition} of ${opts.batchTotal}`
      : "";

  const msg =
    `🎁 <b>New Card Available</b>${posStr}\n` +
    `Brand: <b>${opts.brand}</b>\n` +
    `Value: <b>$${opts.amountUsd} → ₦${opts.amountNgn.toLocaleString()}</b>\n\n` +
    `Card: <code>${opts.cardCode}</code>\n` +
    (opts.cardPin ? `PIN: <code>${opts.cardPin}</code>\n` : "") +
    `\nReply <b>YES</b> to accept or <b>NO</b> to pass.`;

  await db
    .from("trades")
    .update({ status: "dispatched", direct_vendor_id: vendor.id })
    .eq("id", opts.tradeId);

  await db
    .from("vendor_trade_broadcasts")
    .insert({
      trade_id: opts.tradeId,
      brand: opts.brand,
      amount_usd: opts.amountUsd,
      amount_ngn: opts.amountNgn,
      status: "pending",
    })
    .select("id")
    .single()
    .catch(() => {});

  const sent = await sendTelegramMessage(
    vendor.telegram_chat_id as string,
    msg,
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Accept", callback_data: `accept_${opts.tradeId}` },
            { text: "❌ Pass", callback_data: `pass_${opts.tradeId}` },
          ],
        ],
      },
    },
  );

  if (!sent) {
    return { ok: false, error: "Failed to send Telegram message to vendor" };
  }

  return {
    ok: true,
    vendorId: vendor.id as string,
    vendorName: vendor.business_name as string,
  };
}
