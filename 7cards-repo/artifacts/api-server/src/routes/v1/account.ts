import { Router } from "express";
import { requireApiKey } from "../../lib/api-auth.js";
import { getDb } from "../../lib/db.js";

const router = Router();
router.use(requireApiKey);

// ── GET /v1/account ───────────────────────────────────────────────────────────
// Returns the tenant's account information and usage stats.
router.get("/", async (req, res) => {
  const tenant = req.tenant!;
  const db = getDb();

  const [tenantRow, keyRow, endpointCount, tradeCount] = await Promise.all([
    db
      .from("api_tenants")
      .select("name, contact_email, status, plan, rate_limit_rpm, created_at")
      .eq("id", tenant.tenantId)
      .single()
      .then((r) => r.data),

    db
      .from("api_keys")
      .select("id, key_prefix, label, last_used_at, created_at")
      .eq("tenant_id", tenant.tenantId)
      .is("revoked_at", null)
      .order("created_at", { ascending: false })
      .then((r) => r.data ?? []),

    db
      .from("api_webhook_endpoints")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenant.tenantId)
      .eq("is_active", true)
      .then((r) => r.count ?? 0),

    db
      .from("api_tenant_trades")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenant.tenantId)
      .then((r) => r.count ?? 0),
  ]);

  if (!tenantRow) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }

  res.json({
    tenant_id: tenant.tenantId,
    name: tenantRow.name,
    contact_email: tenantRow.contact_email,
    status: tenantRow.status,
    plan: tenantRow.plan,
    rate_limit: {
      requests_per_minute: tenantRow.rate_limit_rpm,
    },
    api_keys: keyRow.map((k) => ({
      id: k.id,
      prefix: k.key_prefix,
      label: k.label,
      last_used_at: k.last_used_at,
      created_at: k.created_at,
    })),
    stats: {
      webhook_endpoints: endpointCount,
      total_trades: tradeCount,
    },
    member_since: tenantRow.created_at,
  });
});

export default router;
