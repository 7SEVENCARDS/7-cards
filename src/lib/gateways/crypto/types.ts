// ─────────────────────────────────────────────────────────────────────────────
// Crypto Gateway — Shared Types & Provider Interface
// All crypto providers must implement CryptoProvider.
// ─────────────────────────────────────────────────────────────────────────────

export type CryptoProviderName = "busha" | "ivoryPay";

export type CryptoCurrency = "BTC" | "ETH" | "USDT" | "USDC";

export interface CryptoRateResult {
  currency:     CryptoCurrency;
  rateNgn:      number;     // NGN per 1 unit of crypto
  rateUsd:      number;     // USD per 1 unit of crypto
  spread:       number;     // provider spread %
  timestamp:    string;
}

export interface CryptoPayoutParams {
  tradeId:      string;
  userId:       string;
  currency:     CryptoCurrency;
  amountNgn:    number;
  walletAddress: string;
  narration?:   string;
}

export interface CryptoPayoutResult {
  success:      boolean;
  transactionRef: string;
  txHash?:      string;
  status:       string;
  message?:     string;
}

export interface CryptoGatewayResult<T> {
  ok:        true;
  data:      T;
  provider:  CryptoProviderName;
  latencyMs: number;
  failover:  boolean;
} | {
  ok:        false;
  error:     string;
  provider:  CryptoProviderName;
  latencyMs: number;
  failover:  boolean;
}

export interface CryptoProvider {
  readonly name: CryptoProviderName;

  isConfigured(): boolean;
  getRate(currency: CryptoCurrency): Promise<CryptoRateResult>;
  initiatePayout(params: CryptoPayoutParams): Promise<CryptoPayoutResult>;
}
