// ─────────────────────────────────────────────────────────────────────────────
// Email notifications via Resend API — admin + user-facing
// Env vars: RESEND_API_KEY, ADMIN_EMAIL (falls back to admin@7evencards.xyz)
// FROM address: noreply@7evencards.xyz (domain must be verified in Resend)
// Degrades gracefully — logs a warning and returns when API key is missing.
// ─────────────────────────────────────────────────────────────────────────────

import { getEnv } from "./worker-env";
import { fetchWithTimeout } from "./fetch-with-timeout";

const FROM_NAME    = "7SEVEN CARDS";
const FROM_ADDRESS = "noreply@7evencards.xyz";
const BRAND_GOLD   = "#f59e0b";
const BRAND_BG     = "#0a0a0a";
const CARD_BG      = "#111111";
const BORDER       = "#1f1f1f";

// ─── Core send helper ─────────────────────────────────────────────────────────
async function sendEmail(opts: {
  to: string;
  subject: string;
  html: string;
}): Promise<void> {
  const apiKey = getEnv("RESEND_API_KEY");
  if (!apiKey) {
    console.warn("[Email] RESEND_API_KEY not set — skipping email to:", opts.to.slice(0, 10) + "...");
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
          from:    `${FROM_NAME} <${FROM_ADDRESS}>`,
          to:      [opts.to],
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

// ─── Admin email ──────────────────────────────────────────────────────────────
export async function sendAdminEmail(opts: {
  subject: string;
  html: string;
  to?: string;
}): Promise<void> {
  const adminEmail = getEnv("ADMIN_EMAIL") ?? "admin@7evencards.xyz";
  return sendEmail({ to: opts.to ?? adminEmail, subject: opts.subject, html: opts.html });
}

// ─── User email ───────────────────────────────────────────────────────────────
export async function sendUserEmail(opts: {
  to: string;
  subject: string;
  html: string;
}): Promise<void> {
  return sendEmail(opts);
}

// ─── Shared email chrome ──────────────────────────────────────────────────────
function emailChrome(title: string, body: string): string {
  const now = new Date().toUTCString();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background:${BRAND_BG};font-family:Arial,sans-serif;">
  <div style="max-width:520px;margin:32px auto;background:${CARD_BG};border-radius:12px;padding:32px;border:1px solid ${BORDER};">
    <div style="margin-bottom:24px;">
      <span style="color:${BRAND_GOLD};font-size:20px;font-weight:bold;letter-spacing:-0.5px;">7SEVEN CARDS</span>
    </div>
    ${body}
    <p style="color:#444;margin-top:28px;font-size:11px;border-top:1px solid ${BORDER};padding-top:16px;">
      This is an automated message from 7SEVEN CARDS &middot; ${now}<br>
      <a href="https://7evencards.xyz" style="color:#666;text-decoration:none;">7evencards.xyz</a>
    </p>
  </div>
</body>
</html>`;
}

function tableRow(label: string, value: string, valueColor = "#ffffff"): string {
  return `<tr>
    <td style="color:#888;padding:10px 0;border-bottom:1px solid ${BORDER};width:38%;font-size:14px;">${label}</td>
    <td style="color:${valueColor};padding:10px 0;border-bottom:1px solid ${BORDER};font-size:14px;">${value}</td>
  </tr>`;
}

function ctaButton(text: string, href: string): string {
  return `<div style="margin-top:28px;">
    <a href="${href}" style="display:inline-block;background:${BRAND_GOLD};color:#000;padding:12px 24px;text-decoration:none;border-radius:8px;font-weight:bold;font-size:14px;">
      ${text} &#8594;
    </a>
  </div>`;
}

// ─── New trade notification (admin) ───────────────────────────────────────────
export function buildNewTradeEmailHtml(opts: {
  tradeId:   string;
  userId:    string;
  brand:     string;
  amountUsd: number;
  amountNgn: number;
  status:    string;
}): string {
  const amountNgnFmt = Math.round(opts.amountNgn).toLocaleString("en-NG");
  const amountUsdFmt = Number(opts.amountUsd).toFixed(2);
  const statusColor  = opts.status === "verified" ? "#10b981"
                     : opts.status === "pending_review" ? "#f59e0b"
                     : "#ef4444";
  return emailChrome("New Trade — 7SEVEN CARDS", `
    <h1 style="color:${BRAND_GOLD};margin:0 0 6px;font-size:22px;">&#x1F0CF; New Trade Submitted</h1>
    <p style="color:#888;margin:0 0 24px;font-size:14px;">A new gift card trade just came in.</p>
    <table style="width:100%;border-collapse:collapse;">
      ${tableRow("Trade ID", `<span style="font-family:monospace;font-size:11px;">${opts.tradeId}</span>`)}
      ${tableRow("Brand", `<strong>${opts.brand}</strong>`)}
      ${tableRow("Amount (USD)", `<strong>$${amountUsdFmt}</strong>`, BRAND_GOLD)}
      ${tableRow("Amount (NGN)", `<strong>&#8358;${amountNgnFmt}</strong>`, BRAND_GOLD)}
      ${tableRow("Status", `<strong>${opts.status}</strong>`, statusColor)}
      ${tableRow("User ID", `<span style="font-family:monospace;font-size:11px;">${opts.userId}</span>`, "#aaa")}
    </table>
    ${ctaButton("View in Admin Panel", "https://7evencards.xyz/admin")}
  `);
}

// ─── KYC submission notification (admin) ──────────────────────────────────────
export function buildKYCSubmissionEmailHtml(opts: {
  userId:   string;
  fullName: string;
  kycType:  "bvn" | "nin" | "both" | "submitted";
  autoApproved?: boolean;
}): string {
  const statusText  = opts.autoApproved ? "Auto-approved ✅" : "Pending Review ⏳";
  const statusColor = opts.autoApproved ? "#10b981" : BRAND_GOLD;
  const typeLabel   = opts.kycType === "both" ? "BVN + NIN" : opts.kycType.toUpperCase();
  return emailChrome("KYC Submission — 7SEVEN CARDS", `
    <h1 style="color:${BRAND_GOLD};margin:0 0 6px;font-size:22px;">&#x1F4CB; KYC ${opts.autoApproved ? "Verified" : "Submitted"}</h1>
    <p style="color:#888;margin:0 0 24px;font-size:14px;">
      A user has ${opts.autoApproved ? "completed KYC verification" : "submitted identity documents for review"}.
    </p>
    <table style="width:100%;border-collapse:collapse;">
      ${tableRow("User ID", `<span style="font-family:monospace;font-size:11px;">${opts.userId}</span>`, "#aaa")}
      ${tableRow("Full Name", `<strong>${opts.fullName}</strong>`)}
      ${tableRow("Document Type", typeLabel)}
      ${tableRow("Status", `<strong>${statusText}</strong>`, statusColor)}
    </table>
    ${ctaButton("Review KYC Queue", "https://7evencards.xyz/admin")}
  `);
}

// ─── Support ticket notification (admin) ──────────────────────────────────────
export function buildSupportTicketEmailHtml(opts: {
  ticketId:   string;
  userId:     string;
  userName:   string;
  category:   string | null;
  body:       string;
  isPremium:  boolean;
}): string {
  const priorityBadge = opts.isPremium
    ? `<span style="background:#f59e0b;color:#000;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:bold;">⭐ PRO PRIORITY</span>`
    : `<span style="background:#374151;color:#9ca3af;padding:2px 8px;border-radius:4px;font-size:12px;">Standard</span>`;
  const categoryLabel = opts.category ? ` · ${opts.category.toUpperCase()}` : "";
  return emailChrome("New Support Ticket — 7SEVEN CARDS", `
    <h1 style="color:${BRAND_GOLD};margin:0 0 8px;font-size:22px;">&#x1F3AB; New Support Ticket</h1>
    <p style="color:#888;margin:0 0 16px;font-size:14px;">Priority: ${priorityBadge}${categoryLabel}</p>
    <table style="width:100%;border-collapse:collapse;">
      ${tableRow("Ticket ID", `<span style="font-family:monospace;font-size:11px;">${opts.ticketId}</span>`, "#aaa")}
      ${tableRow("User", `<strong>${opts.userName}</strong> [${opts.userId.slice(0, 8)}]`)}
    </table>
    <div style="margin:20px 0;background:#0d0d0d;border-radius:8px;padding:16px;border-left:3px solid ${BRAND_GOLD};">
      <p style="color:#ccc;margin:0;font-size:14px;line-height:1.6;">${opts.body.replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>")}</p>
    </div>
    <p style="color:#666;font-size:12px;">Reply via admin bot: <code style="background:#0d0d0d;padding:2px 6px;border-radius:4px;">/reply ${opts.ticketId} your message here</code></p>
    ${ctaButton("View in Admin Panel", "https://7evencards.xyz/admin")}
  `);
}

// ─── Trade completed / paid notification (user-facing) ────────────────────────
export function buildTradeCompletedEmailHtml(opts: {
  tradeId:   string;
  brand:     string;
  amountNgn: number;
  userName:  string;
}): string {
  const amountNgnFmt = Math.round(opts.amountNgn).toLocaleString("en-NG");
  return emailChrome("Your Trade is Paid! — 7SEVEN CARDS", `
    <h1 style="color:#10b981;margin:0 0 6px;font-size:22px;">&#x2705; Payment Sent!</h1>
    <p style="color:#888;margin:0 0 24px;font-size:14px;">
      Hi ${opts.userName}, your gift card trade has been verified and payment has been sent to your account.
    </p>
    <table style="width:100%;border-collapse:collapse;">
      ${tableRow("Trade ID", `<span style="font-family:monospace;font-size:11px;">${opts.tradeId}</span>`, "#aaa")}
      ${tableRow("Card Brand", `<strong>${opts.brand}</strong>`)}
      ${tableRow("Amount Paid", `<strong>&#8358;${amountNgnFmt}</strong>`, "#10b981")}
      ${tableRow("Status", "<strong>Paid ✅</strong>", "#10b981")}
    </table>
    <p style="color:#888;font-size:14px;margin-top:20px;">
      The funds have been transferred to your registered bank account. 
      Please allow up to 10 minutes for your bank to reflect the credit.
    </p>
    ${ctaButton("View Trade History", "https://7evencards.xyz/trades")}
  `);
}

// ─── KYC approved/rejected notification (user-facing) ─────────────────────────
export function buildKYCResultEmailHtml(opts: {
  userName:  string;
  approved:  boolean;
  reason?:   string;
}): string {
  const title  = opts.approved ? "KYC Verified!" : "KYC Update";
  const icon   = opts.approved ? "&#x2705;" : "&#x26A0;&#xFE0F;";
  const color  = opts.approved ? "#10b981" : "#ef4444";
  const body   = opts.approved
    ? "Your identity has been successfully verified. You can now trade without limits on 7SEVEN CARDS."
    : `Your KYC submission needs attention.${opts.reason ? ` Reason: <em>${opts.reason}</em>` : ""} Please resubmit your documents or contact support.`;
  return emailChrome(`${title} — 7SEVEN CARDS`, `
    <h1 style="color:${color};margin:0 0 6px;font-size:22px;">${icon} ${title}</h1>
    <p style="color:#888;margin:0 0 24px;font-size:14px;">Hi ${opts.userName},</p>
    <p style="color:#ccc;font-size:15px;line-height:1.6;">${body}</p>
    ${ctaButton(opts.approved ? "Start Trading" : "Visit Support", opts.approved ? "https://7evencards.xyz/dashboard" : "https://7evencards.xyz/support")}
  `);
}
