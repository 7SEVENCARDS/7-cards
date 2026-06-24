// ─────────────────────────────────────────────────────────────────────────────
// PaymentGateway — Provider-Agnostic Payment Orchestrator
//
// Routing strategy:
//   Primary:  Squad  (all payout operations)
//   Fallback: Mono   (automatic if Squad fails or is not configured)
//
// Business logic imports ONLY from this file — never from individual adapters.
// Adding a new provider: implement PaymentProvider, add to PROVIDERS array.
// ─────────────────────────────────────────────────────────────────────────────

import { SquadProvider }        from "./providers/squad";
import { PaystackProvider }     from "./providers/paystack";
import { FlutterwaveProvider }  from "./providers/flutterwave";
import type {
  PaymentProvider,
  PaymentProviderName,
  AccountLookupParams,
  AccountLookupResult,
  PayoutParams,
  PayoutResult,
  PayoutStatusResult,
  PaymentLinkParams,
  PaymentLinkResult,
  PaymentGatewayResult,
} from "./types";
import type { ProviderOperationLog } from "../identity/types";

// ── Provider registry — order determines routing priority ─────────────────────
// Payout chain: Squad (primary) → Paystack (secondary) → Flutterwave (tertiary)
const PROVIDERS: PaymentProvider[] = [
  new SquadProvider(),
  new PaystackProvider(),
  new FlutterwaveProvider(),
];

// ── Audit hook ────────────────────────────────────────────────────────────────
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
  fn: (provider: PaymentProvider) => Promise<T>,
  opts?: { userId?: string; reference?: string }
): Promise<PaymentGatewayResult<T>> {
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
        gateway: "payment",
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
        gateway: "payment",
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
        `[PaymentGateway] ${provider.name} failed for ${operation}: ${lastError}. ` +
        (failover ? "No more providers." : "Trying fallback...")
      );

      failover = true;
    }
  }

  const lastProvider: PaymentProviderName = PROVIDERS[PROVIDERS.length - 1]?.name ?? "squad";
  return {
    ok: false,
    error: lastError || "All payment providers unavailable",
    provider: lastProvider,
    latencyMs: 0,
    failover,
  };
}

// ── Public gateway API ────────────────────────────────────────────────────────

export const PaymentGateway = {
  /** Validate a Nigerian bank account number. Squad primary, Mono fallback. */
  lookupBankAccount(
    params: AccountLookupParams,
    userId?: string
  ): Promise<PaymentGatewayResult<AccountLookupResult>> {
    return withFailover(
      "lookupBankAccount",
      p => p.lookupBankAccount(params),
      { userId, reference: params.accountNumber }
    );
  },

  /** Initiate a payout transfer to a user's bank account. */
  initiatePayout(
    params: PayoutParams,
    userId?: string
  ): Promise<PaymentGatewayResult<PayoutResult>> {
    return withFailover(
      "initiatePayout",
      p => p.initiatePayout(params),
      { userId, reference: params.tradeId }
    );
  },

  /** Query the status of an existing payout. */
  getPayoutStatus(
    transactionRef: string,
    userId?: string
  ): Promise<PaymentGatewayResult<PayoutStatusResult>> {
    return withFailover(
      "getPayoutStatus",
      p => p.getPayoutStatus(transactionRef),
      { userId, reference: transactionRef }
    );
  },

  /** Create a hosted payment link for collections. */
  createPaymentLink(
    params: PaymentLinkParams,
    userId?: string
  ): Promise<PaymentGatewayResult<PaymentLinkResult>> {
    return withFailover(
      "createPaymentLink",
      p => p.createPaymentLink(params),
      { userId, reference: params.transactionRef }
    );
  },

  /** Returns which providers are currently configured. */
  getProviderStatus(): { name: PaymentProviderName; configured: boolean }[] {
    return PROVIDERS.map(p => ({ name: p.name, configured: p.isConfigured() }));
  },
};
