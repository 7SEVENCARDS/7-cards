import { createServerFn } from "@tanstack/react-start";
import { getServerSupabase } from "../lib/supabase.server";
import { requireAdmin } from "../lib/auth-server";
import { getCryptoRates, COMPANY_SPREAD } from "../lib/busha";
import { DEFAULT_NGN_RATE } from "../lib/constants";

// ─── Region config — forex multipliers relative to USD ───────────────────────
// US cards are always in USD (multiplier 1.0). UK/EU/CA cards are converted
// using approximate mid-market rates so the stored rate_per_dollar column
// (always NGN/USD) can be used to derive NGN per local currency unit.
export const REGION_FX: Record<string, number> = {
  US: 1.000,   // USD baseline
  UK: 1.270,   // GBP ≈ 1.27 USD (premium Naira rates)
  EU: 1.080,   // EUR ≈ 1.08 USD
  CA: 0.740,   // CAD ≈ 0.74 USD
};

// ─── Fallback rates used when Supabase is unreachable ────────────────────────
const FALLBACK_RATES = [
  // United States
  { brand: "Apple",       region: "US", rate_per_dollar: 1485, trend: "+2.1%", updated_at: new Date().toISOString() },
  { brand: "Amazon",      region: "US", rate_per_dollar: 1420, trend: "+1.5%", updated_at: new Date().toISOString() },
  { brand: "Steam",       region: "US", rate_per_dollar: 1380, trend: "-0.3%", updated_at: new Date().toISOString() },
  { brand: "Google Play", region: "US", rate_per_dollar: 1460, trend: "+0.8%", updated_at: new Date().toISOString() },
  { brand: "Xbox",        region: "US", rate_per_dollar: 1395, trend: "+1.2%", updated_at: new Date().toISOString() },
  { brand: "PlayStation", region: "US", rate_per_dollar: 1410, trend: "+0.5%", updated_at: new Date().toISOString() },
  { brand: "Netflix",     region: "US", rate_per_dollar: 1350, trend: "-0.2%", updated_at: new Date().toISOString() },
  { brand: "Spotify",     region: "US", rate_per_dollar: 1325, trend: "+0.1%", updated_at: new Date().toISOString() },
  { brand: "Razer Gold",  region: "US", rate_per_dollar: 1300, trend: "+0.3%", updated_at: new Date().toISOString() },
  { brand: "Sephora",     region: "US", rate_per_dollar: 1340, trend: "+0.7%", updated_at: new Date().toISOString() },
  { brand: "Nordstrom",   region: "US", rate_per_dollar: 1310, trend: "+0.4%", updated_at: new Date().toISOString() },
  // United Kingdom
  { brand: "Google Play", region: "UK", rate_per_dollar: 1460, trend: "+1.1%", updated_at: new Date().toISOString() },
  { brand: "Steam",       region: "UK", rate_per_dollar: 1380, trend: "+0.9%", updated_at: new Date().toISOString() },
  { brand: "Amazon",      region: "UK", rate_per_dollar: 1420, trend: "+1.3%", updated_at: new Date().toISOString() },
  { brand: "Apple",       region: "UK", rate_per_dollar: 1485, trend: "+1.8%", updated_at: new Date().toISOString() },
  { brand: "Netflix",     region: "UK", rate_per_dollar: 1350, trend: "+0.5%", updated_at: new Date().toISOString() },
  { brand: "Spotify",     region: "UK", rate_per_dollar: 1325, trend: "+0.2%", updated_at: new Date().toISOString() },
  // Eurozone
  { brand: "Steam",       region: "EU", rate_per_dollar: 1380, trend: "-0.1%", updated_at: new Date().toISOString() },
  { brand: "Google Play", region: "EU", rate_per_dollar: 1460, trend: "+0.6%", updated_at: new Date().toISOString() },
  { brand: "Amazon",      region: "EU", rate_per_dollar: 1420, trend: "+0.9%", updated_at: new Date().toISOString() },
  { brand: "Apple",       region: "EU", rate_per_dollar: 1485, trend: "+1.2%", updated_at: new Date().toISOString() },
  // Canada
  { brand: "Apple",       region: "CA", rate_per_dollar: 1485, trend: "+0.8%", updated_at: new Date().toISOString() },
  { brand: "Amazon",      region: "CA", rate_per_dollar: 1420, trend: "+0.6%", updated_at: new Date().toISOString() },
  { brand: "Steam",       region: "CA", rate_per_dollar: 1380, trend: "-0.2%", updated_at: new Date().toISOString() },
  { brand: "Google Play", region: "CA", rate_per_dollar: 1460, trend: "+0.4%", updated_at: new Date().toISOString() },
  { brand: "Xbox",        region: "CA", rate_per_dollar: 1395, trend: "+0.7%", updated_at: new Date().toISOString() },
  { brand: "PlayStation", region: "CA", rate_per_dollar: 1410, trend: "+0.3%", updated_at: new Date().toISOString() },
  { brand: "Spotify",     region: "CA", rate_per_dollar: 1325, trend: "+0.1%", updated_at: new Date().toISOString() },
];

