// ─────────────────────────────────────────────────────────────────────────────
// NFIU (Nigerian Financial Intelligence Unit) threshold monitoring.
// Nigerian fintech regulations require alerting/review when a user's rolling
// 30-day transaction volume crosses ₦5,000,000.
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from "@supabase/supabase-js";
import { NFIU_THRESHOLD_NGN, NFIU_WINDOW_DAYS } from "./constants";

/**
 * Check whether a user's rolling 30-day paid trade volume has crossed the
 * NFIU mandatory-reporting threshold. If so, write an audit log entry and
 * send an admin Telegram alert.
 *
 * This function is non-fatal — failures are swallowed so a monitoring glitch
 * never blocks a legitimate payout.
 */
export async function checkNfiuThreshold(
  db: SupabaseClient,
  userId: string,
  latestAmountNgn: number,
): Promise<void> {
  try {
    const since = new Date(
      Date.now() - NFIU_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();

    const { data } = await db
      .from("trades")
      .select("amount_ngn")
      .eq("user_id", userId)
      .eq("status", "paid")
      .gte("updated_at", since);

    const rollingTotal = (data ?? []).reduce(
      (sum, t) => sum + (Number(t.amount_ngn) ?? 0),
      latestAmountNgn,
    );

    if (rollingTotal < NFIU_THRESHOLD_NGN) return;

    // Log to console for Cloudflare Logs / Workers Analytics
    console.warn(
      `[NFIU] User ${userId} crossed ₦5M threshold. Rolling ${NFIU_WINDOW_DAYS}d total: ₦${rollingTotal.toLocaleString()}`,
    );

    // Write to audit log (non-fatal)
    await db
      .from("audit_log")
      .insert({
        event_type: "nfiu_threshold_crossed",
        user_id: userId,
        metadata: {
          rolling_total_ngn: rollingTotal,
          window_days: NFIU_WINDOW_DAYS,
          threshold_ngn: NFIU_THRESHOLD_NGN,
        },
      })
      .catch((e: unknown) => {
        console.error("[NFIU] Failed to write audit log:", e instanceof Error ? e.message : e);
      });

    // Fire admin Telegram alert (non-fatal)
    void import("./telegram")
      .then(({ sendAdminBotMessage }) => {
        const adminChatId = process.env.ADMIN_TELEGRAM_CHAT_ID ?? "";
        if (!adminChatId) return;
        return sendAdminBotMessage(
          adminChatId,
          `🚨 <b>NFIU Threshold Alert</b>\n\nUser <code>${userId}</code> has reached ₦${(rollingTotal / 1_000_000).toFixed(2)}M in ${NFIU_WINDOW_DAYS}-day trading volume.\n\n⚠️ Manual review required per NFIU regulations.`,
        );
      })
      .catch(() => {});
  } catch (e: unknown) {
    // Non-fatal: monitoring failures must not block payouts
    console.error("[NFIU] checkNfiuThreshold failed:", e instanceof Error ? e.message : e);
  }
}
