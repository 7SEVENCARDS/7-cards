// ─────────────────────────────────────────────────────────────────────────────
// Paystack Payment Provider Adapter
// Secondary payout fallback (Squad primary, Paystack secondary, Flutterwave tertiary)
// Docs: https://paystack.com/docs/api/
// Env:  PAYSTACK_SECRET_KEY
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

const BASE_URL = "https://api.paystack.co";

export class PaystackProvider implements PaymentProvider {
  readonly name: PaymentProviderName = "paystack";

  isConfigured(): boolean {
    const key = getEnv("PAYSTACK_SECRET_KEY");
    return !!(key && key.startsWith("sk_"));
  }

  private get headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${getEnv("PAYSTACK_SECRET_KEY")}`,
      "Content-Type": "application/json",
    };
  }

  async lookupBankAccount(params: AccountLookupParams): Promise<AccountLookupResult> {
    const url = `${BASE_URL}/bank/resolve?account_number=${params.accountNumber}&bank_code=${params.bankCode}`;
    const res = await fetchWithTimeout(url, { headers: this.headers });
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as Record<string, unknown>;
      throw new Error((err.message as string) ?? `Paystack lookup failed: ${res.status}`);
    }
    const data = (await res.json()) as { data: { account_name: string; account_number: string } };
    return {
      accountName:   data.data.account_name,
      accountNumber: data.data.account_number,
      bankCode:      params.bankCode,
    };
  }

  async initiatePayout(params: PayoutParams): Promise<PayoutResult> {
    // Step 1: create transfer recipient
    const recipientRes = await fetchWithTimeout(`${BASE_URL}/transferrecipient`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({
        type:           "nuban",
        name:           params.accountName,
        account_number: params.accountNumber,
        bank_code:      params.bankCode,
        currency:       "NGN",
      }),
    });

    if (!recipientRes.ok) {
      const err = await recipientRes.json().catch(() => ({})) as Record<string, unknown>;
      throw new Error((err.message as string) ?? `Paystack recipient creation failed: ${recipientRes.status}`);
    }

    const recipientData = (await recipientRes.json()) as { data: { recipient_code: string } };
    const recipientCode = recipientData.data.recipient_code;

    // Step 2: initiate transfer
    const transferRes = await fetchWithTimeout(`${BASE_URL}/transfer`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({
        source:        "balance",
        amount:        Math.round(params.amountNgn * 100), // kobo
        recipient:     recipientCode,
        reason:        params.narration ?? `7SEVEN Trade ${params.tradeId}`,
        reference:     `7SC-${params.tradeId}`,
        currency:      "NGN",
      }),
    });

    if (!transferRes.ok) {
      const err = await transferRes.json().catch(() => ({})) as Record<string, unknown>;
      throw new Error((err.message as string) ?? `Paystack transfer failed: ${transferRes.status}`);
    }

    const transfer = (await transferRes.json()) as {
      data: { reference: string; id: number; status: string; transfer_code: string };
    };

    return {
      success:        transfer.data.status !== "failed",
      transactionRef: transfer.data.reference,
      paymentId:      String(transfer.data.id),
      status:         transfer.data.status,
    };
  }

  async getPayoutStatus(transactionRef: string): Promise<PayoutStatusResult> {
    const res = await fetchWithTimeout(`${BASE_URL}/transfer/${transactionRef}`, {
      headers: this.headers,
    });

    if (!res.ok) {
      throw new Error(`Paystack status check failed: ${res.status}`);
    }

    const data = (await res.json()) as {
      data: { status: string; amount: number; reference: string };
    };

    const rawStatus = data.data.status?.toLowerCase() ?? "pending";
    let status: PayoutStatusResult["status"] = "pending";
    if (rawStatus === "success")  status = "success";
    if (rawStatus === "failed")   status = "failed";
    if (rawStatus === "reversed") status = "reversed";

    return {
      status,
      amount:         data.data.amount / 100, // kobo → naira
      transactionRef: data.data.reference,
    };
  }

  async createPaymentLink(params: PaymentLinkParams): Promise<PaymentLinkResult> {
    const res = await fetchWithTimeout(`${BASE_URL}/transaction/initialize`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({
        email:          params.email,
        amount:         params.amountKobo,
        reference:      params.transactionRef,
        callback_url:   params.redirectUrl,
        metadata: {
          custom_fields: [
            { display_name: "Name", variable_name: "name", value: params.name },
            { display_name: "Description", variable_name: "description", value: params.description },
          ],
        },
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as Record<string, unknown>;
      return { checkoutUrl: null, error: (err.message as string) ?? "Paystack payment link failed" };
    }

    const data = (await res.json()) as { data: { authorization_url: string } };
    return { checkoutUrl: data.data.authorization_url };
  }
}
