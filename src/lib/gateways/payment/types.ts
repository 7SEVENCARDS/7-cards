// ─────────────────────────────────────────────────────────────────────────────
// Payment Gateway — Shared Types & Provider Interface
// All payment providers must implement PaymentProvider.
// Business logic must only depend on these types, never on provider internals.
// ─────────────────────────────────────────────────────────────────────────────

export type PaymentProviderName = "squad" | "mono" | "paystack" | "flutterwave";

// ── Normalised result types ───────────────────────────────────────────────────

export type AccountLookupResult = {
  accountName: string;
  accountNumber: string;
  bankCode: string;
};

export type PayoutResult = {
  success: boolean;
  transactionRef: string;
  paymentId?: string;
  status?: string;
  message?: string;
};

export type PayoutStatusResult = {
  status: "pending" | "success" | "failed" | "reversed";
  amount: number;
  transactionRef: string;
};

export type VirtualAccountResult = {
  accountNumber: string;
  accountName: string;
  bankName: string;
  reference: string;
};

export type PaymentLinkResult = {
  checkoutUrl: string | null;
  error?: string;
};

// ── Gateway response wrapper ──────────────────────────────────────────────────

export type PaymentGatewayResult<T> = {
  ok: true;
  data: T;
  provider: PaymentProviderName;
  latencyMs: number;
  failover: boolean;
} | {
  ok: false;
  error: string;
  provider: PaymentProviderName;
  latencyMs: number;
  failover: boolean;
};

// ── Payout params ─────────────────────────────────────────────────────────────

export type PayoutParams = {
  tradeId: string;
  amountNgn: number;
  bankCode: string;
  accountNumber: string;
  accountName: string;
  narration?: string;
};

export type AccountLookupParams = {
  bankCode: string;
  accountNumber: string;
};

export type PaymentLinkParams = {
  amountKobo: number;
  transactionRef: string;
  email: string;
  name: string;
  description: string;
  redirectUrl: string;
};

// ── Provider interface contract ───────────────────────────────────────────────
// Every provider adapter must implement this interface exactly.
// Adding a new provider = writing one new class that implements PaymentProvider.

export interface PaymentProvider {
  readonly name: PaymentProviderName;

  isConfigured(): boolean;

  lookupBankAccount(params: AccountLookupParams): Promise<AccountLookupResult>;
  initiatePayout(params: PayoutParams): Promise<PayoutResult>;
  getPayoutStatus(transactionRef: string): Promise<PayoutStatusResult>;
  createPaymentLink(params: PaymentLinkParams): Promise<PaymentLinkResult>;
}
