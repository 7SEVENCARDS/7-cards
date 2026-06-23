// ─────────────────────────────────────────────────────────────────────────────
// IdentityGateway — Provider-Agnostic Identity Verification Orchestrator
//
// Routing strategy:
//   Primary:  Mono  (verifies BVN/NIN first)
//   Fallback: Dojah (automatic if Mono fails or is not configured)
//
// Business logic imports ONLY from this file — never from individual adapters.
// Adding a new provider: implement IdentityProvider, add to PROVIDERS array.
// ─────────────────────────────────────────────────────────────────────────────

import { MonoIdentityProvider } from "./providers/mono";
import { DojahProvider } from "./providers/dojah";
import type {
  IdentityProvider,
  IdentityProviderName,
  BVNLookupResult,
  NINLookupResult,
  IdentityMatchResult,
  PhoneVerifyResult,
  GatewayResult,
  ProviderOperationLog,
} from "./types";

// ── Provider registry — order determines routing priority ─────────────────────
const PROVIDERS: IdentityProvider[] = [
  new MonoIdentityProvider(),
  new DojahProvider(),
  // Future: new PremblyProvider(), new VerifyMeProvider()
];

// ── Audit hook — replace with real DB write when needed ───────────────────────
async function auditLog(entry: ProviderOperationLog) {
  try {
    const { getServerSupabase } = await import("../../supabase.server");
    const db = getServerSupabase();
    await db.from("provider_operation_log").insert({
      gateway: entry.gateway,
      provider: entry.provider,
      operation: entry.operation,
      reference: entry.reference ?? null,
      request_id: entry.requestId,
      success: entry.success,
      failover: entry.failover,
      latency_ms: entry.latencyMs,
      error_message: entry.errorMessage ?? null,
      user_id: entry.userId ?? null,
    });
  } catch {
    // Never let audit failures bubble up to callers
  }
}

// ── Core routing logic ────────────────────────────────────────────────────────
async function withFailover<T>(
  operation: string,
  fn: (provider: IdentityProvider) => Promise<T>,
  opts?: { userId?: string; reference?: string }
): Promise<GatewayResult<T>> {
  const requestId = crypto.randomUUID();
  let lastError = "";
  let failover = false;

  for (const provider of PROVIDERS) {
    if (!provider.isConfigured()) {
      failover = true;
      continue;
    }

    const t0 = Date.now();
    try {
      const data = await fn(provider);
      const latencyMs = Date.now() - t0;

      await auditLog({
        gateway: "identity",
        provider: provider.name,
        operation,
        reference: opts?.reference,
        requestId,
        success: true,
        failover,
        latencyMs,
        userId: opts?.userId,
      });

      return { ok: true, data, provider: provider.name, latencyMs, failover };
    } catch (e) {
      const latencyMs = Date.now() - t0;
      lastError = e instanceof Error ? e.message : String(e);

      await auditLog({
        gateway: "identity",
        provider: provider.name,
        operation,
        reference: opts?.reference,
        requestId,
        success: false,
        failover,
        latencyMs,
        errorMessage: lastError,
        userId: opts?.userId,
      });

      console.warn(
        `[IdentityGateway] ${provider.name} failed for ${operation}: ${lastError}. ` +
        (failover ? "No more providers." : "Trying fallback...")
      );

      failover = true;
    }
  }

  const lastProvider: IdentityProviderName = PROVIDERS[PROVIDERS.length - 1]?.name ?? "dojah";
  return {
    ok: false,
    error: lastError || "All identity providers unavailable",
    provider: lastProvider,
    latencyMs: 0,
    failover,
  };
}

// ── Public gateway API ────────────────────────────────────────────────────────

export const IdentityGateway = {
  /** Verify a BVN. Tries Mono first, falls back to Dojah automatically. */
  verifyBVN(bvn: string, userId?: string): Promise<GatewayResult<BVNLookupResult>> {
    return withFailover("verifyBVN", p => p.verifyBVN(bvn), { userId });
  },

  /** Verify a NIN. Tries Mono first, falls back to Dojah automatically. */
  verifyNIN(nin: string, userId?: string): Promise<GatewayResult<NINLookupResult>> {
    return withFailover("verifyNIN", p => p.verifyNIN(nin), { userId });
  },

  /** Match identity details against BVN or NIN data from a provider. */
  matchIdentity(
    params: Parameters<IdentityProvider["matchIdentity"]>[0],
    userId?: string
  ): Promise<GatewayResult<IdentityMatchResult>> {
    return withFailover("matchIdentity", p => p.matchIdentity(params), { userId });
  },

  /** Verify a phone number. */
  verifyPhone(phone: string, userId?: string): Promise<GatewayResult<PhoneVerifyResult>> {
    return withFailover("verifyPhone", p => p.verifyPhone(phone), { userId });
  },

  /** Returns which providers are currently configured. */
  getProviderStatus(): { name: IdentityProviderName; configured: boolean }[] {
    return PROVIDERS.map(p => ({ name: p.name, configured: p.isConfigured() }));
  },
};
