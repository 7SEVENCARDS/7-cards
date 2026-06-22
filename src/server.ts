import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";
import { initWorkerEnv, getEnv } from "./lib/worker-env";
import {
  handleSquadPayoutWebhook,
  handleSquadPaymentWebhook,
  handleTelegramWebhook,
} from "./server-functions/webhooks";
import { handleAdminTelegramWebhook } from "./server-functions/admin-telegram-webhook";
import { allow, clientIp, rlKey } from "./lib/rate-limiter";

// ─── Startup validation — runs once on first Worker invocation ───────────────
// Logs missing secrets as structured error lines so they appear in Cloudflare
// Logs & Workers Analytics without exposing the actual secret values.
const CRITICAL_SECRETS = [
  "VITE_SUPABASE_URL",
  "VITE_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SQUADCO_SECRET_KEY",
  "RELOADLY_CLIENT_ID",
  "RELOADLY_CLIENT_SECRET",
  "BUSHA_API_KEY",
  "ONESIGNAL_APP_ID",
  "ONESIGNAL_REST_API_KEY",
  "APP_SECRET",
  "CRON_SECRET",
] as const;

const OPTIONAL_SECRETS = [
  "TELEGRAM_BOT_TOKEN",
  "ADMIN_TELEGRAM_BOT_TOKEN",
  "RESEND_API_KEY",
  "DOJAH_APP_ID",
  "DOJAH_SECRET_KEY",
] as const;

let startupChecked = false;
function runStartupValidation(): void {
  if (startupChecked) return;
  startupChecked = true;
  const missing = CRITICAL_SECRETS.filter((k) => !getEnv(k));
  const missingOptional = OPTIONAL_SECRETS.filter((k) => !getEnv(k));
  if (missing.length > 0) {
    console.error(
      `[7SEVEN][STARTUP][CRITICAL] ${missing.length} required secret(s) missing — platform may not function: ${missing.join(", ")}`,
    );
  } else {
    console.info("[7SEVEN][STARTUP] All critical secrets present ✅");
  }
  if (missingOptional.length > 0) {
    console.warn(
      `[7SEVEN][STARTUP][OPTIONAL] Features degraded — missing: ${missingOptional.join(", ")}`,
    );
  }
}

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
  // HSTS: force HTTPS for 1 year, include all subdomains, enable preload list
  h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
  // Prevent information leakage via Cross-Origin APIs
  h.set("Cross-Origin-Opener-Policy", "same-origin");
  h.set("Cross-Origin-Resource-Policy", "same-origin");
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
    // Store Cloudflare Worker bindings (vars + secrets) in the module-level
    // singleton so getEnv() resolves correctly throughout this request.
    // Vite/Nitro inlines process.env.X at build time, so process.env is
    // unreliable for secrets — use getEnv() everywhere instead.
    initWorkerEnv(env);
    // Fail-fast on first request if critical secrets are absent.
    runStartupValidation();

    const url = new URL(request.url);
    const ip = clientIp(request);

    // ── Subdomain routing ────────────────────────────────────────────────────
    // www.7evencards.xyz → 301 to apex
    if (url.hostname === "www.7evencards.xyz") {
      const apex = new URL(request.url);
      apex.hostname = "7evencards.xyz";
      return Response.redirect(apex.toString(), 301);
    }

    // vendor.7evencards.xyz → rewrite pathname to /vendor/*
    if (url.hostname === "vendor.7evencards.xyz") {
      const rewritten = new URL(request.url);
      rewritten.hostname = "7evencards.xyz";
      if (!rewritten.pathname.startsWith("/vendor")) {
        rewritten.pathname =
          "/vendor" + (rewritten.pathname === "/" ? "" : rewritten.pathname);
      }
      const rewrittenReq = new Request(rewritten.toString(), {
        method: request.method,
        headers: request.headers,
        body: request.body ?? undefined,
        redirect: "manual",
      });
      if (!allow(rlKey("global", ip), 300, 60_000)) {
        return addSecurityHeaders(tooManyRequests(60));
      }
      try {
        const handler = await getServerEntry();
        const response = await handler.fetch(rewrittenReq, env, ctx);
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
    }

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

      // ── Cron: vendor rate-check (every 6 hours via external scheduler) ──────
      // Trigger: curl -X POST https://7evencards.xyz/api/cron/rate-check \
      //            -H "x-cron-secret: $CRON_SECRET"
      // Cloudflare Workers scheduled handler can hit this instead of its own
      // scheduled() export so the logic stays in one place.
      if (url.pathname === "/api/cron/rate-check") {
        const secret = request.headers.get("x-cron-secret");
        const expected = getEnv("CRON_SECRET");
        if (!expected || secret !== expected) {
          return addSecurityHeaders(
            new Response(JSON.stringify({ error: "Unauthorized" }), {
              status: 401,
              headers: { "Content-Type": "application/json" },
            })
          );
        }
        // waitUntil keeps the Worker alive until cronWork settles even after we respond.
        // Without it, Cloudflare may terminate the isolate as soon as the Response is
        // returned, cutting off the async Telegram sends mid-flight.
        const { sendRateCheckToAllVendors } = await import("./lib/rate-check");
        const cronWork = sendRateCheckToAllVendors()
          .then(r => console.info("[Cron] Rate-check complete:", r))
          .catch(e => console.error("[Cron] Rate-check failed:", e instanceof Error ? e.message : e));
        (ctx as { waitUntil?: (p: Promise<unknown>) => void }).waitUntil?.(cronWork);
        return addSecurityHeaders(
          new Response(JSON.stringify({ ok: true, started: true }), {
            headers: { "Content-Type": "application/json" },
          })
        );
      }
    }

    // ── Health check — shows config status without exposing secret values ──
    if (url.pathname === "/api/health") {
      // Critical: all must be present for 200. Optional: logged but won't cause 503.
      const critical = {
        supabase:        !!(getEnv("VITE_SUPABASE_URL") && getEnv("VITE_SUPABASE_ANON_KEY") && getEnv("SUPABASE_SERVICE_ROLE_KEY")),
        squadco:         !!getEnv("SQUADCO_SECRET_KEY"),
        reloadly:        !!(getEnv("RELOADLY_CLIENT_ID") && getEnv("RELOADLY_CLIENT_SECRET")),
        busha:           !!getEnv("BUSHA_API_KEY"),
        onesignal:       !!(getEnv("ONESIGNAL_APP_ID") && getEnv("ONESIGNAL_REST_API_KEY")),
        app_secret:      !!getEnv("APP_SECRET"),
        cron:            !!getEnv("CRON_SECRET"),
      };
      // Optional: present in most envs, degrade gracefully when missing.
      const optional = {
        telegram:        !!getEnv("TELEGRAM_BOT_TOKEN"),
        admin_telegram:  !!getEnv("ADMIN_TELEGRAM_BOT_TOKEN"),
        resend:          !!getEnv("RESEND_API_KEY"),
        dojah:           !!(getEnv("DOJAH_APP_ID") && getEnv("DOJAH_SECRET_KEY")),
      };
      const allOk = Object.values(critical).every(Boolean);
      if (!allOk) {
        const missing = Object.entries(critical).filter(([, v]) => !v).map(([k]) => k);
        console.warn("[Health] Missing critical secrets:", missing.join(", "));
      }
      return addSecurityHeaders(
        new Response(JSON.stringify({ ok: allOk, ts: Date.now(), critical, optional }), {
          status: allOk ? 200 : 503,
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
