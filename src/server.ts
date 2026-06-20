import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";
import {
  handleSquadPayoutWebhook,
  handleSquadPaymentWebhook,
} from "./server-functions/webhooks";
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

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
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

// ─── Security headers ─────────────────────────────────────────────────────────
// Applied to every response that leaves this Worker.
// CSP is intentionally permissive on script/style (React app needs it) but
// blocks frame embedding, MIME-sniff, and removes referrer data on cross-origin.
function addSecurityHeaders(res: Response): Response {
  const h = new Headers(res.headers);

  // Prevent MIME-type sniffing — e.g. serving a JS file as text/html
  h.set("X-Content-Type-Options", "nosniff");

  // Disallow this app from being embedded in an iframe anywhere
  h.set("X-Frame-Options", "DENY");

  // Don't send full URL as referrer to cross-origin destinations
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");

  // Disable access to camera/mic/geo — fintech app doesn't need them
  h.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");

  // Belt-and-suspenders XSS filter for older browsers
  h.set("X-XSS-Protection", "1; mode=block");

  // Content-Security-Policy:
  //   - Blocks all framing (frame-ancestors 'none')
  //   - Allows Supabase realtime WS, OneSignal push CDN, Google Fonts
  //   - Allows 'unsafe-inline' / 'unsafe-eval' because React production
  //     bundles use them; remove if you switch to a nonce-based CSP later
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

// ─── Body size guard ──────────────────────────────────────────────────────────
// Reject requests whose Content-Length header exceeds 512 KB before we even
// attempt to read the body. Prevents memory-exhaustion attacks on the Worker.
const MAX_BODY_BYTES = 512 * 1024; // 512 KB

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

    // ── Global IP flood guard: 300 req/min per IP ───────────────────────────
    // Stops single-source DoS before any business logic runs.
    if (!allow(rlKey("global", ip), 300, 60_000)) {
      return addSecurityHeaders(tooManyRequests(60));
    }

    // ── Body size limit for mutating requests ────────────────────────────────
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
    // Configure these URLs in Squad dashboard:
    //   Payout (transfer) webhook: POST /api/webhooks/squadco/payout
    //   Payment (charge) webhook:  POST /api/webhooks/squadco/payment
    if (request.method === "POST") {
      if (
        url.pathname === "/api/webhooks/squadco/payout" ||
        url.pathname === "/api/webhooks/squadco/payment"
      ) {
        // Tighter limit for webhook endpoints: 120 req/min per IP.
        // Squad's retry policy tops out well below this; anything higher
        // is either a misconfigured client or an intentional flood.
        if (!allow(rlKey("webhook", ip), 120, 60_000)) {
          return addSecurityHeaders(tooManyRequests(60));
        }

        const handler =
          url.pathname === "/api/webhooks/squadco/payout"
            ? handleSquadPayoutWebhook
            : handleSquadPaymentWebhook;

        return addSecurityHeaders(await handler(request));
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
