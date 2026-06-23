// ─────────────────────────────────────────────────────────────────────────────
// Mono Payment Provider Adapter
// Implements payment operations via Mono's Payment APIs.
// Docs:    https://docs.mono.co/payments
// Env:     MONO_SECRET_KEY  (same key as identity; also used for payments)
//          MONO_APP_ID      (from Mono dashboard)
//
// PLACEHOLDER: Credentials not yet active. isConfigured() returns false until
// MONO_SECRET_KEY is set. Payment ops will fall back to Squad.
// ─────────────────────────────────────────────────────────────────────────────

import { getEnv } from "../../worker-env";
import { fetchWithTimeout } from "../../fetch-with-timeout";
import type {
  PaymentProvider,
  AccountLookupParams,
  AccountLookupResult,
  PayoutParams,
  PayoutResult,
  PayoutStatusResult,
  PaymentLinkParams,
  PaymentLinkResult,
  PaymentProviderName,
} from "../types";

const MONO_BASE = "https://api.mono.co";

function getMonoHeaders() {
  const secretKey = getEnv("MONO_SECRET_KEY");
  if (!secretKey || secretKey.includes("YOUR_")) {
    throw new Error("[Mono Payment] MONO_SECRET_KEY not configured");
  }
  return {
    "mono-sec-key": secretKey,
    "Content-Type": "application/json",
  };
}

async function monoFetch(path: string, options: RequestInit = {}) {
  const res = await fetchWithTimeout(`${MONO_BASE}${path}`, {
    ...options,
    headers: {
      ...getMonoHeaders(),
      ...(options.headers ?? {}),
    },
  });

  const data = await res.json() as Record<string, unknown>;

  if (!res.ok || data.status === "error") {
    const msg = (data.message as string) || `HTTP ${res.status}`;
    throw new Error(`[Mono Payment] ${path}: ${msg}`);
  }

  return data;
}

export class MonoPaymentProvider implements PaymentProvider {
  readonly name: PaymentProviderName = "mono";

  isConfigured(): boolean {
    const key = getEnv("MONO_SECRET_KEY");
    return !!(key && !key.includes("YOUR_") && key.length > 10);
  }

  async lookupBankAccount(params: AccountLookupParams): Promise<AccountLookupResult> {
    // POST /v3/accounts/resolve
    const data = await monoFetch("/v3/accounts/resolve", {
      method: "POST",
      body: JSON.stringify({
        bank_code: params.bankCode,
        account_number: params.accountNumber,
      }),
    }) as { data: { account_name: string; account_number: string; bank_code: string } };

    return {
      accountName: data.data.account_name,
      accountNumber: data.data.account_number,
      bankCode: data.data.bank_code,
    };
  }

  async initiatePayout(params: PayoutParams): Promise<PayoutResult> {
    // POST /v3/payments/initiate — Mono direct debit / transfer
    const transactionRef = `7SC-MONO-${params.tradeId}-${Date.now()}`;
    try {
      const data = await monoFetch("/v3/payments/initiate", {
        method: "POST",
        body: JSON.stringify({
          amount: Math.round(params.amountNgn * 100),
          bank_code: params.bankCode,
          account_number: params.accountNumber,
          account_name: params.accountName,
          currency: "NGN",
          reference: transactionRef,
          narration: params.narration ?? "7SEVEN CARDS payout",
        }),
      }) as { data: { reference: string; id: string; status: string } };

      return {
        success: true,
        transactionRef: data.data.reference,
        paymentId: data.data.id,
        status: data.data.status,
      };
    } catch (e) {
      return {
        success: false,
        transactionRef,
        message: e instanceof Error ? e.message : String(e),
      };
    }
  }

  async getPayoutStatus(transactionRef: string): Promise<PayoutStatusResult> {
    const data = await monoFetch(
      `/v3/payments/status?reference=${transactionRef}`
    ) as { data: { status: string; amount: number } };

    const rawStatus = data.data.status?.toLowerCase();
    const statusMap: Record<string, PayoutStatusResult["status"]> = {
      successful: "success",
      success: "success",
      failed: "failed",
      reversed: "reversed",
      pending: "pending",
      processing: "pending",
    };

    return {
      status: statusMap[rawStatus] ?? "pending",
      amount: (data.data.amount ?? 0) / 100,
      transactionRef,
    };
  }

  async createPaymentLink(params: PaymentLinkParams): Promise<PaymentLinkResult> {
    // POST /v3/payments/initiate-payment-link
    try {
      const data = await monoFetch("/v3/payments/initiate-payment-link", {
        method: "POST",
        body: JSON.stringify({
          amount: params.amountKobo,
          currency: "NGN",
          reference: params.transactionRef,
          customer: { email: params.email, name: params.name },
          description: params.description,
          redirect_url: params.redirectUrl,
        }),
      }) as { data: { payment_link?: string; checkout_url?: string } };

      return {
        checkoutUrl: data.data.payment_link ?? data.data.checkout_url ?? null,
      };
    } catch (e) {
      return {
        checkoutUrl: null,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }
}
