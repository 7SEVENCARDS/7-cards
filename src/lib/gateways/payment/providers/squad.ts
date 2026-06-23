// ─────────────────────────────────────────────────────────────────────────────
// Squad Payment Provider Adapter
// Wraps src/lib/squadco.ts behind the PaymentProvider interface.
// Docs: https://squadinc.gitbook.io/squad-api-documentation
// Env:  SQUADCO_SECRET_KEY, SQUADCO_ENV
// ─────────────────────────────────────────────────────────────────────────────

import { getEnv } from "../../worker-env";
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

export class SquadProvider implements PaymentProvider {
  readonly name: PaymentProviderName = "squad";

  isConfigured(): boolean {
    const key = getEnv("SQUADCO_SECRET_KEY") || getEnv("SQUADCO_API_KEY");
    return !!(key && !key.includes("YOUR_"));
  }

  async lookupBankAccount(params: AccountLookupParams): Promise<AccountLookupResult> {
    const { lookupBankAccount } = await import("../../squadco");
    const raw = await lookupBankAccount(params);
    return {
      accountName: raw.account_name,
      accountNumber: raw.account_number,
      bankCode: raw.bank_code,
    };
  }

  async initiatePayout(params: PayoutParams): Promise<PayoutResult> {
    const { initiatePayout } = await import("../../squadco");
    return initiatePayout(params);
  }

  async getPayoutStatus(transactionRef: string): Promise<PayoutStatusResult> {
    const { getPayoutStatus } = await import("../../squadco");
    const raw = await getPayoutStatus(transactionRef);
    const status = (raw.status?.toLowerCase() ?? "pending") as PayoutStatusResult["status"];
    return {
      status,
      amount: raw.amount ?? 0,
      transactionRef,
    };
  }

  async createPaymentLink(params: PaymentLinkParams): Promise<PaymentLinkResult> {
    const { createPaymentLink } = await import("../../squadco");
    return createPaymentLink(params);
  }
}
