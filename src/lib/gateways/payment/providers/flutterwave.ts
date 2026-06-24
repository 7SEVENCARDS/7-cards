// ─────────────────────────────────────────────────────────────────────────────
// Flutterwave Payment Provider Adapter
// Tertiary payout fallback (Squad → Paystack → Flutterwave)
// Docs: https://developer.flutterwave.com/docs/
// Env:  FLUTTERWAVE_SECRET_KEY
// ─────────────────────────────────────────────────────────────────────────────

import { getEnv } from "../../../worker-env";
import { fetchWithTimeout } from "../../../fetch-with-timeout";
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

const BASE_URL = "https://api.flutterwave.com/v3";

export class FlutterwaveProvider implements PaymentProvider {
  readonly name: PaymentProviderName = "flutterwave";

  isConfigured(): boolean {
    const key = getEnv("FLUTTERWAVE_SECRET_KEY");
    return !!(key && key.startsWith("FLWSECK"));
  }

  private get headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${getEnv("FLUTTERWAVE_SECRET_KEY")}`,
      "Content-Type": "application/json",
    };
  }

  async lookupBankAccount(params: AccountLookupParams): Promise<AccountLookupResult> {
    const res = await fetchWithTimeout(
      `${BASE_URL}/accounts/resolve`,
      {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({
          account_number: params.accountNumber,
          account_bank:   params.bankCode,
        }),
      }
    );

    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as Record<string, unknown>;
      throw new Error((err.message as string) ?? `Flutterwave lookup failed: ${res.status}`);
    }

    const data = (await res.json()) as { data: { account_name: string; account_number: string } };
    return {
      accountName:   data.data.account_name,
      accountNumber: data.data.account_number,
      bankCode:      params.bankCode,
    };
  }

  async initiatePayout(params: PayoutParams): Promise<PayoutResult> {
    const ref = `7SC-FLW-${params.tradeId}`;

    const res = await fetchWithTimeout(`${BASE_URL}/transfers`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({
        account_bank:    params.bankCode,
        account_number:  params.accountNumber,
        amount:          params.amountNgn,
        narration:       params.narration ?? `7SEVEN Trade ${params.tradeId}`,
        currency:        "NGN",
        reference:       ref,
        callback_url:    "https://7evencards.xyz/api/webhooks/flutterwave",
        debit_currency:  "NGN",
        beneficiary_name: params.accountName,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as Record<string, unknown>;
      throw new Error((err.message as string) ?? `Flutterwave transfer failed: ${res.status}`);
    }

    const data = (await res.json()) as {
      data: { id: number; reference: string; status: string };
    };

    return {
      success:        data.data.status !== "FAILED",
      transactionRef: data.data.reference ?? ref,
      paymentId:      String(data.data.id),
      status:         data.data.status?.toLowerCase(),
    };
  }

  async getPayoutStatus(transactionRef: string): Promise<PayoutStatusResult> {
    const res = await fetchWithTimeout(
      `${BASE_URL}/transfers?reference=${transactionRef}`,
      { headers: this.headers }
    );

    if (!res.ok) {
      throw new Error(`Flutterwave status check failed: ${res.status}`);
    }

    const data = (await res.json()) as {
      data: Array<{ status: string; amount: number; reference: string }>;
    };

    const transfer = data.data?.[0];
    if (!transfer) throw new Error("Transfer not found in Flutterwave");

    const rawStatus = transfer.status?.toLowerCase() ?? "pending";
    let status: PayoutStatusResult["status"] = "pending";
    if (rawStatus === "successful") status = "success";
    if (rawStatus === "failed")     status = "failed";
    if (rawStatus === "reversed")   status = "reversed";

    return {
      status,
      amount:         transfer.amount,
      transactionRef: transfer.reference,
    };
  }

  async createPaymentLink(params: PaymentLinkParams): Promise<PaymentLinkResult> {
    const res = await fetchWithTimeout(`${BASE_URL}/payments`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({
        tx_ref:          params.transactionRef,
        amount:          params.amountKobo / 100,   // kobo → naira
        currency:        "NGN",
        redirect_url:    params.redirectUrl,
        customer: {
          email:  params.email,
          name:   params.name,
        },
        customizations: {
          title:       "7SEVEN CARDS",
          description: params.description,
        },
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as Record<string, unknown>;
      return { checkoutUrl: null, error: (err.message as string) ?? "Flutterwave payment link failed" };
    }

    const data = (await res.json()) as { data: { link: string } };
    return { checkoutUrl: data.data.link };
  }
}
