// ─────────────────────────────────────────────────────────────────────────────
// Provider Health Center — Phase 14
//
// Unified health dashboard for all external providers.
// Aggregates from provider_operation_log for real metrics.
//
// Shows per provider:
//   Name, Status, Latency (p50/p95), Success Rate, Failure Rate,
//   Last Error, Last Successful Call, Current Active Key,
//   Key Expiration, Health Score
// ─────────────────────────────────────────────────────────────────────────────

import { createServerFn } from "@tanstack/react-start";
import { getServerSupabase } from "../lib/supabase.server";
import { requireAdmin }      from "../lib/auth-server";

export type ProviderHealthStatus = "healthy" | "degraded" | "down" | "unknown";

export interface ProviderHealthMetrics {
  provider:           string;
  gateway:            string;
  status:             ProviderHealthStatus;
  healthScore:        number;    // 0–100
  successRate:        number;    // 0–100 percentage
  failureRate:        number;    // 0–100 percentage
  totalCalls:         number;
  callsLast1h:        number;
  latencyP50Ms:       number;
  latencyP95Ms:       number;
  lastError:          string | null;
  lastErrorAt:        string | null;
  lastSuccessAt:      string | null;
  activeKeyMasked:    string | null;
  keyExpiresAt:       string | null;
  isFailover:         boolean;   // currently serving as a failover provider
  failoverCount:      number;    // times used as failover in last 24h
}

