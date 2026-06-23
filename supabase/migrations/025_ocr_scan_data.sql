-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 025: OCR Scan Data + Fraud Screening
-- Adds OCR extraction and fraud-risk columns to trades and vendor assignments.
-- Run manually in Supabase SQL Editor.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. OCR columns on trades ─────────────────────────────────────────────────
ALTER TABLE trades ADD COLUMN IF NOT EXISTS ocr_brand         TEXT;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS ocr_code          TEXT;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS ocr_pin           TEXT;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS ocr_denomination  NUMERIC(12,2);
ALTER TABLE trades ADD COLUMN IF NOT EXISTS ocr_currency      TEXT;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS ocr_country       TEXT;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS ocr_confidence    INTEGER;   -- 0–100
ALTER TABLE trades ADD COLUMN IF NOT EXISTS ocr_risk_score    TEXT;      -- low | medium | high
ALTER TABLE trades ADD COLUMN IF NOT EXISTS ocr_flags         TEXT[] DEFAULT '{}';
ALTER TABLE trades ADD COLUMN IF NOT EXISTS ocr_scanned_at    TIMESTAMPTZ;

-- ── 2. Denormalised OCR columns on vendor_card_assignments ───────────────────
-- These are populated when a trade with OCR data creates a vendor assignment,
-- so vendors see fraud signals without needing a JOIN back to trades.
ALTER TABLE vendor_card_assignments ADD COLUMN IF NOT EXISTS ocr_confidence INTEGER;
ALTER TABLE vendor_card_assignments ADD COLUMN IF NOT EXISTS ocr_risk_score TEXT;
ALTER TABLE vendor_card_assignments ADD COLUMN IF NOT EXISTS ocr_flags      TEXT[] DEFAULT '{}';

-- ── 3. Index on risk score for admin fraud review queue ──────────────────────
CREATE INDEX IF NOT EXISTS idx_trades_ocr_risk
  ON trades (ocr_risk_score)
  WHERE ocr_risk_score IS NOT NULL;

-- ── 4. Duplicate image detection view ───────────────────────────────────────
-- Finds card_image_path values submitted more than once (possible duplicate fraud).
CREATE OR REPLACE VIEW duplicate_card_images AS
SELECT
  card_image_path,
  COUNT(*)                                            AS submission_count,
  ARRAY_AGG(id ORDER BY created_at)                  AS trade_ids,
  ARRAY_AGG(user_id ORDER BY created_at)             AS user_ids,
  MIN(created_at)                                     AS first_seen,
  MAX(created_at)                                     AS last_seen
FROM trades
WHERE card_image_path IS NOT NULL
GROUP BY card_image_path
HAVING COUNT(*) > 1;

-- ── 5. OCR fraud log function (called by server on high-risk detections) ─────
CREATE OR REPLACE FUNCTION flag_high_risk_trade(
  p_trade_id   UUID,
  p_risk_score TEXT,
  p_flags      TEXT[]
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE trades
  SET
    ocr_risk_score = p_risk_score,
    ocr_flags      = p_flags,
    status         = CASE
                       WHEN p_risk_score = 'high' THEN 'under_review'
                       ELSE status
                     END
  WHERE id = p_trade_id;
END;
$$;

-- ── 6. Grant select on new view to authenticated users (their own trades) ────
ALTER VIEW duplicate_card_images OWNER TO postgres;

COMMENT ON COLUMN trades.ocr_confidence IS '0–100 OCR extraction confidence from Gemini Vision';
COMMENT ON COLUMN trades.ocr_risk_score IS 'Fraud risk: low | medium | high';
COMMENT ON COLUMN trades.ocr_flags      IS 'Array of detected fraud signals: blurry, screenshot, edited, partial, voided';
