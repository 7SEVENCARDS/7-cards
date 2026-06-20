import { createServerFn } from "@tanstack/react-start";
import { getServerSupabase } from "../lib/supabase.server";
import { getCryptoRates, COMPANY_SPREAD } from "../lib/busha";

// ─── Get gift card exchange rates ─────────────────────────────────────────────
export const getExchangeRates = createServerFn({ method: "GET" }).handler(async () => {
  try {
    const db = getServerSupabase();
    const { data, error } = await db
      .from("exchange_rates")
      .select("*")
      .order("brand");

    if (error) throw error;
    return data ?? [];
  } catch {
    // Return hardcoded fallback if DB not configured
    return [
      { brand: "Apple",       region: "USA", rate_per_dollar: 1485, trend: "+2.1%", updated_at: new Date().toISOString() },
      { brand: "Amazon",      region: "USA", rate_per_dollar: 1420, trend: "+1.5%", updated_at: new Date().toISOString() },
      { brand: "Steam",       region: "USA", rate_per_dollar: 1380, trend: "-0.3%", updated_at: new Date().toISOString() },
      { brand: "Google Play", region: "USA", rate_per_dollar: 1460, trend: "+0.8%", updated_at: new Date().toISOString() },
      { brand: "Xbox",        region: "USA", rate_per_dollar: 1395, trend: "+1.2%", updated_at: new Date().toISOString() },
      { brand: "PlayStation", region: "USA", rate_per_dollar: 1410, trend: "+0.5%", updated_at: new Date().toISOString() },
      { brand: "Netflix",     region: "USA", rate_per_dollar: 1350, trend: "-0.2%", updated_at: new Date().toISOString() },
      { brand: "Spotify",     region: "USA", rate_per_dollar: 1325, trend: "+0.1%", updated_at: new Date().toISOString() },
    ];
  }
});

// ─── Refresh rates from Reloadly (call periodically / on-demand) ──────────────
export const refreshExchangeRates = createServerFn({ method: "POST" }).handler(async () => {
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

      // Compute NGN rate from Reloadly pricing
      const ratePerDollar =
        product.recipientCurrencyCode === "NGN" && product.minRecipientDenomination > 0
          ? Math.round(product.minRecipientDenomination / product.senderUnitPrice)
          : 1485;

      const { error } = await db.from("exchange_rates").upsert(
        { brand, region: "USA", rate_per_dollar: ratePerDollar, source: "reloadly", updated_at: new Date().toISOString() },
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
// The 7% margin is silently baked into the price the user sees.
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