// ─── Get health for all providers ─────────────────────────────────────────────
export const getProviderHealth = createServerFn({ method: "GET" })
  .validator((d: Record<string, never>) => d)
  .handler(async () => {
    await requireAdmin();
    const db      = getServerSupabase();
    const h1Ago   = new Date(Date.now() -  3_600_000).toISOString();
    const h24Ago  = new Date(Date.now() - 86_400_000).toISOString();

    // Aggregate from provider_operation_log
    const { data: logs } = await db
      .from("provider_operation_log")
      .select("provider, gateway, success, failover, latency_ms, error_message, created_at")
      .gte("created_at", h24Ago)
      .order("created_at", { ascending: false })
      .limit(5000);

    // Get active key info per provider
    const { data: activeKeys } = await db
      .from("provider_api_keys")
      .select("provider, key_name, masked_value, expires_at")
      .eq("status", "active")
      .catch(() => ({ data: null })) as { data: Array<{ provider: string; key_name: string; masked_value: string; expires_at: string | null }> | null };

    const keyByProvider: Record<string, { masked: string; expiresAt: string | null }> = {};
    for (const k of activeKeys ?? []) {
      keyByProvider[k.provider] = { masked: k.masked_value, expiresAt: k.expires_at };
    }

    // Group by provider + gateway
    const providerMap: Record<string, {
      gateway: string;
      successes: number[];
      failures: number[];
      latencies: number[];
      lastError: string | null;
      lastErrorAt: string | null;
      lastSuccessAt: string | null;
      failoverCount: number;
      callsLast1h: number;
    }> = {};

    for (const log of logs ?? []) {
      const key = `${log.provider}`;
      if (!providerMap[key]) {
        providerMap[key] = {
          gateway:       log.gateway,
          successes:     [],
          failures:      [],
          latencies:     [],
          lastError:     null,
          lastErrorAt:   null,
          lastSuccessAt: null,
          failoverCount: 0,
          callsLast1h:   0,
        };
      }

      const entry = providerMap[key];
      if (log.success) {
        entry.successes.push(1);
        if (!entry.lastSuccessAt || log.created_at > entry.lastSuccessAt) {
          entry.lastSuccessAt = log.created_at;
        }
      } else {
        entry.failures.push(1);
        if (!entry.lastErrorAt || log.created_at > entry.lastErrorAt) {
          entry.lastError   = log.error_message;
          entry.lastErrorAt = log.created_at;
        }
      }

      if (log.latency_ms != null) entry.latencies.push(log.latency_ms);
      if (log.failover)           entry.failoverCount++;
      if (log.created_at >= h1Ago) entry.callsLast1h++;
    }

    const metrics: ProviderHealthMetrics[] = [];

    for (const [provider, stats] of Object.entries(providerMap)) {
      const total    = stats.successes.length + stats.failures.length;
      const succRate = total > 0 ? Math.round((stats.successes.length / total) * 100) : 100;
      const failRate = 100 - succRate;

      // Compute latency percentiles
      const sorted    = [...stats.latencies].sort((a, b) => a - b);
      const p50Ms     = sorted[Math.floor(sorted.length * 0.5)] ?? 0;
      const p95Ms     = sorted[Math.floor(sorted.length * 0.95)] ?? 0;

      // Health score: success rate * 0.7 + latency factor * 0.3
      const latencyFactor = p95Ms < 500 ? 100 : p95Ms < 1000 ? 75 : p95Ms < 3000 ? 50 : 25;
      const healthScore   = Math.round(succRate * 0.7 + latencyFactor * 0.3);

      let status: ProviderHealthStatus = "healthy";
      if (healthScore < 50)  status = "down";
      else if (healthScore < 70) status = "degraded";
      else if (total === 0)  status = "unknown";

      const keyInfo  = keyByProvider[provider];

      metrics.push({
        provider,
        gateway:         stats.gateway,
        status,
        healthScore,
        successRate:     succRate,
        failureRate:     failRate,
        totalCalls:      total,
        callsLast1h:     stats.callsLast1h,
        latencyP50Ms:    p50Ms,
        latencyP95Ms:    p95Ms,
        lastError:       stats.lastError,
        lastErrorAt:     stats.lastErrorAt,
        lastSuccessAt:   stats.lastSuccessAt,
        activeKeyMasked: keyInfo?.masked ?? null,
        keyExpiresAt:    keyInfo?.expiresAt ?? null,
        isFailover:      stats.failoverCount > stats.successes.length / 2,
        failoverCount:   stats.failoverCount,
      });
    }

    // Add any known providers with zero logs (so they show as "unknown")
    const knownProviders = [
      { provider: "squad",       gateway: "payment" },
      { provider: "paystack",    gateway: "payment" },
      { provider: "flutterwave", gateway: "payment" },
      { provider: "mono",        gateway: "identity" },
      { provider: "dojah",       gateway: "identity" },
      { provider: "busha",       gateway: "crypto"   },
      { provider: "ivoryPay",    gateway: "crypto"   },
      { provider: "reloadly",    gateway: "giftcard" },
      { provider: "onesignal",   gateway: "push"     },
      { provider: "resend",      gateway: "email"    },
      { provider: "telegram",    gateway: "messaging" },
    ];

    for (const known of knownProviders) {
      if (!providerMap[known.provider]) {
        metrics.push({
          provider:        known.provider,
          gateway:         known.gateway,
          status:          "unknown",
          healthScore:     0,
          successRate:     0,
          failureRate:     0,
          totalCalls:      0,
          callsLast1h:     0,
          latencyP50Ms:    0,
          latencyP95Ms:    0,
          lastError:       null,
          lastErrorAt:     null,
          lastSuccessAt:   null,
          activeKeyMasked: keyByProvider[known.provider]?.masked ?? null,
          keyExpiresAt:    keyByProvider[known.provider]?.expiresAt ?? null,
          isFailover:      false,
          failoverCount:   0,
        });
      }
    }

    return {
      metrics,
      generatedAt: new Date().toISOString(),
    };
  });

// ─── Get recent errors for a specific provider ────────────────────────────────
export const getProviderErrors = createServerFn({ method: "GET" })
  .validator((d: { provider: string; limit?: number }) => d)
  .handler(async ({ data }) => {
    await requireAdmin();
    const db = getServerSupabase();

    const { data: errors, error } = await db
      .from("provider_operation_log")
      .select("id, gateway, operation, error_message, latency_ms, created_at, user_id, reference")
      .eq("provider", data.provider)
      .eq("success", false)
      .order("created_at", { ascending: false })
      .limit(Math.min(data.limit ?? 50, 100));

    if (error) throw new Error(error.message);
    return errors ?? [];
  });
