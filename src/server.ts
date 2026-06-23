import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";
import { initWorkerEnv, getEnv } from "./lib/worker-env";
import { initSentryServer, captureServerException, startServerSpan } from "./lib/sentry.server";
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

  const ssrErr = consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`);
  captureServerException(ssrErr, { type: "ssr_catastrophic" });
  console.error(ssrErr);
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

function addSecurityHeaders(res: Response, reqId?: string): Response {
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
      "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://api.onesignal.com https://onesignal.com https://api.dojah.io https://giftcards.reloadly.com https://giftcards-sandbox.reloadly.com https://auth.reloadly.com https://api-d.squadco.com https://sandbox-api-d.squadco.com https://api.busha.co https://*.sentry.io https://*.ingest.sentry.io https://*.ingest.us.sentry.io",
      "worker-src blob:",
      "frame-src 'none'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  );

  // Prevent browsers / CDN edges from caching API JSON responses.
  // Static assets served by Cloudflare Assets binding bypass this function,
  // so setting no-store here only affects our server-rendered and API responses.
  if (h.get("Content-Type")?.includes("application/json")) {
    h.set("Cache-Control", "no-store, no-cache, must-revalidate");
    h.set("Pragma", "no-cache");
  }

  if (reqId) h.set('X-Request-ID', reqId);
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
    // Sentry: initialise once per isolate — no-op if SENTRY_DSN not set.
    initSentryServer();

    // ── Request trace ID — attach to every log line for correlation ──────────
    // X-Request-ID echoed from client if provided; generated server-side if not.
    // Enables log correlation across Cloudflare Logs, Supabase, and Squad.
    const requestId = (request.headers.get('x-request-id') || crypto.randomUUID()).slice(0, 36);

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
      if (!allow(rlKey("global", ip), 300, 60_000)) {
        return addSecurityHeaders(tooManyRequests(60), requestId);
      }
      if (
        request.method === "POST" ||
        request.method === "PUT" ||
        request.method === "PATCH"
      ) {
        const contentLength = request.headers.get("content-length");
        if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
          return addSecurityHeaders(bodyTooLarge(), requestId);
        }
      }
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
      try {
        const handler = await getServerEntry();
        const response = await startServerSpan(
          { name: `SSR ${request.method} vendor`, op: "http.server" },
          () => handler.fetch(rewrittenReq, env, ctx),
        );
        const normalized = await normalizeCatastrophicSsrResponse(response);
        return addSecurityHeaders(normalized, requestId);
      } catch (error) {
        captureServerException(error, { route: "vendor_subdomain" });
        console.error(error);
        return addSecurityHeaders(
          new Response(renderErrorPage(), {
            status: 500,
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
          requestId,
        );
      }
    }

    // admin.7evencards.xyz → admin portal (dedicated admin experience)
    if (url.hostname === "admin.7evencards.xyz") {
      if (!allow(rlKey("global", ip), 200, 60_000)) {
        return addSecurityHeaders(tooManyRequests(60), requestId);
      }
      if (
        request.method === "POST" ||
        request.method === "PUT" ||
        request.method === "PATCH"
      ) {
        const contentLength = request.headers.get("content-length");
        if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
          return addSecurityHeaders(bodyTooLarge(), requestId);
        }
      }
      const rewritten = new URL(request.url);
      rewritten.hostname = "7evencards.xyz";
      if (!rewritten.pathname.startsWith("/admin")) {
        rewritten.pathname =
          "/admin" + (rewritten.pathname === "/" ? "" : rewritten.pathname);
      }
      const rewrittenReq = new Request(rewritten.toString(), {
        method: request.method,
        headers: request.headers,
        body: request.body ?? undefined,
        redirect: "manual",
      });
      try {
        const handler = await getServerEntry();
        const response = await startServerSpan(
          { name: `SSR ${request.method} admin`, op: "http.server" },
          () => handler.fetch(rewrittenReq, env, ctx),
        );
        const normalized = await normalizeCatastrophicSsrResponse(response);
        return addSecurityHeaders(normalized, requestId);
      } catch (error) {
        captureServerException(error, { route: "admin_subdomain" });
        console.error(error);
        return addSecurityHeaders(
          new Response(renderErrorPage(), {
            status: 500,
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
          requestId,
        );
      }
    }

    if (!allow(rlKey("global", ip), 300, 60_000)) {
      return addSecurityHeaders(tooManyRequests(60), requestId);
    }

    if (
      request.method === "POST" ||
      request.method === "PUT" ||
      request.method === "PATCH"
    ) {
      const contentLength = request.headers.get("content-length");
      if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
        return addSecurityHeaders(bodyTooLarge(), requestId);
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
          return addSecurityHeaders(tooManyRequests(60), requestId);
        }
        const handler =
          url.pathname === "/api/webhooks/squadco/payout"
            ? handleSquadPayoutWebhook
            : handleSquadPaymentWebhook;
        return addSecurityHeaders(await handler(request), requestId);
      }

      // Vendor Telegram webhook — must return 200 fast; processing is async inside handler
      if (url.pathname === "/api/webhooks/telegram") {
        if (!allow(rlKey("telegram_webhook", ip), 200, 60_000)) {
          return addSecurityHeaders(tooManyRequests(30), requestId);
        }
        return addSecurityHeaders(await handleTelegramWebhook(request), requestId);
      }

      // Admin Telegram bot webhook — inline buttons, link codes, support replies
      if (url.pathname === "/api/webhooks/telegram-admin") {
        if (!allow(rlKey("telegram_admin_webhook", ip), 200, 60_000)) {
          return addSecurityHeaders(tooManyRequests(30), requestId);
        }
        return addSecurityHeaders(await handleAdminTelegramWebhook(request), requestId);
      }

      // ── Cron: vendor rate-check (every 6 hours via CF Cron Trigger) ─────────
      // Trigger: curl -X POST https://7evencards.xyz/api/cron/rate-check \
      //            -H "x-cron-secret: $CRON_SECRET"
      if (url.pathname === "/api/cron/rate-check") {
        const secret   = request.headers.get("x-cron-secret");
        const expected = getEnv("CRON_SECRET");
        if (!expected || secret !== expected) {
          return addSecurityHeaders(
            new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } }),
            requestId,
          );
        }
        const { sendRateCheckToAllVendors } = await import("./lib/rate-check");
        const cronWork = sendRateCheckToAllVendors()
          .then(r => console.info("[Cron] Rate-check complete:", r))
          .catch(e => console.error("[Cron] Rate-check failed:", e instanceof Error ? e.message : e));
        (ctx as { waitUntil?: (p: Promise<unknown>) => void }).waitUntil?.(cronWork);
        return addSecurityHeaders(
          new Response(JSON.stringify({ ok: true, started: true }), { headers: { "Content-Type": "application/json" } }),
          requestId,
        );
      }

      // ── Cron: weekly trade commission (every Thursday 18:00 UTC = 7pm WAT) ──
      // Business rule: ₦500 credited to every user who traded ≥$25 (≥₦7,000)
      // in the previous 7 days. Paid once per ISO week; duplicate-safe via DB.
      // Trigger: CF Cron "0 18 * * 4"  (Thursday 18:00 UTC)
      if (url.pathname === "/api/cron/weekly-commission") {
        const secret   = request.headers.get("x-cron-secret");
        const expected = getEnv("CRON_SECRET");
        if (!expected || secret !== expected) {
          return addSecurityHeaders(
            new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } }),
            requestId,
          );
        }
        const { getServerSupabase } = await import("./lib/supabase.server");
        const { payWeeklyTradeCommissions } = await import("./lib/db-helpers");
        const db = getServerSupabase();
        const cronWork = payWeeklyTradeCommissions(db)
          .then(r => console.info("[Cron] Weekly commission complete:", r))
          .catch(e => console.error("[Cron] Weekly commission failed:", e instanceof Error ? e.message : e));
        (ctx as { waitUntil?: (p: Promise<unknown>) => void }).waitUntil?.(cronWork);
        return addSecurityHeaders(
          new Response(JSON.stringify({ ok: true, started: true }), { headers: { "Content-Type": "application/json" } }),
          requestId,
        );
      }
    }

    // ── Health check — verifies config AND live Supabase connectivity ────────
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
        sentry:          !!getEnv("SENTRY_DSN"),
      };

      // ── Live Supabase connectivity probe ─────────────────────────────────────
      // Hits the Supabase REST API root endpoint — no schema cache needed.
      // A 200 or 400-range response means Supabase is reachable and responding.
      // Only a network timeout or 5xx counts as "db down".
      let dbOk = false;
      let dbLatencyMs: number | null = null;
      let dbError: string | null = null;
      if (critical.supabase) {
        const t0 = Date.now();
        const supabaseUrl = getEnv("VITE_SUPABASE_URL") ?? "";
        const anonKey    = getEnv("VITE_SUPABASE_ANON_KEY") ?? "";
        try {
          const probeUrl = `${supabaseUrl}/rest/v1/?select=1`;
          const probe = fetch(probeUrl, {
            method: "HEAD",
            headers: { "apikey": anonKey, "Authorization": `Bearer ${anonKey}` },
            signal: AbortSignal.timeout(3000),
          });
          const res = await probe;
          dbLatencyMs = Date.now() - t0;
          // Any HTTP response (even 401/406) means Supabase is reachable.
          // Only a thrown error (timeout, DNS, network) means down.
          dbOk = res.status < 500;
          if (!dbOk) dbError = `HTTP ${res.status}`;
        } catch (e) {
          dbLatencyMs = Date.now() - t0;
          dbOk = false;
          dbError = e instanceof Error ? e.message : String(e);
          console.error("[Health] Supabase probe failed:", dbError);
        }
      }

      const configOk = Object.values(critical).every(Boolean);
      const allOk    = configOk && dbOk;
      if (!configOk) {
        const missing = Object.entries(critical).filter(([, v]) => !v).map(([k]) => k);
        console.warn("[Health] Missing critical secrets:", missing.join(", "));
      }
      return addSecurityHeaders(
        new Response(JSON.stringify({
          ok: allOk,
          ts: Date.now(),
          // Git SHA baked in at build time via vite.config.ts __SENTRY_RELEASE__ define.
          // Empty string in local dev (no SENTRY_RELEASE set during local builds).
          release: __SENTRY_RELEASE__ || null,
          gitSha:  __SENTRY_RELEASE__ || null,
          critical,
          optional,
          db: { ok: dbOk, latencyMs: dbLatencyMs, error: dbError },
        }), {
          status: allOk ? 200 : 503,
          headers: { "Content-Type": "application/json" },
        }),
        requestId,
      );
    }

    // ── All other routes → TanStack React Start ─────────────────────────────
    try {
      const handler = await getServerEntry();
      const response = await startServerSpan(
        { name: `SSR ${request.method} ${url.pathname}`, op: "http.server" },
        () => handler.fetch(request, env, ctx),
      );
      const normalized = await normalizeCatastrophicSsrResponse(response);
      return addSecurityHeaders(normalized, requestId);
    } catch (error) {
      captureServerException(error, { route: "ssr_main" });
      console.error(error);
      return addSecurityHeaders(
        new Response(renderErrorPage(), {
          status: 500,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
        requestId,
      );
    }
  },
};
