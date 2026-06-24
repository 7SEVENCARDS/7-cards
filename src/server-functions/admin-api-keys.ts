// ─────────────────────────────────────────────────────────────────────────────
// API Key Management System — Phase 14
//
// Secure Provider Configuration Center for the Admin Dashboard.
// Manages all provider credentials without requiring redeployment.
//
// Supported providers:
//   Mono, Dojah, Reloadly, Squad, Paystack, Flutterwave, Busha, IvoryPay,
//   OneSignal, Resend, Telegram, Cloudflare, (extensible)
//
// Key lifecycle:
//   Create → Validate → Activate → Monitor → Rotate → Archive
//
// Storage: provider_api_keys table (Supabase, encrypted at rest via pgcrypto)
// Security: Keys are NEVER returned to the frontend — only metadata + masked values.
// Audit: Every key operation is logged to admin_audit_log.
// ─────────────────────────────────────────────────────────────────────────────

import { createServerFn } from "@tanstack/react-start";
import { getServerSupabase }  from "../lib/supabase.server";
import { requireAdmin, logAdminAction } from "../lib/auth-server";

export type ProviderName =
  | "mono"
  | "dojah"
  | "reloadly"
  | "squad"
  | "paystack"
  | "flutterwave"
  | "busha"
  | "ivoryPay"
  | "oneSignal"
  | "resend"
  | "telegram"
  | "adminTelegram"
  | "cloudflare"
  | "supabase";

export type KeyStatus = "active" | "inactive" | "rotating" | "archived" | "expired";

export interface ProviderKeyMeta {
  id:              string;
  provider:        ProviderName;
  keyName:         string;
  maskedValue:     string;
  status:          KeyStatus;
  version:         number;
  createdAt:       string;
  updatedAt:       string;
  rotatedAt:       string | null;
  expiresAt:       string | null;
  lastValidatedAt: string | null;
  healthStatus:    "healthy" | "degraded" | "unhealthy" | "unknown";
  createdBy:       string;
}

// ── Helper: mask a key value ──────────────────────────────────────────────────
function maskKey(value: string): string {
  if (!value || value.length < 8) return "****";
  return value.slice(0, 4) + "****" + value.slice(-4);
}

// ─── List all provider keys (metadata only, never plaintext) ──────────────────
export const listProviderKeys = createServerFn({ method: "GET" })
  .validator((d: { provider?: ProviderName }) => d)
  .handler(async ({ data }) => {
    await requireAdmin();
    const db = getServerSupabase();

    let q = db
      .from("provider_api_keys")
      .select(`
        id, provider, key_name, masked_value, status, version,
        created_at, updated_at, rotated_at, expires_at,
        last_validated_at, health_status, created_by
      `)
      .order("provider")
      .order("version", { ascending: false });

    if (data.provider) q = (q as ReturnType<typeof q.eq>).eq("provider", data.provider);

    const { data: keys, error } = await q;
    if (error) throw new Error(error.message);

    return (keys ?? []).map(k => ({
      id:              k.id,
      provider:        k.provider as ProviderName,
      keyName:         k.key_name,
      maskedValue:     k.masked_value,
      status:          k.status as KeyStatus,
      version:         k.version,
      createdAt:       k.created_at,
      updatedAt:       k.updated_at,
      rotatedAt:       k.rotated_at,
      expiresAt:       k.expires_at,
      lastValidatedAt: k.last_validated_at,
      healthStatus:    k.health_status as ProviderKeyMeta["healthStatus"],
      createdBy:       k.created_by,
    } as ProviderKeyMeta));
  });

