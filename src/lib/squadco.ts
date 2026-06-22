// ─────────────────────────────────────────────────────────────────────────────
// Squad by GT Payment — Payout API Client
// Docs: https://squadinc.gitbook.io/squad-api-documentation
// Dashboard: https://dashboard.squadco.com
// Sandbox:   https://sandbox-api-d.squadco.com
// ─────────────────────────────────────────────────────────────────────────────

import { fetchWithTimeout } from "./fetch-with-timeout";
import { getEnv } from "./worker-env";

// ── Lazy getters — must not read env at module load time because Vite inlines
// process.env.X at build time; read from the Worker env singleton instead. ──────
function getSquadcoEnv(): string {
  return getEnv("SQUADCO_ENV") || "sandbox";
}

function getBaseUrl(): string {
  return getSquadcoEnv() === "production"
    ? "https://api-d.squadco.com"
    : "https://sandbox-api-d.squadco.com";
}

function getHeaders() {
  // SQUADCO_SECRET_KEY is the bearer token used for all Squad API requests
  const apiKey = getEnv("SQUADCO_SECRET_KEY") || getEnv("SQUADCO_API_KEY");

  if (!apiKey || apiKey.includes("YOUR_")) {
    throw new Error("[Squadco] SQUADCO_SECRET_KEY not configured");
  }

  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

async function squadFetch(path: string, options: RequestInit = {}) {
  const res = await fetchWithTimeout(`${getBaseUrl()}${path}`, {
    ...options,
    headers: {
      ...getHeaders(),
      ...(options.headers || {}),
    },
  });

  const data = await res.json() as Record<string, unknown>;

  if (!res.ok || data.success === false) {
    throw new Error(
      `[Squadco] ${path} failed (${res.status}): ${JSON.stringify(data)}`
    );
  }

  return data;
}

// ─── Bank Codes ───────────────────────────────────────────────────────────────
// Common Nigerian bank codes for reference
export const BANK_CODES: Record<string, string> = {
  "Access Bank": "044",
  "GTBank": "058",
  "First Bank": "011",
  "Zenith Bank": "057",
  "UBA": "033",
  "Union Bank": "032",
  "Fidelity Bank": "070",
  "Stanbic IBTC": "039",
  "Sterling Bank": "232",
  "Wema Bank": "035",
  "Kuda Bank": "090267",
  "Opay": "100004",
  "Palmpay": "100033",
};

// ─── Account Name Lookup ──────────────────────────────────────────────────────
export type AccountLookupResult = {
  account_name: string;
  account_number: string;
  bank_code: string;
};

export async function lookupBankAccount(params: {
  bankCode: string;
  accountNumber: string;
}): Promise<AccountLookupResult> {
  const data = await squadFetch(
    `/payout/account/lookup?bank_code=${params.bankCode}&account_number=${params.accountNumber}`
  ) as { data: AccountLookupResult };
  return data.data;
}

// ─── Initiate Payout ──────────────────────────────────────────────────────────
export type PayoutResult = {
  success: boolean;
  transactionRef: string;
  paymentId?: string;
  status?: string;
  message?: string;
};

export async function initiatePayout(params: {
  tradeId: string;
  amountNgn: number;     // in Naira (will be converted to kobo)
  bankCode: string;
  accountNumber: string;
  accountName: string;
  narration?: string;
}): Promise<PayoutResult> {
  try {
    const transactionRef = `7SC-${params.tradeId}-${Date.now()}`;

    const data = await squadFetch("/payout/initiate", {
      method: "POST",
      body: JSON.stringify({
        transaction_reference: transactionRef,
        amount: Math.round(params.amountNgn * 100), // convert NGN → kobo
        bank_code: params.bankCode,
        account_number: params.accountNumber,
        currency_id: "NGN",
        remarks: params.narration || "7SEVEN CARDS payout",
      }),
    }) as {
      data: {
        transaction_reference: string;
        payment_ref: string;
        status: string;
      };
    };

    return {
      success: true,
      transactionRef: data.data.transaction_reference,
      paymentId: data.data.payment_ref,
      status: data.data.status,
    };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      success: false,
      transactionRef: "",
      message,
    };
  }
}

// ─── Payout Status ────────────────────────────────────────────────────────────
export async function getPayoutStatus(transactionRef: string) {
  const data = await squadFetch(
    `/payout/transaction?transaction_reference=${transactionRef}`
  ) as { data: { status: string; amount: number } };
  return data.data;
}

// ─── Create Payment Link (for premium subscriptions) ─────────────────────────
export async function createPaymentLink(params: {
  amountKobo: number;
  transactionRef: string;
  email: string;
  name: string;
  description: string;
  redirectUrl: string;
}): Promise<{ checkoutUrl: string | null; error?: string }> {
  try {
    const res = await fetchWithTimeout(`${getBaseUrl()}/merchant/create-payment-link`, {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify({
        amount: params.amountKobo,
        currency: "NGN",
        transaction_ref: params.transactionRef,
        email: params.email,
        customer_name: params.name,
        payment_description: params.description,
        redirect_link: params.redirectUrl,
        pass_charge: false,
      }),
    });

    const json = await res.json() as {
      success?: boolean;
      data?: { checkout_url?: string };
      message?: string;
    };

    return { checkoutUrl: json.data?.checkout_url ?? null };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { checkoutUrl: null, error: msg };
  }
}
