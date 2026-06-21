import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";
import {
  handleSquadPayoutWebhook,
  handleSquadPaymentWebhook,
  handleTelegramWebhook,
} from "./server-functions/webhooks";
import { handleAdminTelegramWebhook } from "./server-functions/admin-telegram-webhook";
import { registerAdminTelegramWebhook } from "./server-functions/admin-telegram";
import { allow, clientIp, rlKey } from "./lib/rate-limiter";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m.default ?? m) as ServerEntry,
    );
  }
  return serverEntryPromise;
}

async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!body.includes('"unhandled":true') || !body.includes('"message":"HTTPError"')) {
    return response;
  }

  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function tooManyRequests(retryAfterSecs = 60): Response {
  return new Response(
    JSON.stringify({ error: "Too many requests. Please try again later." }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(retryAfterSecs),
      },
    },
  );
}

function addSecurityHeaders(res: Response): Response {
  const h = new Headers(res.headers);
  h.set("X-Content-Type-Options", "nosniff");
  h.set("X-Frame-Options", "DENY");
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  h.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  h.set("X-XSS-Protection", "1; mode=block");
  h.set(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.onesignal.com https://onesignal.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      "img-src 'self' data: blob: https:",
      "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://api.onesignal.com https://onesignal.com https://api.dojah.io https://giftcards.reloadly.com https://giftcards-sandbox.reloadly.com https://auth.reloadly.com https://api-d.squadco.com https://sandbox-api-d.squadco.com https://api.busha.co",
      "worker-src blob:",
      "frame-src 'none'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  );

  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: h,
  });
}

const MAX_BODY_BYTES = 512 * 1024;

function bodyTooLarge(): Response {
  return new Response(JSON.stringify({ error: "Request body too large" }), {
    status: 413,
    headers: { "Content-Type": "application/json" },
  });
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    const url = new URL(request.url);
    const ip = clientIp(request);

    if (!allow(rlKey("global", ip), 300, 60_000)) {
      return addSecurityHeaders(tooManyRequests(60));
    }

    if (
      request.method === "POST" ||
      request.method === "PUT" ||
      request.method === "PATCH"
    ) {
      const contentLength = request.headers.get("content-length");
      if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
        return addSecurityHeaders(bodyTooLarge());
      }
    }

    // ── Webhook routes — handled before TanStack Start ──────────────────────
    if (request.method === "POST") {
      // Squad webhooks
      if (
        url.pathname === "/api/webhooks/squadco/payout" ||
        url.pathname === "/api/webhooks/squadco/payment"
      ) {
        if (!allow(rlKey("webhook", ip), 120, 60_000)) {
          return addSecurityHeaders(tooManyRequests(60));
        }
        const handler =
          url.pathname === "/api/webhooks/squadco/payout"
            ? handleSquadPayoutWebhook
            : handleSquadPaymentWebhook;
        return addSecurityHeaders(await handler(request));
      }

      // Vendor Telegram webhook — must return 200 fast; processing is async inside handler
      if (url.pathname === "/api/webhooks/telegram") {
        if (!allow(rlKey("telegram_webhook", ip), 200, 60_000)) {
          return addSecurityHeaders(tooManyRequests(30));
        }
        return addSecurityHeaders(await handleTelegramWebhook(request));
      }

      // Admin Telegram bot webhook — inline buttons, link codes, support replies
      if (url.pathname === "/api/webhooks/telegram-admin") {
        if (!allow(rlKey("telegram_admin_webhook", ip), 200, 60_000)) {
          return addSecurityHeaders(tooManyRequests(30));
        }
        return addSecurityHeaders(await handleAdminTelegramWebhook(request));
      }

      // Admin: one-click register admin bot webhook with Telegram
      // Called from AdminScreen — requires admin auth (checked inside server fn)
      if (url.pathname === "/api/admin/register-telegram-webhook" && request.method === "POST") {
        if (!allow(rlKey("admin_register_webhook", ip), 5, 60_000)) {
          return addSecurityHeaders(tooManyRequests(60));
        }
        try {
          const result = await registerAdminTelegramWebhook({ data: {} });
          return addSecurityHeaders(
            new Response(JSON.stringify(result), {
              status: result.success ? 200 : 400,
              headers: { "Content-Type": "application/json" },
            })
          );
        } catch (e) {
          return addSecurityHeaders(
            new Response(JSON.stringify({ success: false, error: String(e) }), {
              status: 500,
              headers: { "Content-Type": "application/json" },
            })
          );
        }
      }

      // ── Cron: vendor rate-check (every 6 hours via external scheduler) ──────
      // Trigger: curl -X POST https://7sevencards.com/api/cron/rate-check \
      //            -H "x-cron-secret: $CRON_SECRET"
      // Cloudflare Workers scheduled handler can hit this instead of its own
      // scheduled() export so the logic stays in one place.
      if (url.pathname === "/api/cron/rate-check") {
        const secret = request.headers.get("x-cron-secret");
        const expected = process.env.CRON_SECRET;
        if (!expected || secret !== expected) {
          return addSecurityHeaders(
            new Response(JSON.stringify({ error: "Unauthorized" }), {
              status: 401,
              headers: { "Content-Type": "application/json" },
            })
          );
        }
        // Fire-and-forget — respond immediately so the scheduler doesn't time out
        const { sendRateCheckToAllVendors } = await import("./lib/rate-check");
        sendRateCheckToAllVendors()
          .then(r => console.info("[Cron] Rate-check complete:", r))
          .catch(e => console.error("[Cron] Rate-check failed:", e instanceof Error ? e.message : e));
        return addSecurityHeaders(
          new Response(JSON.stringify({ ok: true, started: true }), {
            headers: { "Content-Type": "application/json" },
          })
        );
      }
    }

    // ── Health check ────────────────────────────────────────────────────────
    if (url.pathname === "/api/health") {
      return addSecurityHeaders(
        new Response(JSON.stringify({ ok: true, ts: Date.now() }), {
          headers: { "Content-Type": "application/json" },
        }),
      );
    }

    // ── All other routes → TanStack React Start ─────────────────────────────
    try {
      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      const normalized = await normalizeCatastrophicSsrResponse(response);
      return addSecurityHeaders(normalized);
    } catch (error) {
      console.error(error);
      return addSecurityHeaders(
        new Response(renderErrorPage(), {
          status: 500,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      );
    }
  },
};