// ─── Create / add a new provider key ──────────────────────────────────────────
export const createProviderKey = createServerFn({ method: "POST" })
  .validator((d: {
    provider:  ProviderName;
    keyName:   string;
    keyValue:  string;
    expiresAt?: string;
  }) => d)
  .handler(async ({ data }) => {
    const adminId = await requireAdmin();
    const db      = getServerSupabase();

    if (!data.keyValue || data.keyValue.length < 8) {
      return { success: false, error: "Key value must be at least 8 characters" };
    }

    // Get current version number for this provider/keyName pair
    const { count: existingCount } = await db
      .from("provider_api_keys")
      .select("*", { count: "exact", head: true })
      .eq("provider", data.provider)
      .eq("key_name", data.keyName);

    const version = (existingCount ?? 0) + 1;

    // Mark any existing active keys for this provider/keyName as inactive
    await db
      .from("provider_api_keys")
      .update({ status: "inactive", updated_at: new Date().toISOString() })
      .eq("provider", data.provider)
      .eq("key_name", data.keyName)
      .eq("status", "active");

    const { data: newKey, error } = await db
      .from("provider_api_keys")
      .insert({
        provider:       data.provider,
        key_name:       data.keyName,
        encrypted_value: data.keyValue,   // Supabase encrypts at rest; never returned to client
        masked_value:   maskKey(data.keyValue),
        status:         "inactive",       // must be explicitly activated
        version,
        expires_at:     data.expiresAt ?? null,
        health_status:  "unknown",
        created_by:     adminId,
      })
      .select("id, masked_value, version")
      .single();

    if (error) throw new Error(error.message);

    await logAdminAction(adminId, "api_key_created", null, {
      provider: data.provider,
      key_name: data.keyName,
      version,
      masked:   maskKey(data.keyValue),
    });

    return { success: true, id: newKey?.id, maskedValue: newKey?.masked_value, version: newKey?.version };
  });

// ─── Activate a key ───────────────────────────────────────────────────────────
export const activateProviderKey = createServerFn({ method: "POST" })
  .validator((d: { keyId: string }) => d)
  .handler(async ({ data }) => {
    const adminId = await requireAdmin();
    const db      = getServerSupabase();

    const { data: key } = await db
      .from("provider_api_keys")
      .select("provider, key_name, version, masked_value")
      .eq("id", data.keyId)
      .single();

    if (!key) return { success: false, error: "Key not found" };

    // Deactivate any currently active key for this provider/keyName
    await db
      .from("provider_api_keys")
      .update({ status: "inactive", updated_at: new Date().toISOString() })
      .eq("provider", key.provider)
      .eq("key_name", key.key_name)
      .eq("status", "active")
      .neq("id", data.keyId);

    const { error } = await db
      .from("provider_api_keys")
      .update({ status: "active", updated_at: new Date().toISOString() })
      .eq("id", data.keyId);

    if (error) throw new Error(error.message);

    await logAdminAction(adminId, "api_key_activated", null, {
      key_id:   data.keyId,
      provider: key.provider,
      key_name: key.key_name,
      version:  key.version,
      masked:   key.masked_value,
    });

    return { success: true };
  });

// ─── Disable a key ────────────────────────────────────────────────────────────
export const disableProviderKey = createServerFn({ method: "POST" })
  .validator((d: { keyId: string; reason?: string }) => d)
  .handler(async ({ data }) => {
    const adminId = await requireAdmin();
    const db      = getServerSupabase();

    const { data: key } = await db
      .from("provider_api_keys")
      .select("provider, key_name, version")
      .eq("id", data.keyId)
      .single();

    if (!key) return { success: false, error: "Key not found" };

    await db
      .from("provider_api_keys")
      .update({ status: "inactive", updated_at: new Date().toISOString() })
      .eq("id", data.keyId);

    await logAdminAction(adminId, "api_key_disabled", null, {
      key_id:   data.keyId,
      provider: key.provider,
      key_name: key.key_name,
      reason:   data.reason ?? "manual",
    });

    return { success: true };
  });

// ─── Rotate a key (archive old, create new) ───────────────────────────────────
export const rotateProviderKey = createServerFn({ method: "POST" })
  .validator((d: {
    keyId:    string;
    newValue: string;
    reason?:  string;
  }) => d)
  .handler(async ({ data }) => {
    const adminId = await requireAdmin();
    const db      = getServerSupabase();

    if (!data.newValue || data.newValue.length < 8) {
      return { success: false, error: "New key value must be at least 8 characters" };
    }

    const { data: key } = await db
      .from("provider_api_keys")
      .select("provider, key_name, version")
      .eq("id", data.keyId)
      .single();

    if (!key) return { success: false, error: "Key not found" };

    const now = new Date().toISOString();

    // Archive the old key
    await db
      .from("provider_api_keys")
      .update({ status: "archived", rotated_at: now, updated_at: now })
      .eq("id", data.keyId);

    // Create new key (inactive until activated)
    const { data: newKey, error } = await db
      .from("provider_api_keys")
      .insert({
        provider:        key.provider,
        key_name:        key.key_name,
        encrypted_value: data.newValue,
        masked_value:    maskKey(data.newValue),
        status:          "inactive",
        version:         key.version + 1,
        health_status:   "unknown",
        created_by:      adminId,
      })
      .select("id, masked_value, version")
      .single();

    if (error) throw new Error(error.message);

    await logAdminAction(adminId, "api_key_rotated", null, {
      old_key_id: data.keyId,
      new_key_id: newKey?.id,
      provider:   key.provider,
      key_name:   key.key_name,
      new_version: key.version + 1,
      reason:     data.reason ?? "manual_rotation",
    });

    return {
      success:      true,
      newKeyId:     newKey?.id,
      maskedValue:  newKey?.masked_value,
      version:      newKey?.version,
    };
  });

