// ─────────────────────────────────────────────────────────────────────────────
// Vendor Rate-Check Engine
//
// Every 6 hours the cron endpoint triggers sendRateCheckToAllVendors().
// This initiates a two-turn Telegram conversation per vendor:
//
//   Bot  → "Has your rate changed? Reply YES or NO"
//   Vendor → "YES"
//   Bot  → "What's your new rate? Reply with ₦ per $1 (e.g. 1600)"
//   Vendor → "1620"
//   Bot  → "✅ Rate updated to ₦1,620/$1. Admin has been notified."
//   Admin ← Telegram alert + DB notification immediately
//
// State machine stored in vendors.telegram_bot_state:
//   NULL                → idle
//   rate_check_pending  → waiting for YES/NO
//   awaiting_new_rate   → waiting for numeric rate
//
// handleRateCheckReply() is called from handleTelegramReply() in vendor-broadcast.ts
// BEFORE the broadcast-claim logic, so rate-check conversations are never
// accidentally interpreted as card claims.
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from "@supabase/supabase-js";
import { getEnv } from "./worker-env";

function getAdminDb() {
  const url = getEnv("VITE_SUPABASE_URL") ?? "";
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

const RATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const MIN_RATE = 500;   // ₦/$ — sanity floor
const MAX_RATE = 30000; // ₦/$ — sanity ceiling

// ─── 1. Send rate-check ping to all eligible active vendors ──────────────────
export async function sendRateCheckToAllVendors(): Promise<{
  sent: number;
  skipped: number;
  errors: number;
}> {
  const db = getAdminDb();
  const { sendTelegramMessage, isTelegramConfigured } = await import("./telegram");

  if (!isTelegramConfigured()) {
    console.warn("[RateCheck] TELEGRAM_BOT_TOKEN not set — aborting");
    return { sent: 0, skipped: 0, errors: 0 };
  }

  // Clean up stale bot states from previous conversations first
  await db.rpc("cleanup_stale_bot_states").catch(e =>
    console.warn("[RateCheck] cleanup_stale_bot_states RPC failed:", e instanceof Error ? e.message : e)
  );

  const cutoff = new Date(Date.now() - RATE_CHECK_INTERVAL_MS).toISOString();

  // Vendors due for a check: active + has Telegram + not checked within the interval
  const { data: vendors, error } = await db
    .from("vendors")
    .select("id, contact_name, business_name, telegram_chat_id, preferred_rate_ngn_per_usd, telegram_bot_state")
    .eq("status", "active")
    .not("telegram_chat_id", "is", null)
    .or(`last_rate_check_sent_at.is.null,last_rate_check_sent_at.lt.${cutoff}`) as {
      data: Array<{
        id: string;
        contact_name: string | null;
        business_name: string;
        telegram_chat_id: number;
        preferred_rate_ngn_per_usd: number | null;
        telegram_bot_state: string | null;
      }> | null;
      error: unknown;
    };

  if (error || !vendors) {
    console.error("[RateCheck] Failed to fetch vendors:", error);
    return { sent: 0, skipped: 0, errors: 1 };
  }

  let sent = 0, skipped = 0, errors = 0;
  const now = new Date().toISOString();

  await Promise.allSettled(
    vendors.map(async (v) => {
      // Skip vendors already mid-conversation (don't interrupt)
      if (v.telegram_bot_state) {
        skipped++;
        return;
      }

      const name = v.contact_name ?? v.business_name;
      const currentRate = v.preferred_rate_ngn_per_usd
        ? `₦${Number(v.preferred_rate_ngn_per_usd).toLocaleString("en-NG")}/$1`
        : "not yet set";

      const result = await sendTelegramMessage(
        v.telegram_chat_id,
        [
          `📊 <b>Rate Check — 7SEVEN CARDS</b>`,
          ``,
          `Hi ${name},`,
          ``,
          `Your current listed rate is <b>${currentRate}</b>.`,
          ``,
          `Has your exchange rate changed?`,
          ``,
          `Reply <b>YES</b> to update it now, or <b>NO</b> to keep your current rate.`,
        ].join("\n"),
        "HTML"
      );

      if (result.ok) {
        // Set bot state to rate_check_pending
        await db
          .from("vendors")
          .update({
            telegram_bot_state:      "rate_check_pending",
            telegram_bot_state_at:   now,
            telegram_bot_state_data: { old_rate: v.preferred_rate_ngn_per_usd },
            last_rate_check_sent_at: now,
          })
          .eq("id", v.id);
        sent++;
      } else {
        console.warn(`[RateCheck] Failed to message vendor ${v.id.slice(0,8)}:`, result.error);
        errors++;
      }
    })
  );

  console.info(`[RateCheck] Done — sent: ${sent}, skipped: ${skipped}, errors: ${errors}`);
  return { sent, skipped, errors };
}

// ─── 2. Handle a vendor's reply to the rate-check conversation ───────────────
// Called from handleTelegramReply() BEFORE broadcast-claim logic.
// Returns true if the message was consumed by the rate-check FSM.
export async function handleRateCheckReply(
  chatId: number,
  text: string,
  vendor: {
    id: string;
    contact_name: string | null;
    business_name: string;
    telegram_bot_state: string | null;
    telegram_bot_state_data: Record<string, unknown> | null;
  }
): Promise<boolean> {
  const db = getAdminDb();
  const { sendTelegramMessage } = await import("./telegram");
  const name = vendor.contact_name ?? vendor.business_name;
  const clean = text.trim().toUpperCase();

  // ── State: rate_check_pending — waiting for YES or NO ──────────────────────
  if (vendor.telegram_bot_state === "rate_check_pending") {
    if (clean === "NO" || clean === "NO.") {
      // Vendor is happy with current rate — clear state, thank them
      await db.from("vendors").update({
        telegram_bot_state:      null,
        telegram_bot_state_at:   null,
        telegram_bot_state_data: null,
      }).eq("id", vendor.id);

      await sendTelegramMessage(
        chatId,
        [
          `✅ <b>Got it, ${name}!</b>`,
          ``,
          `Your rate stays unchanged. We'll check again in 6 hours.`,
          ``,
          `<i>Keep redeeming! 💪</i>`,
        ].join("\n"),
        "HTML"
      );
      return true;
    }

    if (clean === "YES" || clean === "YES!") {
      // Move to next state — ask for the new number
      await db.from("vendors").update({
        telegram_bot_state:    "awaiting_new_rate",
        telegram_bot_state_at: new Date().toISOString(),
      }).eq("id", vendor.id);

      await sendTelegramMessage(
        chatId,
        [
          `💱 <b>New Rate</b>`,
          ``,
          `What's your new rate?`,
          ``,
          `Reply with the <b>₦ amount per $1 USD</b> you'll pay.`,
          `Example: <code>1620</code> means ₦1,620 per $1.`,
          ``,
          `<i>Valid range: ₦${MIN_RATE.toLocaleString()} – ₦${MAX_RATE.toLocaleString()}</i>`,
        ].join("\n"),
        "HTML"
      );
      return true;
    }

    // Unrecognised reply — nudge them
    await sendTelegramMessage(
      chatId,
      `Please reply <b>YES</b> (rate changed) or <b>NO</b> (keep current rate).`,
      "HTML"
    );
    return true;
  }

  // ── State: awaiting_new_rate — waiting for a numeric value ─────────────────
  if (vendor.telegram_bot_state === "awaiting_new_rate") {
    // Strip non-numeric chars (₦, commas, spaces) then parse
    const numeric = parseFloat(text.replace(/[^\d.]/g, ""));

    if (isNaN(numeric) || numeric < MIN_RATE || numeric > MAX_RATE) {
      await sendTelegramMessage(
        chatId,
        [
          `❌ <b>Invalid Rate</b>`,
          ``,
          `"${text.trim()}" doesn't look right.`,
          ``,
          `Please send a number between <b>₦${MIN_RATE.toLocaleString()}</b> and <b>₦${MAX_RATE.toLocaleString()}</b>.`,
          `Example: <code>1620</code>`,
        ].join("\n"),
        "HTML"
      );
      return true;
    }

    const newRate  = Math.round(numeric * 100) / 100;
    const oldRate  = Number(vendor.telegram_bot_state_data?.old_rate ?? null) || null;

    // Save as PENDING — admin must approve before it affects live trades.
    // Write the history row first so we can link vendor → history row.
    const { data: histRow } = await db.from("vendor_rate_history").insert({
      vendor_id:   vendor.id,
      old_rate:    oldRate,
      new_rate:    newRate,
      changed_via: "telegram",
      status:      "pending",       // ← pending until admin approves
    }).select("id").single() as { data: { id: string } | null };

    // Stage the pending rate on the vendor row; clear the FSM state.
    await db.from("vendors").update({
      pending_rate_ngn_per_usd:  newRate,
      pending_rate_submitted_at: new Date().toISOString(),
      pending_rate_history_id:   histRow?.id ?? null,
      // NOTE: preferred_rate_ngn_per_usd is NOT updated here.
      // It is only updated when an admin approves via adminApproveVendorRate().
      telegram_bot_state:        null,
      telegram_bot_state_at:     null,
      telegram_bot_state_data:   null,
    }).eq("id", vendor.id);

    // Confirm to vendor — make it clear the rate is pending review
    await sendTelegramMessage(
      chatId,
      [
        `✅ <b>Rate Submitted for Review!</b>`,
        ``,
        `Your requested rate: <b>₦${newRate.toLocaleString("en-NG")}/$1</b>`,
        oldRate
          ? `Previous rate: ₦${Number(oldRate).toLocaleString("en-NG")}/$1`
          : `This is your first rate submission.`,
        ``,
        `⏳ <b>Your rate is pending admin approval.</b>`,
        `It will not affect trade assignments until approved.`,
        `You will be notified once it goes live.`,
        ``,
        `<i>Next rate check in ~6 hours.</i>`,
      ].join("\n"),
      "HTML"
    );

    // Alert admin immediately (fire-and-forget)
    notifyAdminRateChange(db, vendor.id, name, oldRate, newRate, histRow?.id ?? null).catch(e =>
      console.error("[RateCheck] Admin notification failed:", e instanceof Error ? e.message : e)
    );

    return true;
  }

  // Not in a rate-check state — let the caller handle normally
  return false;
}

// ─── 3. Alert admin immediately when a rate changes ──────────────────────────
async function notifyAdminRateChange(
  db: ReturnType<typeof getAdminDb>,
  vendorId: string,
  vendorName: string,
  oldRate: number | null,
  newRate: number,
  historyId: string | null
): Promise<void> {
  const changeStr = oldRate
    ? `₦${Number(oldRate).toLocaleString("en-NG")} → ₦${newRate.toLocaleString("en-NG")}`
    : `₦${newRate.toLocaleString("en-NG")} (first rate)`;

  const pctChange = oldRate
    ? ((newRate - oldRate) / oldRate * 100).toFixed(1)
    : null;

  const direction = pctChange ? (Number(pctChange) >= 0 ? `▲ +${pctChange}%` : `▼ ${pctChange}%`) : "";

  // DB notification for every admin
  const { data: admins } = await db
    .from("profiles")
    .select("id")
    .eq("role", "admin") as { data: Array<{ id: string }> | null };

  if (admins && admins.length > 0) {
    await db.from("notifications").insert(
      admins.map(a => ({
        user_id: a.id,
        title:   `Rate Change: ${vendorName} ${direction}`,
        message: `${vendorName} updated their rate via Telegram: ${changeStr}. Review in admin panel. Ref: ${historyId?.slice(0,8) ?? "N/A"}.`,
        type:    "info",
      }))
    );

    // Mark admin_notified_at on the history row
    if (historyId) {
      await db.from("vendor_rate_history")
        .update({ admin_notified_at: new Date().toISOString() })
        .eq("id", historyId);
    }
  }

  // Telegram alert via admin bot to ADMIN_TELEGRAM_CHAT_ID if configured
  // NOTE: must use sendAdminBotMessage (ADMIN_TELEGRAM_BOT_TOKEN), NOT
  // sendTelegramMessage (TELEGRAM_BOT_TOKEN), because ADMIN_TELEGRAM_CHAT_ID
  // is an admin-only group/channel that only the admin bot is a member of.
  const adminChatId = getEnv("ADMIN_TELEGRAM_CHAT_ID");
  if (adminChatId) {
    const { isAdminBotConfigured, sendAdminBotMessage } = await import("./telegram");
    if (isAdminBotConfigured()) {
      await sendAdminBotMessage(
        adminChatId,
        [
          `🔔 <b>Vendor Rate Change — 7SEVEN CARDS</b>`,
          ``,
          `<b>Vendor:</b> ${vendorName}`,
          `<b>Rate Change:</b> ${changeStr} ${direction}`,
          `<b>Method:</b> Telegram`,
          `<b>Ref:</b> <code>${historyId?.slice(0,8) ?? "N/A"}</code>`,
          ``,
          `<i>Review and confirm in the admin panel.</i>`,
        ].join("\n"),
        "HTML"
      );
    }
  }
}