// ─── Get gift card exchange rates ─────────────────────────────────────────────
export const getExchangeRates = createServerFn({ method: "GET" }).handler(async () => {
  try {
    const db = getServerSupabase();
    const { data, error } = await db
      .from("exchange_rates")
      .select("*")
      .order("brand");

    if (error) throw error;
    return data ?? FALLBACK_RATES;
  } catch {
    return FALLBACK_RATES;
  }
});

// ─── Refresh rates from Reloadly — P0-4 fix: now requires admin auth ──────────
// Previously unprotected — any caller could trigger a Reloadly products API call
// and upsert exchange_rates. Now gated behind requireAdmin() like all other
// rate-management functions.
export const refreshExchangeRates = createServerFn({ method: "POST" }).handler(async () => {
  await requireAdmin();

  try {
    const { getGiftCardProducts } = await import("../lib/reloadly");
    const db = getServerSupabase();
    const products = await getGiftCardProducts("US");

    const BRAND_MAP: Record<string, string> = {
      apple: "Apple",
      amazon: "Amazon",
      steam: "Steam",
      "google play": "Google Play",
      xbox: "Xbox",
      playstation: "PlayStation",
      netflix: "Netflix",
      spotify: "Spotify",
    };

    let updated = 0;
    for (const product of products) {
      const brand = Object.entries(BRAND_MAP).find(([key]) =>
        product.productName.toLowerCase().includes(key)
      )?.[1];

      if (!brand || !product.senderUnitPrice) continue;

      const ratePerDollar =
        product.recipientCurrencyCode === "NGN" && product.minRecipientDenomination > 0
          ? Math.round(product.minRecipientDenomination / product.senderUnitPrice)
          : DEFAULT_NGN_RATE;

      const { error } = await db.from("exchange_rates").upsert(
        { brand, region: "US", rate_per_dollar: ratePerDollar, source: "reloadly", updated_at: new Date().toISOString() },
        { onConflict: "brand,region" }
      );

      if (!error) updated++;
    }

    return { success: true, updated };
  } catch (e: unknown) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
});

// ─── Get crypto rates (from Busha) with company spread applied ───────────────
export const getCryptoExchangeRates = createServerFn({ method: "GET" }).handler(async () => {
  try {
    const raw = await getCryptoRates();
    return raw.map((r) => ({
      ...r,
      price: String((parseFloat(r.price) * (1 - COMPANY_SPREAD)).toFixed(2)),
      bid:   String((parseFloat(r.bid)   * (1 - COMPANY_SPREAD)).toFixed(2)),
      ask:   String((parseFloat(r.ask)   * (1 - COMPANY_SPREAD)).toFixed(2)),
    }));
  } catch {
    return [];
  }
});
