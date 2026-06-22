-- ─── Migration 023: Multi-region exchange rates ──────────────────────────────
-- Adds UK, EU, and CA rate rows to exchange_rates.
-- The rate_per_dollar column stays in NGN/USD terms.
-- The frontend applies a per-region forex multiplier (REGION_FX) to derive
-- NGN per local currency unit: nairaPerUnit = rate_per_dollar * forexMultiplier
-- Also adds a `region` column to the trades table for analytics.

-- 1. Normalise existing USA → US (old code used "USA", new code uses "US")
UPDATE exchange_rates SET region = 'US' WHERE region = 'USA';

-- 2. Seed United Kingdom (GBP) rates
INSERT INTO exchange_rates (brand, region, rate_per_dollar, trend, source)
VALUES
  ('Google Play', 'UK', 1460, '+1.1%', 'manual'),
  ('Steam',       'UK', 1380, '+0.9%', 'manual'),
  ('Amazon',      'UK', 1420, '+1.3%', 'manual'),
  ('Apple',       'UK', 1485, '+1.8%', 'manual'),
  ('Netflix',     'UK', 1350, '+0.5%', 'manual'),
  ('Spotify',     'UK', 1325, '+0.2%', 'manual')
ON CONFLICT (brand, region) DO UPDATE
  SET rate_per_dollar = EXCLUDED.rate_per_dollar,
      trend           = EXCLUDED.trend,
      updated_at      = now();

-- 3. Seed Eurozone (EUR) rates
INSERT INTO exchange_rates (brand, region, rate_per_dollar, trend, source)
VALUES
  ('Steam',       'EU', 1380, '-0.1%', 'manual'),
  ('Google Play', 'EU', 1460, '+0.6%', 'manual'),
  ('Amazon',      'EU', 1420, '+0.9%', 'manual'),
  ('Apple',       'EU', 1485, '+1.2%', 'manual')
ON CONFLICT (brand, region) DO UPDATE
  SET rate_per_dollar = EXCLUDED.rate_per_dollar,
      trend           = EXCLUDED.trend,
      updated_at      = now();

-- 4. Seed Canada (CAD) rates
INSERT INTO exchange_rates (brand, region, rate_per_dollar, trend, source)
VALUES
  ('Apple',       'CA', 1485, '+0.8%', 'manual'),
  ('Amazon',      'CA', 1420, '+0.6%', 'manual'),
  ('Steam',       'CA', 1380, '-0.2%', 'manual'),
  ('Google Play', 'CA', 1460, '+0.4%', 'manual'),
  ('Xbox',        'CA', 1395, '+0.7%', 'manual'),
  ('PlayStation', 'CA', 1410, '+0.3%', 'manual'),
  ('Spotify',     'CA', 1325, '+0.1%', 'manual')
ON CONFLICT (brand, region) DO UPDATE
  SET rate_per_dollar = EXCLUDED.rate_per_dollar,
      trend           = EXCLUDED.trend,
      updated_at      = now();

-- 5. Seed new US-only brands
INSERT INTO exchange_rates (brand, region, rate_per_dollar, trend, source)
VALUES
  ('Razer Gold', 'US', 1300, '+0.3%', 'manual'),
  ('Sephora',    'US', 1340, '+0.7%', 'manual'),
  ('Nordstrom',  'US', 1310, '+0.4%', 'manual')
ON CONFLICT (brand, region) DO UPDATE
  SET rate_per_dollar = EXCLUDED.rate_per_dollar,
      trend           = EXCLUDED.trend,
      updated_at      = now();

-- 6. Add region column to trades table (if not already present)
ALTER TABLE trades ADD COLUMN IF NOT EXISTS region TEXT DEFAULT 'US';

-- 7. Update trades constraint — allow new region values
-- (no constraint change needed; trades.region is freeform text)
