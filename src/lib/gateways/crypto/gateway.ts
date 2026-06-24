// ─────────────────────────────────────────────────────────────────────────────
// CryptoGateway — Provider-Agnostic Crypto Orchestrator
//
// Routing strategy:
//   Primary:   Busha    (all crypto operations)
//   Secondary: IvoryPay (automatic if Busha fails or is not configured)
//
// Business logic imports ONLY from this file.
// ─────────────────────────────────────────────────────────────────────────────

import { BushaProvider }     from "./providers/busha";
import { IvoryPayProvider }  from "./providers/ivoryPay";
import type {
  CryptoProvider,
  CryptoProviderName,
  CryptoCurrency,
  CryptoRateResult,
  CryptoPayoutParams,
  CryptoPayoutResult,
  CryptoGatewayResult,
} from "./types";

const PROVIDERS: CryptoProvider[] = [
  new BushaProvider(),
  new IvoryPayProvider(),
];

async function auditLog(entry: {
  provider: string;
  operation: string;
  success: boolean;
  failover: boolean;
  latencyMs: number;
  errorMessage?: string;
  userId?: string;
}): Promise<void> {
  try {
    const { getServerSupabase } = await import("../../supabase.server");
    const db = getServerSupabase();
    await db.from("provider_operation_log").insert({
      gateway:       "crypto",
      provider:      entry.provider,
      operation:     entry.operation,
      request_id:    crypto.randomUUID(),
      success:       entry.success,
      failover:      entry.failover,
      latency_ms:    entry.latencyMs,
      error_message: entry.errorMessage ?? null,
      user_id:       entry.userId ?? null,
    });
  } catch {
    // Never let audit failures bubble up
  }
}

async function withFailover<T>(
  operation: string,
  fn: (provider: CryptoProvider) => Promise<T>,
  opts?: { userId?: string }
): Promise<CryptoGatewayResult<T>> {
  let lastError = "";
  let failover  = false;

  for (const provider of PROVIDERS) {
    if (!provider.isConfigured()) {
      failover = true;
      continue;
    }

    const t0 = Date.now();
    try {
      const data      = await fn(provider);
      const latencyMs = Date.now() - t0;
      await auditLog({ provider: provider.name, operation, success: true, failover, latencyMs, userId: opts?.userId });
      return { ok: true, data, provider: provider.name, latencyMs, failover };
    } catch (e) {
      const latencyMs = Date.now() - t0;
      lastError = e instanceof Error ? e.message : String(e);
      await auditLog({ provider: provider.name, operation, success: false, failover, latencyMs, errorMessage: lastError, userId: opts?.userId });
      console.warn(`[CryptoGateway] ${provider.name} failed for ${operation}: ${lastError}.${failover ? " No more providers." : " Trying fallback..."}`);
      failover = true;
    }
  }

  const lastProvider: CryptoProviderName = PROVIDERS[PROVIDERS.length - 1]?.name ?? "busha";
  return { ok: false, error: lastError || "All crypto providers unavailable", provider: lastProvider, latencyMs: 0, failover };
}

export const CryptoGateway = {
  getRate(currency: CryptoCurrency, userId?: string): Promise<CryptoGatewayResult<CryptoRateResult>> {
    return withFailover("getRate", p => p.getRate(currency), { userId });
  },

  initiatePayout(params: CryptoPayoutParams): Promise<CryptoGatewayResult<CryptoPayoutResult>> {
    return withFailover("initiatePayout", p => p.initiatePayout(params), { userId: params.userId });
  },

  getProviderStatus(): { name: CryptoProviderName; configured: boolean }[] {
    return PROVIDERS.map(p => ({ name: p.name, configured: p.isConfigured() }));
  },
};
