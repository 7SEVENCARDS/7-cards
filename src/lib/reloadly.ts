// ─────────────────────────────────────────────────────────────────────────────
// Reloadly Gift Card API Client
// Docs: https://developers.reloadly.com/apis/gift-cards/overview
// Credentials: https://developers.reloadly.com → API Keys
// ─────────────────────────────────────────────────────────────────────────────

const RELOADLY_ENV = process.env.RELOADLY_ENV || "sandbox";

const BASE_URL =
  RELOADLY_ENV === "production"
    ? "https://giftcards.reloadly.com"
    : "https://giftcards-sandbox.reloadly.com";

const AUTH_URL = "https://auth.reloadly.com/oauth/token";

let cachedToken: { token: string; expiresAt: number } | null = null;

// ─── Auth ─────────────────────────────────────────────────────────────────────
async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.token;
  }

  const clientId = process.env.RELOADLY_CLIENT_ID;
  const clientSecret = process.env.RELOADLY_CLIENT_SECRET;

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
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`[Reloadly] Auth failed: ${err}`);
  }

  const data = await res.json() as { access_token: string; expires_in: number };
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };

  return cachedToken.token;
}

async function reloadlyFetch(path: string, options: RequestInit = {}) {
  const token = await getAccessToken();
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/com.reloadly.giftcards-v1+json",
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`[Reloadly] ${path} failed (${res.status}): ${err}`);
  }

  return res.json();
}

// ─── Gift Card Brands / Products ──────────────────────────────────────────────
export type ReloadlyProduct = {
  productId: number;
  productName: string;
  countryCode: string;
  denominationType: "FIXED" | "RANGE";
  recipientCurrencyCode: string;
  minRecipientDenomination: number;
  maxRecipientDenomination: number;
  fixedRecipientDenominations: number[];
  senderCurrencyCode: string;
  senderUnitPrice: number;
  logoUrls: string[];
};

export async function getGiftCardProducts(countryCode = "US") {
  try {
    const data = await reloadlyFetch(
      `/products?countryCode=${countryCode}&size=50&page=1`
    ) as { content: ReloadlyProduct[] };
    return data.content;
  } catch (e) {
    console.error("[Reloadly] getGiftCardProducts:", e);
    return [];
  }
}

// ─── Exchange Rates ───────────────────────────────────────────────────────────
// Reloadly provides NGN rates via their FX endpoint
export async function getNairaRateForBrand(brand: string, amountUsd: number): Promise<number> {
  try {
    // Reloadly quotes in sender currency (USD) to recipient (NGN)
    // We fetch the product price to derive the implied NGN rate
    const products = await getGiftCardProducts("US");
    const product = products.find((p) =>
      p.productName.toLowerCase().includes(brand.toLowerCase())
    );

    if (product && product.recipientCurrencyCode === "NGN") {
      // rate = NGN recipient value / USD sender price
      return Math.round(product.senderUnitPrice > 0
        ? (product.minRecipientDenomination / product.senderUnitPrice)
        : 1485);
    }

    return 1485; // fallback default rate
  } catch {
    return 1485;
  }
}

// ─── Gift Card Redemption / Verification ─────────────────────────────────────
export type RedeemResult = {
  success: boolean;
  transactionId?: string;
  orderId?: string;
  status?: string;
  balance?: number;
  failureReason?: string;
};

export async function redeemGiftCard(params: {
  productId: number;
  cardCode: string;
  cardPin?: string;
  amountUsd: number;
  tradeId: string;
  recipientEmail: string;
}): Promise<RedeemResult> {
  try {
    const data = await reloadlyFetch("/orders", {
      method: "POST",
      body: JSON.stringify({
        productId: params.productId,
        quantity: 1,
        unitPrice: params.amountUsd,
        customIdentifier: params.tradeId,
        senderName: "7SEVEN CARDS",
        recipientEmail: params.recipientEmail,
        preOrder: false,
        // For digital gift card redemption with a code
        giftCode: params.cardCode,
        giftPin: params.cardPin,
      }),
    }) as {
      transactionId: string;
      orderId: string;
      status: string;
    };

    return {
      success: true,
      transactionId: String(data.transactionId),
      orderId: String(data.orderId),
      status: data.status,
    };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    const isInvalid =
      message.includes("redeemed") ||
      message.includes("invalid") ||
      message.includes("expired") ||
      message.includes("zero balance");

    return {
      success: false,
      failureReason: isInvalid
        ? "Card already redeemed or invalid"
        : "Verification service unavailable",
    };
  }
}
