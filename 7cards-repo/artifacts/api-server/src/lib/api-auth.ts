import { createHash } from "crypto";
import type { Request, Response, NextFunction } from "express";
import { getDb } from "./db.js";

export interface TenantContext {
  tenantId: string;
  tenantName: string;
  keyId: string;
  rateLimitRpm: number;
  plan: string;
}

declare global {
  namespace Express {
    interface Request {
      tenant?: TenantContext;
    }
  }
}

export async function requireApiKey(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({
      error: "Missing API key",
      hint: "Set Authorization: Bearer sk_live_<your-key>",
    });
    return;
  }

  const key = authHeader.slice(7).trim();

  if (!key.startsWith("sk_live_")) {
    res
      .status(401)
      .json({ error: "Invalid API key format. Keys start with sk_live_" });
    return;
  }

  const keyHash = createHash("sha256").update(key).digest("hex");
  const db = getDb();

  const { data: keyRow, error } = await db
    .from("api_keys")
    .select(
      "id, revoked_at, tenant_id, api_tenants(id, name, status, rate_limit_rpm, plan)",
    )
    .eq("key_hash", keyHash)
    .single();

  if (error || !keyRow) {
    res.status(401).json({ error: "Invalid API key" });
    return;
  }

  if (keyRow.revoked_at) {
    res.status(401).json({ error: "API key has been revoked" });
    return;
  }

  const tenant = keyRow.api_tenants as {
    id: string;
    name: string;
    status: string;
    rate_limit_rpm: number;
    plan: string;
  };

  if (!tenant || tenant.status !== "active") {
    res.status(403).json({
      error: `Tenant account is ${tenant?.status ?? "unknown"}. Contact support.`,
    });
    return;
  }

  db.from("api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", keyRow.id)
    .then(() => {})
    .catch(() => {});

  req.tenant = {
    tenantId: tenant.id,
    tenantName: tenant.name,
    keyId: keyRow.id,
    rateLimitRpm: tenant.rate_limit_rpm ?? 60,
    plan: tenant.plan ?? "free",
  };

  next();
}
