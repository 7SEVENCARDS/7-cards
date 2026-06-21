// ─────────────────────────────────────────────────────────────────────────────
// API Tenant management — admin-only server functions
//
// Third-party companies (TPOs) that use 7SEVEN's vendor network and support
// staff as infrastructure are called "tenants". Each tenant gets an API key
// (sk_live_...) stored as a SHA-256 hash. The plaintext key is shown ONCE
// at provisioning time.
//
// All mutations go through SECURITY DEFINER Postgres functions so the admin
// check is enforced at the DB layer regardless of call site.
// ─────────────────────────────────────────────────────────────────────────────

import { createServerFn } from "@tanstack/react-start";
import { getServerSupabase } from "../lib/supabase.server";
import { requireAdmin } from "../lib/auth-server";

// ── Provision a new API tenant ────────────────────────────────────────────────
// Returns the plaintext API key — show it once and instruct the admin to copy
// it. It is never stored in plaintext anywhere.
export const provisionApiTenant = createServerFn({ method: "POST" })
  .validator(
    (d: { name: string; contactEmail: string }) => d,
  )
  .handler(async ({ data }) => {
    const adminId = await requireAdmin();
    const db = getServerSupabase();

    const { data: result, error } = await db.rpc("provision_api_tenant", {
      p_name: data.name,
      p_contact_email: data.contactEmail,
      p_created_by: adminId,
    });

    if (error) {
      if (error.message?.includes("forbidden")) throw new Error("Admin access required");
      if (error.message?.includes("unique") || error.code === "23505") {
        throw new Error(`A tenant with email ${data.contactEmail} already exists`);
      }
      throw new Error(`Provisioning failed: ${error.message}`);
    }

    return result as {
      tenant_id: string;
      api_key: string;       // plaintext — shown once
      key_prefix: string;    // sk_live_XXXXXXXX for display
    };
  });

// ── List all API tenants ──────────────────────────────────────────────────────
export const listApiTenants = createServerFn({ method: "GET" }).handler(
  async () => {
    await requireAdmin();
    const db = getServerSupabase();

    const { data, error } = await db
      .from("api_tenants")
      .select(
        `id, name, contact_email, status, plan, rate_limit_rpm, created_at,
         api_keys(id, key_prefix, label, last_used_at, revoked_at, created_at)`,
      )
      .order("created_at", { ascending: false });

    if (error) throw new Error(`Failed to fetch tenants: ${error.message}`);
    return data ?? [];
  },
);

// ── Get a single tenant with stats ───────────────────────────────────────────
export const getApiTenant = createServerFn({ method: "GET" })
  .validator((d: { tenantId: string }) => d)
  .handler(async ({ data }) => {
    await requireAdmin();
    const db = getServerSupabase();

    const [tenantRes, tradeCountRes, ticketCountRes] = await Promise.all([
      db
        .from("api_tenants")
        .select(
          `id, name, contact_email, status, plan, rate_limit_rpm, notes, created_at,
           api_keys(id, key_prefix, label, last_used_at, revoked_at, created_at),
           api_webhook_endpoints(id, url, events, is_active, failure_count, created_at)`,
        )
        .eq("id", data.tenantId)
        .single(),

      db
        .from("api_tenant_trades")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", data.tenantId),

      db
        .from("api_tenant_support_tickets")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", data.tenantId),
    ]);

    if (tenantRes.error || !tenantRes.data) {
      throw new Error("Tenant not found");
    }

    return {
      ...tenantRes.data,
      stats: {
        total_trades: tradeCountRes.count ?? 0,
        total_support_tickets: ticketCountRes.count ?? 0,
      },
    };
  });

// ── Set tenant status (suspend / reactivate / terminate) ─────────────────────
export const setApiTenantStatus = createServerFn({ method: "POST" })
  .validator(
    (d: { tenantId: string; status: "active" | "suspended" | "terminated" }) => d,
  )
  .handler(async ({ data }) => {
    const adminId = await requireAdmin();
    const db = getServerSupabase();

    const { error } = await db.rpc("set_tenant_status", {
      p_tenant_id: data.tenantId,
      p_status: data.status,
      p_admin_id: adminId,
    });

    if (error) throw new Error(`Status update failed: ${error.message}`);
    return { tenantId: data.tenantId, status: data.status };
  });

// ── Update tenant rate limit or plan ─────────────────────────────────────────
export const updateApiTenant = createServerFn({ method: "POST" })
  .validator(
    (d: {
      tenantId: string;
      rateLimitRpm?: number;
      plan?: "free" | "pro" | "enterprise";
      notes?: string;
    }) => d,
  )
  .handler(async ({ data }) => {
    await requireAdmin();
    const db = getServerSupabase();

    const updates: Record<string, unknown> = {};
    if (data.rateLimitRpm != null) updates.rate_limit_rpm = data.rateLimitRpm;
    if (data.plan) updates.plan = data.plan;
    if (data.notes != null) updates.notes = data.notes;

    if (!Object.keys(updates).length) throw new Error("No fields to update");

    const { error } = await db
      .from("api_tenants")
      .update(updates)
      .eq("id", data.tenantId);

    if (error) throw new Error(`Update failed: ${error.message}`);
    return { tenantId: data.tenantId, updated: updates };
  });

// ── Rotate API key ────────────────────────────────────────────────────────────
// Revokes the specified key and issues a new one. Plaintext returned once.
export const rotateApiKey = createServerFn({ method: "POST" })
  .validator((d: { tenantId: string; keyId: string }) => d)
  .handler(async ({ data }) => {
    const adminId = await requireAdmin();
    const db = getServerSupabase();

    const { data: result, error } = await db.rpc("rotate_api_key", {
      p_tenant_id: data.tenantId,
      p_key_id: data.keyId,
      p_admin_id: adminId,
    });

    if (error) throw new Error(`Key rotation failed: ${error.message}`);

    return result as {
      key_id: string;
      api_key: string;    // new plaintext key — shown once
      key_prefix: string;
    };
  });

// ── List recent webhook deliveries for a tenant (admin view) ─────────────────
export const getTenantWebhookDeliveries = createServerFn({ method: "GET" })
  .validator((d: { tenantId: string; limit?: number }) => d)
  .handler(async ({ data }) => {
    await requireAdmin();
    const db = getServerSupabase();

    const { data: eps } = await db
      .from("api_webhook_endpoints")
      .select("id")
      .eq("tenant_id", data.tenantId);

    const epIds = (eps ?? []).map((e) => e.id);
    if (!epIds.length) return [];

    const { data: deliveries } = await db
      .from("api_webhook_deliveries")
      .select(
        "id, endpoint_id, event_type, attempt_count, last_status_code, delivered_at, created_at",
      )
      .in("endpoint_id", epIds)
      .order("created_at", { ascending: false })
      .limit(data.limit ?? 50);

    return deliveries ?? [];
  });
