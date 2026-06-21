const RELOADLY_ENV = process.env.RELOADLY_ENV ?? "sandbox";
const BASE_URL =
  RELOADLY_ENV === "production"
    ? "https://giftcards.reloadly.com"
    : "https://giftcards-sandbox.reloadly.com";
const AUTH_URL = "https://auth.reloadly.com/oauth/token";

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.token;
  }

  const clientId = process.env.RELOADLY_CLIENT_ID ?? "";
  const clientSecret = process.env.RELOADLY_CLIENT_SECRET ?? "";

  if (!clientId || clientId.includes("YOUR_")) {
    throw new Error("[Reloadly] RELOADLY_CLIENT_ID not configured");
  }

  const audience =
    RELOADLY_ENV === "production"
      ? "https://giftcards.reloadly.com"
      : "https://giftcards-sandbox.reloadly.com";

  const res = await fetch(AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
      audience,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) throw new Error(`[Reloadly] Auth failed: ${res.status}`);
  const json = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    token: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
  return cachedToken.token;
}

export interface VerifyResult {
  success: boolean;
  cardCode?: string;
  balanceUsd?: number;
  requiresManualReview?: boolean;
  failureReason?: string;
}

export async function verifyGiftCard(opts: {
  brand: string;
  cardCode: string;
  cardPin?: string;
  amountUsd: number;
}): Promise<VerifyResult> {
  const token = await getAccessToken();

  const res = await fetch(`${BASE_URL}/orders/verify-card`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/com.reloadly.giftcards-v1+json",
    },
    body: JSON.stringify({
      cardNumber: opts.cardCode,
      pinCode: opts.cardPin ?? "",
      brand: opts.brand,
      unitPrice: opts.amountUsd,
    }),
    signal: AbortSignal.timeout(20_000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    return { success: false, failureReason: `Reloadly ${res.status}: ${errText.slice(0, 200)}` };
  }

  const data = (await res.json()) as {
    status?: string;
    balance?: number;
    cardNumber?: string;
    requiresManualReview?: boolean;
  };

  if (data.status === "SUCCESSFUL" || data.balance != null) {
    return {
      success: true,
      cardCode: data.cardNumber ?? opts.cardCode,
      balanceUsd: data.balance,
      requiresManualReview: data.requiresManualReview ?? false,
    };
  }

  return { success: false, failureReason: "Card verification failed" };
}
