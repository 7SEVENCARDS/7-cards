// ─────────────────────────────────────────────────────────────────────────────
// Busha Crypto Exchange API Client
// Docs: https://developers.busha.co
// Dashboard: https://busha.co → Developer → API Keys
// ─────────────────────────────────────────────────────────────────────────────

const BUSHA_BASE = "https://api.busha.co/v1";

function getBushaHeaders() {
  const apiKey = process.env.BUSHA_API_KEY;

  if (!apiKey || apiKey.includes("YOUR_")) {
    throw new Error("[Busha] BUSHA_API_KEY not configured");
  }

  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

async function bushaFetch(path: string, options: RequestInit = {}) {
  const res = await fetch(`${BUSHA_BASE}${path}`, {
    ...options,
    headers: {
      ...getBushaHeaders(),
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`[Busha] ${path} failed (${res.status}): ${err}`);
  }

  return res.json();
}

// ─── Crypto Exchange Rates ────────────────────────────────────────────────────
// Returns NGN prices for BTC, USDT, ETH, etc.
export type BushaTicker = {
  symbol: string;       // e.g. "BTC-NGN"
  bid: string;
  ask: string;
  price: string;        // current mid price
  volume: string;
  change: string;       // 24h % change
  high: string;
  low: string;
};

export async function getCryptoRates(): Promise<BushaTicker[]> {
  try {
    const data = await bushaFetch("/ticker") as { data: BushaTicker[] };
    return data.data.filter((t) => t.symbol.endsWith("-NGN"));
  } catch (e) {
    console.error("[Busha] getCryptoRates failed:", e);
    // Fallback rates when API is not configured
    return [
      { symbol: "BTC-NGN", bid: "0", ask: "0", price: "98500000", volume: "0", change: "+2.4%", high: "0", low: "0" },
      { symbol: "ETH-NGN", bid: "0", ask: "0", price: "390000",   volume: "0", change: "+1.8%", high: "0", low: "0" },
      { symbol: "USDT-NGN",bid: "0", ask: "0", price: "1485",     volume: "0", change: "+0.1%", high: "0", low: "0" },
    ];
  }
}

export async function getCryptoPriceNgn(symbol: string): Promise<number> {
  const rates = await getCryptoRates();
  const ticker = rates.find((r) => r.symbol === `${symbol}-NGN`);
  return ticker ? parseFloat(ticker.price) : 0;
}

// ─── Portfolio Value ──────────────────────────────────────────────────────────
// Convert a crypto balance to its NGN value
export async function cryptoToNgn(
  symbol: string,
  amount: number
): Promise<number> {
  const price = await getCryptoPriceNgn(symbol);
  return Math.round(price * amount);
}

// ─── Supported Pairs ─────────────────────────────────────────────────────────
export const SUPPORTED_CRYPTO = ["BTC", "ETH", "USDT", "USDC", "BNB", "SOL"] as const;
export type CryptoSymbol = (typeof SUPPORTED_CRYPTO)[number];
