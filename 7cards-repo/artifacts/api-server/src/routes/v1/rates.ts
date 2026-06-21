import { Router } from "express";
import { getDb } from "../../lib/db.js";

const router = Router();

// GET /v1/rates
// Returns current exchange rates for all gift card brands.
// No auth required — rates are public.
router.get("/", async (_req, res) => {
  try {
    const db = getDb();
    const { data, error } = await db
      .from("exchange_rates")
      .select("brand, region, rate_per_dollar, trend, updated_at")
      .order("brand");

    if (error) throw error;

    const rates = (data ?? []).map((r) => ({
      brand: r.brand,
      region: r.region,
      rate_per_dollar: r.rate_per_dollar,
      trend: r.trend,
      updated_at: r.updated_at,
    }));

    res.json({ rates, count: rates.length });
  } catch (e) {
    console.error("[rates]", e);
    res
      .status(500)
      .json({ error: "Failed to fetch rates", details: String(e) });
  }
});

export default router;
