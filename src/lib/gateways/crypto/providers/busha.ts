// ─────────────────────────────────────────────────────────────────────────────
// Busha Crypto Provider Adapter
// Primary crypto provider
// Env: BUSHA_API_KEY
// ─────────────────────────────────────────────────────────────────────────────

import { getEnv } from "../../../worker-env";
import { fetchWithTimeout } from "../../../fetch-with-timeout";
import type { CryptoProvider, CryptoProviderName, CryptoCurrency, CryptoRateResult, CryptoPayoutParams, CryptoPayoutResult } from "../types";

const BASE_URL = "https://api.busha.co/v1";

export class BushaProvider implements CryptoProvider {
  readonly name: CryptoProviderName = "busha";

  isConfigured(): boolean {
    return !!(getEnv("BUSHA_API_KEY"));
  }

  private get headers(): Record<string, string> {
    return {
      "api-key":      getEnv("BUSHA_API_KEY") ?? "",
      "Content-Type": "application/json",
    };
  }

  async getRate(currency: CryptoCurrency): Promise<CryptoRateResult> {
    const { getCryptoRates } = await import("../../../busha");
    const rates = await getCryptoRates();

    const rateKey = currency as string;
    const rateUsd = rates[rateKey] ?? 0;

    // Convert to NGN using a base NGN/USD rate
    const rateNgn = rateUsd * 1_485;

    return {
      currency,
      rateNgn:   Math.round(rateNgn),
      rateUsd,
      spread:    0.5,
      timestamp: new Date().toISOString(),
    };
  }

  async initiatePayout(params: CryptoPayoutParams): Promise<CryptoPayoutResult> {
    const ref = `7SC-BUSHA-${params.tradeId}`;

    const res = await fetchWithTimeout(`${BASE_URL}/wallets/send`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({
        currency:    params.currency,
        amount:      params.amountNgn,
        address:     params.walletAddress,
        reference:   ref,
        description: params.narration ?? `7SEVEN Trade ${params.tradeId}`,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as Record<string, unknown>;
      throw new Error((err.message as string) ?? `Busha payout failed: ${res.status}`);
    }

    const data = (await res.json()) as { id: string; hash?: string; status: string };
    return {
      success:        data.status !== "failed",
      transactionRef: ref,
      txHash:         data.hash,
      status:         data.status,
    };
  }
}
