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

// ─── Gift Card Verification ───────────────────────────────────────────────────
// Used to verify a gift card code submitted by the user (7SEVEN buys their card).
// Strategy:
//  1. Confirm the brand exists on Reloadly
//  2. Validate code format
//  3. Use Reloadly's redeem-codes endpoint to check validity
//  4. If endpoint unavailable (sandbox/starter tier), flag for manual review
//     — standard practice for Nigerian gift card trading platforms
// ─────────────────────────────────────────────────────────────────────────────
export type VerifyResult = {
  success: boolean;
  productId?: number;
  productName?: string;
  cardCode?: string;
  balance?: number;
  currency?: string;
  failureReason?: string;
  requiresManualReview?: boolean;
};

export async function verifyUserGiftCard(params: {
  brand: string;
  cardCode: string;
  cardPin?: string;
  amountUsd: number;
}): Promise<VerifyResult> {
  try {
    // Step 1: Confirm brand is supported
    const products = await getGiftCardProducts("US");
    const product = products.find((p) =>
      p.productName.toLowerCase().includes(params.brand.toLowerCase())
    );

    if (!product) {
      return {
        success: false,
        failureReason: `${params.brand} gift cards are not currently supported`,
      };
    }

    // Step 2: Validate card code format
    const cleanCode = params.cardCode.replace(/[\s\-]/g, "");
    if (cleanCode.length < 8 || cleanCode.length > 25) {
      return {
        success: false,
        failureReason: "Invalid card code format — check and re-enter",
      };
    }

    // Step 3: Try Reloadly's redeem-codes endpoint
    try {
      const verifyRes = await reloadlyFetch("/redeem-codes", {
        method: "POST",
        body: JSON.stringify({
          productId: product.productId,
          cardCode: cleanCode,
          ...(params.cardPin ? { cardPin: params.cardPin } : {}),
          amount: params.amountUsd,
        }),
      }) as { cardCode?: string; balance?: number; currencyCode?: string; status?: string };

      const isValid =
        verifyRes.status === "VERIFIED" ||
        verifyRes.status === "VALID" ||
        verifyRes.cardCode != null;

      if (isValid) {
        return {
          success: true,
          productId: product.productId,
          productName: product.productName,
          cardCode: cleanCode,
          balance: verifyRes.balance ?? params.amountUsd,
          currency: verifyRes.currencyCode ?? "USD",
        };
      }

      return {
        success: false,
        failureReason: "Card could not be verified — may be used, expired, or zero balance",
      };

    } catch (redeemErr: unknown) {
      const msg = redeemErr instanceof Error ? redeemErr.message : String(redeemErr);

      // 404/403 means this endpoint isn't available at this account tier — flag for manual review
      if (msg.includes("404") || msg.includes("403") || msg.includes("not found")) {
        console.warn("[Reloadly] redeem-codes unavailable — flagging for manual review");
        return {
          success: true,
          productId: product.productId,
          productName: product.productName,
          cardCode: cleanCode,
          requiresManualReview: true,
        };
      }

      const isCardBad =
        msg.toLowerCase().includes("redeemed") ||
        msg.toLowerCase().includes("invalid") ||
        msg.toLowerCase().includes("expired") ||
        msg.toLowerCase().includes("zero balance") ||
        msg.toLowerCase().includes("incorrect pin");

      return {
        success: false,
        failureReason: isCardBad
          ? "Card already used, expired, or wrong PIN"
          : "Verification service temporarily unavailable — try again",
      };
    }

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);

    if (msg.includes("not configured")) {
      // Reloadly credentials not set — demo mode, flag for manual review
      return {
        success: true,
        productId: 0,
        productName: `${params.brand} (Demo)`,
        cardCode: params.cardCode.replace(/[\s\-]/g, ""),
        requiresManualReview: true,
      };
    }

    return { success: false, failureReason: "Verification error — please try again" };
  }
}
