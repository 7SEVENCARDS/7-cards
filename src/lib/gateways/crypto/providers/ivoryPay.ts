// ─────────────────────────────────────────────────────────────────────────────
// IvoryPay Crypto Provider Adapter
// Secondary crypto fallback (Busha primary, IvoryPay secondary)
// Docs: https://docs.ivorypay.io/
// Env:  IVORYPAY_API_KEY, IVORYPAY_PUBLIC_KEY
// ─────────────────────────────────────────────────────────────────────────────

import { getEnv } from "../../../worker-env";
import { fetchWithTimeout } from "../../../fetch-with-timeout";
import type { CryptoProvider, CryptoProviderName, CryptoCurrency, CryptoRateResult, CryptoPayoutParams, CryptoPayoutResult } from "../types";

const BASE_URL = "https://api.ivorypay.io/v1";

export class IvoryPayProvider implements CryptoProvider {
  readonly name: CryptoProviderName = "ivoryPay";

  isConfigured(): boolean {
    return !!(getEnv("IVORYPAY_API_KEY"));
  }

  private get headers(): Record<string, string> {
    return {
      Authorization:  `Bearer ${getEnv("IVORYPAY_API_KEY") ?? ""}`,
      "Content-Type": "application/json",
    };
  }

  async getRate(currency: CryptoCurrency): Promise<CryptoRateResult> {
    const currencyMap: Record<string, string> = {
      BTC:  "bitcoin",
      ETH:  "ethereum",
      USDT: "tether",
      USDC: "usd-coin",
    };

    const res = await fetchWithTimeout(
      `${BASE_URL}/rates?base=${currencyMap[currency] ?? currency}&quote=NGN`,
      { headers: this.headers }
    );

    if (!res.ok) {
      throw new Error(`IvoryPay rate fetch failed: ${res.status}`);
    }

    const data = (await res.json()) as { rate: number; spread: number };
    const rateNgn = data.rate;
    const rateUsd = rateNgn / 1_485;

    return {
      currency,
      rateNgn:   Math.round(rateNgn),
      rateUsd:   Math.round(rateUsd * 100) / 100,
      spread:    data.spread ?? 1,
      timestamp: new Date().toISOString(),
    };
  }

  async initiatePayout(params: CryptoPayoutParams): Promise<CryptoPayoutResult> {
    const ref = `7SC-IVORY-${params.tradeId}`;

    const res = await fetchWithTimeout(`${BASE_URL}/payouts`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({
        currency:         params.currency,
        amount_ngn:       params.amountNgn,
        wallet_address:   params.walletAddress,
        reference:        ref,
        narration:        params.narration ?? `7SEVEN Trade ${params.tradeId}`,
        customer_user_id: params.userId,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as Record<string, unknown>;
      throw new Error((err.message as string) ?? `IvoryPay payout failed: ${res.status}`);
    }

    const data = (await res.json()) as {
      payout_id: string;
      tx_hash?: string;
      status: string;
      message?: string;
    };

    return {
      success:        data.status !== "failed",
      transactionRef: data.payout_id ?? ref,
      txHash:         data.tx_hash,
      status:         data.status,
      message:        data.message,
    };
  }
}
