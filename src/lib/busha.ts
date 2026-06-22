// ─────────────────────────────────────────────────────────────────────────────
// Busha Crypto Exchange API Client
// Docs: https://developers.busha.co
// Dashboard: https://busha.co → Developer → API Keys
// ─────────────────────────────────────────────────────────────────────────────

import { fetchWithTimeout } from "./fetch-with-timeout";
import { getEnv } from "./worker-env";

const BUSHA_BASE = "https://api.busha.co/v1";

// ─── Company profit margin on all crypto trades ───────────────────────────────
// Applied server-side only — never exposed to clients.
export const COMPANY_SPREAD = 0.07;

function getBushaHeaders() {
  const apiKey = getEnv("BUSHA_API_KEY");

  if (!apiKey || apiKey.includes("YOUR_")) {
    throw new Error("[Busha] BUSHA_API_KEY not configured");
  }

  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

async function bushaFetch(path: string, options: RequestInit = {}) {
  const res = await fetchWithTimeout(`${BUSHA_BASE}${path}`, {
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

// ─── Deposit Addresses (Receive) ─────────────────────────────────────────────
export type BushaAccount = {
  currency: string;
  balance: string;
  locked: string;
  address?: string;
  network?: string;
  tag?: string;
};

export async function getDepositAddress(
  currency: string
): Promise<{ address: string; network: string; tag?: string }> {
  const data = (await bushaFetch(
    `/accounts/${currency.toLowerCase()}`
  )) as { data: BushaAccount };
  return {
    address: data.data.address ?? "",
    network: data.data.network ?? currency,
    tag: data.data.tag,
  };
}

export type BushaTradeResult = {
  id: string;
  status: string;
  pair: string;
  side: string;
  amount: string;
  total: string;
  fee: string;
  created_at: string;
};

export async function executeSwap(params: {
  fromCurrency: string;
  toCurrency: string;
  amount: number;
  side?: "buy" | "sell";
}): Promise<BushaTradeResult> {
  const pair = `${params.fromCurrency.toUpperCase()}-${params.toCurrency.toUpperCase()}`;
  const side = params.side ?? "sell";
  const data = (await bushaFetch("/trades", {
    method: "POST",
    body: JSON.stringify({ pair, side, amount: String(params.amount) }),
  })) as { data: BushaTradeResult };
  return data.data;
}

export type BushaTransferResult = {
  id: string;
  status: string;
  currency: string;
  amount: string;
  fee: string;
  address: string;
  tx_id?: string;
  created_at: string;
};

export async function sendCrypto(params: {
  currency: string;
  amount: number;
  address: string;
  tag?: string;
  label?: string;
}): Promise<BushaTransferResult> {
  const data = (await bushaFetch("/transfers", {
    method: "POST",
    body: JSON.stringify({
      currency: params.currency.toLowerCase(),
      amount: String(params.amount),
      address: params.address,
      ...(params.tag ? { tag: params.tag } : {}),
      label: params.label ?? "7SEVEN CARDS withdrawal",
    }),
  })) as { data: BushaTransferResult };
  return data.data;
}

export type BushaCryptoTx = {
  id: string;
  type: "trade" | "transfer";
  currency: string;
  pair?: string;
  amount: string;
  total?: string;
  status: string;
  created_at: string;
};

export async function getCryptoHistory(limit = 20): Promise<BushaCryptoTx[]> {
  const [tradesData, transfersData] = await Promise.all([
    bushaFetch(`/trades?limit=${limit}`) as Promise<{
      data: Array<{ id: string; pair: string; amount: string; total: string; status: string; created_at: string }>;
    }>,
    bushaFetch(`/transfers?limit=${limit}`) as Promise<{
      data: Array<{ id: string; currency: string; amount: string; status: string; created_at: string }>;
    }>,
  ]);

  const trades: BushaCryptoTx[] = (tradesData.data ?? []).map((t) => ({
    id: t.id, type: "trade", currency: (t.pair ?? "").split("-")[0],
    pair: t.pair, amount: t.amount, total: t.total, status: t.status, created_at: t.created_at,
  }));

  const transfers: BushaCryptoTx[] = (transfersData.data ?? []).map((t) => ({
    id: t.id, type: "transfer", currency: t.currency,
    amount: t.amount, status: t.status, created_at: t.created_at,
  }));

  return [...trades, ...transfers].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );
}

export const DEMO_DEPOSIT_ADDRESSES: Record<string, { address: string; network: string }> = {
  BTC:  { address: "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh", network: "Bitcoin" },
  ETH:  { address: "0x71C7656EC7ab88b098defB751B7401B5f6d8976F", network: "Ethereum (ERC-20)" },
  USDT: { address: "TN9RLpMApBJa5WNLBvRpGPLJNrD2nDMfZ1",         network: "Tron (TRC-20)" },
  USDC: { address: "0x71C7656EC7ab88b098defB751B7401B5f6d8976F", network: "Ethereum (ERC-20)" },
};