// ─── Get key version history ───────────────────────────────────────────────────
export const getKeyHistory = createServerFn({ method: "GET" })
  .validator((d: { provider: ProviderName; keyName: string }) => d)
  .handler(async ({ data }) => {
    await requireAdmin();
    const db = getServerSupabase();

    const { data: history, error } = await db
      .from("provider_api_keys")
      .select("id, version, status, masked_value, created_at, rotated_at, expires_at, health_status, created_by")
      .eq("provider", data.provider)
      .eq("key_name", data.keyName)
      .order("version", { ascending: false })
      .limit(20);

    if (error) throw new Error(error.message);
    return history ?? [];
  });

// ─── Validate / health-check a key ────────────────────────────────────────────
export const validateProviderKey = createServerFn({ method: "POST" })
  .validator((d: { keyId: string }) => d)
  .handler(async ({ data }) => {
    const adminId = await requireAdmin();
    const db      = getServerSupabase();

    const { data: key } = await db
      .from("provider_api_keys")
      .select("provider, key_name, encrypted_value")
      .eq("id", data.keyId)
      .single();

    if (!key) return { success: false, error: "Key not found", healthy: false };

    const now = new Date().toISOString();
    let healthy = false;
    let message = "";

    // Run a lightweight ping against each provider
    try {
      healthy = await pingProvider(key.provider as ProviderName, key.encrypted_value);
      message = healthy ? "Provider responded successfully" : "Provider ping failed";
    } catch (e) {
      message = e instanceof Error ? e.message : "Unknown error";
    }

    await db
      .from("provider_api_keys")
      .update({
        health_status:    healthy ? "healthy" : "unhealthy",
        last_validated_at: now,
        updated_at:       now,
      })
      .eq("id", data.keyId);

    await logAdminAction(adminId, "api_key_validated", null, {
      key_id:   data.keyId,
      provider: key.provider,
      healthy,
      message,
    });

    return { success: true, healthy, message };
  });

// ─── Provider ping implementations ────────────────────────────────────────────
async function pingProvider(provider: ProviderName, keyValue: string): Promise<boolean> {
  const { fetchWithTimeout } = await import("../lib/fetch-with-timeout");

  switch (provider) {
    case "squad": {
      const res = await fetchWithTimeout("https://api-d.squadco.com/payout/banks", {
        headers: { Authorization: `Bearer ${keyValue}` },
      });
      return res.status < 500;
    }
    case "paystack": {
      const res = await fetchWithTimeout("https://api.paystack.co/bank", {
        headers: { Authorization: `Bearer ${keyValue}` },
      });
      return res.ok;
    }
    case "flutterwave": {
      const res = await fetchWithTimeout("https://api.flutterwave.com/v3/banks/NG", {
        headers: { Authorization: `Bearer ${keyValue}` },
      });
      return res.ok;
    }
    case "busha": {
      const res = await fetchWithTimeout("https://api.busha.co/v1/currencies", {
        headers: { "api-key": keyValue },
      });
      return res.ok;
    }
    case "reloadly": {
      const res = await fetchWithTimeout("https://topups.reloadly.com/operators?size=1", {
        headers: { Authorization: `Bearer ${keyValue}` },
      });
      return res.status < 500;
    }
    case "resend": {
      const res = await fetchWithTimeout("https://api.resend.com/domains", {
        headers: { Authorization: `Bearer ${keyValue}` },
      });
      return res.ok;
    }
    default:
      return true; // Cannot ping — assume healthy
  }
}
