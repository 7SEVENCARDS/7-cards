import { createServerFn } from "@tanstack/react-start";
import { getEnv } from "../lib/worker-env";
import { getServerSupabase } from "../lib/supabase.server";

export type OCRScanResult = {
  brand:        string | null;
  code:         string | null;
  pin:          string | null;
  denomination: number | null;
  currency:     string | null;
  country:      string | null;
  confidence:   number;
  riskScore:    "low" | "medium" | "high";
  flags:        string[];
  rawText:      string | null;
};

type ScanResponse =
  | { success: true;  result: OCRScanResult }
  | { success: false; error: string };

const GEMINI_MODEL = "gemini-1.5-flash";
const GEMINI_URL   = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const OCR_PROMPT = (brandHint: string) => `
You are an expert gift card OCR and fraud-detection system.
Analyze the provided gift card image and extract all usable information.

Return ONLY valid JSON with this exact structure (no markdown, no explanation):
{
  "brand":        "Apple" or null,
  "code":         "XXXX-XXXX-XXXX-XXXX" or null,
  "pin":          "1234" or null,
  "denomination": 25.00 or null,
  "currency":     "USD" or null,
  "country":      "US" or null,
  "confidence":   85,
  "riskScore":    "low",
  "flags":        [],
  "rawText":      "All visible text on the card"
}

RULES:
- confidence: 0–100 integer. How certain you are the extracted code/pin are accurate.
- riskScore "high":   image appears edited/photoshopped, VOID watermark visible, obvious fake, or is an obvious screenshot of another screen.
- riskScore "medium": blurry, partial card, screenshot artifacts, code not fully visible, unusual formatting.
- riskScore "low":    clear physical card photo, legible text, standard card format.
- flags array — include any that apply: "blurry", "screenshot", "edited", "partial", "voided", "low_quality"
- brand hint (may be wrong): ${brandHint}
`.trim();

export const scanGiftCardImage = createServerFn({ method: "POST" })
  .validator((d: { imagePath: string; brand?: string }) => d)
  .handler(async ({ data }): Promise<ScanResponse> => {
    const geminiKey = getEnv("GEMINI_API_KEY");
    if (!geminiKey) {
      return { success: false, error: "OCR service not configured (GEMINI_API_KEY missing)" };
    }

    const db = getServerSupabase();

    // Get a short-lived signed URL for the stored image
    const { data: signed, error: signErr } = await db.storage
      .from("card-images")
      .createSignedUrl(data.imagePath, 90);

    if (signErr || !signed?.signedUrl) {
      return { success: false, error: "Could not access image for scanning" };
    }

    // Fetch image and convert to base64 (Buffer is available via nodejs_compat)
    let base64: string;
    let mimeType: string;
    try {
      const imgRes = await fetch(signed.signedUrl, { signal: AbortSignal.timeout(8000) });
      if (!imgRes.ok) return { success: false, error: "Image download failed" };
      mimeType = imgRes.headers.get("content-type") ?? "image/jpeg";
      const buf = await imgRes.arrayBuffer();
      base64 = Buffer.from(buf).toString("base64");
    } catch {
      return { success: false, error: "Image fetch timed out" };
    }

    // Call Gemini Vision
    const body = {
      contents: [{
        parts: [
          { text: OCR_PROMPT(data.brand ?? "unknown") },
          { inline_data: { mime_type: mimeType, data: base64 } },
        ],
      }],
      generationConfig: {
        response_mime_type: "application/json",
        temperature:        0.05,
        maxOutputTokens:    512,
      },
    };

    let geminiRes: Response;
    try {
      geminiRes = await fetch(`${GEMINI_URL}?key=${geminiKey}`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
        signal:  AbortSignal.timeout(15000),
      });
    } catch {
      return { success: false, error: "OCR service timed out" };
    }

    if (!geminiRes.ok) {
      const errText = await geminiRes.text().catch(() => "");
      console.error("[OCR] Gemini error", geminiRes.status, errText.slice(0, 200));
      return { success: false, error: "OCR service unavailable" };
    }

    const json = await geminiRes.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };

    const rawText = json.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    if (!rawText) return { success: false, error: "Empty OCR response" };

    try {
      const parsed = JSON.parse(rawText) as OCRScanResult;
      // Clamp confidence
      parsed.confidence = Math.min(100, Math.max(0, Math.round(parsed.confidence ?? 0)));
      // Ensure valid riskScore
      if (!["low","medium","high"].includes(parsed.riskScore)) parsed.riskScore = "medium";
      // Ensure flags is array
      if (!Array.isArray(parsed.flags)) parsed.flags = [];
      return { success: true, result: parsed };
    } catch {
      return { success: false, error: "Could not parse OCR response" };
    }
  });

// ── Store OCR result back onto an existing trade ─────────────────────────────
export const saveOCRResultToTrade = createServerFn({ method: "POST" })
  .validator((d: { tradeId: string; result: OCRScanResult }) => d)
  .handler(async ({ data }) => {
    const db = getServerSupabase();
    const { error } = await db
      .from("trades")
      .update({
        ocr_brand:        data.result.brand,
        ocr_code:         data.result.code,
        ocr_pin:          data.result.pin,
        ocr_denomination: data.result.denomination,
        ocr_currency:     data.result.currency,
        ocr_country:      data.result.country,
        ocr_confidence:   data.result.confidence,
        ocr_risk_score:   data.result.riskScore,
        ocr_flags:        data.result.flags,
        ocr_scanned_at:   new Date().toISOString(),
      })
      .eq("id", data.tradeId);
    if (error) return { success: false as const, error: (error as {message?:string}).message ?? String(error) };
    return { success: true as const };
  });
