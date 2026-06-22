// ─────────────────────────────────────────────────────────────────────────────
// Admin email notifications via Resend API
// Env vars: RESEND_API_KEY, ADMIN_EMAIL (falls back to admin@7evencards.xyz)
// Degrades gracefully — logs a warning and returns when API key is missing.
// ─────────────────────────────────────────────────────────────────────────────

import { getEnv } from "./worker-env";
import { fetchWithTimeout } from "./fetch-with-timeout";

export async function sendAdminEmail(opts: {
  subject: string;
  html: string;
  to?: string;
}): Promise<void> {
  const apiKey     = getEnv("RESEND_API_KEY");
  const adminEmail = getEnv("ADMIN_EMAIL") ?? "admin@7evencards.xyz";
  if (!apiKey) {
    console.warn("[Email] RESEND_API_KEY not set — skipping admin email notification");
    return;
  }
  try {
    const res = await fetchWithTimeout(
      "https://api.resend.com/emails",
      {
        method: "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          from: "7SEVEN CARDS <noreply@7evencards.xyz>",
          to:   [opts.to ?? adminEmail],
          subject: opts.subject,
          html:    opts.html,
        }),
      },
      8_000,
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn("[Email] Resend API error:", res.status, body.slice(0, 200));
    }
  } catch (e) {
    console.warn("[Email] Failed to send:", e instanceof Error ? e.message : e);
  }
}

export function buildNewTradeEmailHtml(opts: {
  tradeId:   string;
  userId:    string;
  brand:     string;
  amountUsd: number;
  amountNgn: number;
  status:    string;
}): string {
  const now          = new Date().toUTCString();
  const amountNgnFmt = Math.round(opts.amountNgn).toLocaleString("en-NG");
  const amountUsdFmt = Number(opts.amountUsd).toFixed(2);
  const statusColor  = opts.status === "verified" ? "#10b981"
                     : opts.status === "pending_review" ? "#f59e0b"
                     : "#ef4444";

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>New Trade — 7SEVEN CARDS</title></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:Arial,sans-serif;">
  <div style="max-width:520px;margin:32px auto;background:#111;border-radius:12px;padding:32px;border:1px solid #1f1f1f;">
    <h1 style="color:#f59e0b;margin:0 0 6px;font-size:22px;">&#x1F0CF; New Trade Submitted</h1>
    <p style="color:#888;margin:0 0 28px;font-size:14px;">A new gift card trade just came in on 7SEVEN CARDS.</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">
      <tr>
        <td style="color:#888;padding:10px 0;border-bottom:1px solid #1f1f1f;width:38%;">Trade ID</td>
        <td style="color:#fff;padding:10px 0;border-bottom:1px solid #1f1f1f;font-family:monospace;font-size:11px;">${opts.tradeId}</td>
      </tr>
      <tr>
        <td style="color:#888;padding:10px 0;border-bottom:1px solid #1f1f1f;">Brand</td>
        <td style="color:#fff;padding:10px 0;border-bottom:1px solid #1f1f1f;font-weight:bold;">${opts.brand}</td>
      </tr>
      <tr>
        <td style="color:#888;padding:10px 0;border-bottom:1px solid #1f1f1f;">Amount (USD)</td>
        <td style="color:#f59e0b;padding:10px 0;border-bottom:1px solid #1f1f1f;font-weight:bold;">$${amountUsdFmt}</td>
      </tr>
      <tr>
        <td style="color:#888;padding:10px 0;border-bottom:1px solid #1f1f1f;">Amount (NGN)</td>
        <td style="color:#f59e0b;padding:10px 0;border-bottom:1px solid #1f1f1f;font-weight:bold;">&#8358;${amountNgnFmt}</td>
      </tr>
      <tr>
        <td style="color:#888;padding:10px 0;border-bottom:1px solid #1f1f1f;">Status</td>
        <td style="color:${statusColor};padding:10px 0;border-bottom:1px solid #1f1f1f;font-weight:bold;">${opts.status}</td>
      </tr>
      <tr>
        <td style="color:#888;padding:10px 0;">User ID</td>
        <td style="color:#aaa;padding:10px 0;font-family:monospace;font-size:11px;">${opts.userId}</td>
      </tr>
    </table>
    <div style="margin-top:28px;">
      <a href="https://7evencards.xyz/admin"
         style="display:inline-block;background:#f59e0b;color:#000;padding:12px 24px;text-decoration:none;border-radius:8px;font-weight:bold;font-size:14px;">
        View in Admin Panel &#8594;
      </a>
    </div>
    <p style="color:#444;margin-top:28px;font-size:12px;border-top:1px solid #1f1f1f;padding-top:16px;">
      7SEVEN CARDS &middot; ${now}
    </p>
  </div>
</body>
</html>`;
}
