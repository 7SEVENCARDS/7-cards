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
import { createClient } from "@supabase/supabase-js";

// ── Admin auth helper (for raw CF Worker routes, not TanStack server fns) ─────
// Extracts Supabase JWT from cookie, verifies it, and checks admin role.
// Returns { adminId } on success or a Response on failure (caller must return it).
async function adminAuthFromRawRequest(
  request: Request,
): Promise<{ adminId: string; db: ReturnType<typeof createClient> } | Response> {
  const cookieHeader = request.headers.get("cookie") ?? "";
  const tokenMatch = cookieHeader.match(/sb-[^-]+-auth-token=([^;]+)/);

  const fail = (msg: string, status: number) =>
    new Response(JSON.stringify({ error: msg }), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  if (!tokenMatch) return fail("Authentication required", 401);

  let accessToken: string | null = null;
  try {
    const raw = decodeURIComponent(tokenMatch[1]);
    const parsed = JSON.parse(raw);
    accessToken = Array.isArray(parsed)
      ? (parsed[0]?.access_token ?? null)
      : (parsed?.access_token ?? null);
  } catch {
    return fail("Invalid session cookie", 401);
  }

  if (!accessToken) return fail("Authentication required", 401);

  const supaUrl = process.env.VITE_SUPABASE_URL ?? "";
  const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const db = createClient(supaUrl, supaKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: { user }, error } = await db.auth.getUser(accessToken);
  if (error || !user) return fail("Invalid or expired session", 401);

  const { data: profile } = await db
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  if (profile?.role !== "admin") return fail("Admin access required", 403);

  return { adminId: user.id, db };
}

function jsonOk(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function jsonErr(msg: string, status = 400): Response {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
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

      // ── Admin: API tenant management ────────────────────────────────────────
      // POST /api/admin/provision-tenant
      if (url.pathname === "/api/admin/provision-tenant") {
        if (!allow(rlKey("admin_provision_tenant", ip), 5, 60_000)) {
          return addSecurityHeaders(tooManyRequests(60));
        }
        const auth = await adminAuthFromRawRequest(request);
        if (auth instanceof Response) return addSecurityHeaders(auth);
        try {
          const body = await request.json() as { name?: string; contactEmail?: string };
          if (!body.name?.trim() || !body.contactEmail?.trim()) {
            return addSecurityHeaders(jsonErr("name and contactEmail are required"));
          }
          const { data, error } = await auth.db.rpc("provision_api_tenant", {
            p_name: body.name.trim(),
            p_contact_email: body.contactEmail.trim(),
            p_created_by: auth.adminId,
          });
          if (error) {
            const msg = error.message?.includes("unique") || error.code === "23505"
              ? `A tenant with email ${body.contactEmail} already exists`
              : error.message?.includes("forbidden") ? "Admin access required"
              : error.message ?? "Provisioning failed";
            return addSecurityHeaders(jsonErr(msg, 422));
          }
          // Audit log (non-blocking)
          auth.db.from("admin_audit_log").insert({
            admin_id: auth.adminId,
            action: "api_tenant_provisioned",
            target_id: (data as { tenant_id: string }).tenant_id,
            meta: { name: body.name, contact_email: body.contactEmail },
          }).then(() => {}).catch(() => {});
          return addSecurityHeaders(jsonOk(data, 201));
        } catch (e) {
          return addSecurityHeaders(jsonErr(String(e), 500));
        }
      }

      // POST /api/admin/tenants/status
      if (url.pathname === "/api/admin/tenants/status") {
        if (!allow(rlKey("admin_tenant_status", ip), 20, 60_000)) {
          return addSecurityHeaders(tooManyRequests(60));
        }
        const auth = await adminAuthFromRawRequest(request);
        if (auth instanceof Response) return addSecurityHeaders(auth);
        try {
          const body = await request.json() as { tenantId?: string; status?: string };
          if (!body.tenantId || !body.status) {
            return addSecurityHeaders(jsonErr("tenantId and status required"));
          }
          const { error } = await auth.db.rpc("set_tenant_status", {
            p_tenant_id: body.tenantId,
            p_status: body.status,
            p_admin_id: auth.adminId,
          });
          if (error) return addSecurityHeaders(jsonErr(error.message, 422));
          auth.db.from("admin_audit_log").insert({
            admin_id: auth.adminId,
            action: `api_tenant_status_${body.status}`,
            target_id: body.tenantId,
          }).then(() => {}).catch(() => {});
          return addSecurityHeaders(jsonOk({ tenantId: body.tenantId, status: body.status }));
        } catch (e) {
          return addSecurityHeaders(jsonErr(String(e), 500));
        }
      }

      // POST /api/admin/tenants/rotate-key
      if (url.pathname === "/api/admin/tenants/rotate-key") {
        if (!allow(rlKey("admin_rotate_key", ip), 10, 60_000)) {
          return addSecurityHeaders(tooManyRequests(60));
        }
        const auth = await adminAuthFromRawRequest(request);
        if (auth instanceof Response) return addSecurityHeaders(auth);
        try {
          const body = await request.json() as { tenantId?: string; keyId?: string };
          if (!body.tenantId || !body.keyId) {
            return addSecurityHeaders(jsonErr("tenantId and keyId required"));
          }
          const { data, error } = await auth.db.rpc("rotate_api_key", {
            p_tenant_id: body.tenantId,
            p_key_id: body.keyId,
            p_admin_id: auth.adminId,
          });
          if (error) return addSecurityHeaders(jsonErr(error.message, 422));
          auth.db.from("admin_audit_log").insert({
            admin_id: auth.adminId,
            action: "api_key_rotated",
            target_id: body.tenantId,
            meta: { old_key_id: body.keyId },
          }).then(() => {}).catch(() => {});
          return addSecurityHeaders(jsonOk(data));
        } catch (e) {
          return addSecurityHeaders(jsonErr(String(e), 500));
        }
      }

      // POST /api/admin/tenants/update
      if (url.pathname === "/api/admin/tenants/update") {
        if (!allow(rlKey("admin_tenant_update", ip), 20, 60_000)) {
          return addSecurityHeaders(tooManyRequests(60));
        }
        const auth = await adminAuthFromRawRequest(request);
        if (auth instanceof Response) return addSecurityHeaders(auth);
        try {
          const body = await request.json() as {
            tenantId?: string;
            rateLimitRpm?: number;
            plan?: string;
            notes?: string;
          };
          if (!body.tenantId) return addSecurityHeaders(jsonErr("tenantId required"));
          const updates: Record<string, unknown> = {};
          if (body.rateLimitRpm != null) updates.rate_limit_rpm = body.rateLimitRpm;
          if (body.plan) updates.plan = body.plan;
          if (body.notes != null) updates.notes = body.notes;
          if (!Object.keys(updates).length) return addSecurityHeaders(jsonErr("No fields to update"));
          const { error } = await auth.db
            .from("api_tenants")
            .update(updates)
            .eq("id", body.tenantId);
          if (error) return addSecurityHeaders(jsonErr(error.message, 422));
          return addSecurityHeaders(jsonOk({ tenantId: body.tenantId, updated: updates }));
        } catch (e) {
          return addSecurityHeaders(jsonErr(String(e), 500));
        }
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

    // GET /api/admin/tenants — list all API tenants with their active keys
    if (request.method === "GET" && url.pathname === "/api/admin/tenants") {
      if (!allow(rlKey("admin_list_tenants", ip), 30, 60_000)) {
        return addSecurityHeaders(tooManyRequests(60));
      }
      const auth = await adminAuthFromRawRequest(request);
      if (auth instanceof Response) return addSecurityHeaders(auth);
      try {
        const { data, error } = await auth.db
          .from("api_tenants")
          .select(`
            id, name, contact_email, status, plan, rate_limit_rpm, notes, created_at,
            api_keys(id, key_prefix, label, last_used_at, revoked_at, created_at)
          `)
          .order("created_at", { ascending: false });
        if (error) return addSecurityHeaders(jsonErr(error.message, 500));
        return addSecurityHeaders(jsonOk({ tenants: data ?? [] }));
      } catch (e) {
        return addSecurityHeaders(jsonErr(String(e), 500));
      }
    }

    // GET /api/admin/tenants/:tenantId/deliveries — last 25 webhook delivery attempts
    if (request.method === "GET" && /^\/api\/admin\/tenants\/[^/]+\/deliveries$/.test(url.pathname)) {
      if (!allow(rlKey("admin_deliveries", ip), 30, 60_000)) {
        return addSecurityHeaders(tooManyRequests(60));
      }
      const auth = await adminAuthFromRawRequest(request);
      if (auth instanceof Response) return addSecurityHeaders(auth);
      const tenantId = url.pathname.split("/")[4];
      try {
        const { data, error } = await auth.db
          .from("api_webhook_deliveries")
          .select(`
            id, event_type, status, response_code, attempt_number,
            attempted_at, next_retry_at,
            api_webhook_endpoints!inner(tenant_id, url)
          `)
          .eq("api_webhook_endpoints.tenant_id", tenantId)
          .order("attempted_at", { ascending: false })
          .limit(25);
        if (error) return addSecurityHeaders(jsonErr(error.message, 500));
        const deliveries = (data ?? []).map((d: Record<string, unknown>) => {
          const ep = d.api_webhook_endpoints as Record<string, unknown> | null;
          return {
            id: d.id,
            event_type: d.event_type,
            status: d.status,
            response_code: d.response_code,
            attempt_number: d.attempt_number,
            attempted_at: d.attempted_at,
            next_retry_at: d.next_retry_at,
            endpoint_url: ep?.url ?? null,
          };
        });
        return addSecurityHeaders(jsonOk({ deliveries }));
      } catch (e) {
        return addSecurityHeaders(jsonErr(String(e), 500));
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
