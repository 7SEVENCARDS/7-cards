import { useState, useRef } from "react";
import {
  ChevronLeft, ChevronRight, Eye, EyeOff, ScanLine, Plus, X,
  Layers, Camera, ImagePlus, Loader2, Sparkles, ShieldAlert,
  ShieldCheck, ShieldX, CheckCircle2, Wand2,
} from "lucide-react";
import { supabase } from "../lib/supabase";
import { scanGiftCardImage } from "../server-functions/ocr";
import type { OCRScanResult } from "../server-functions/ocr";

type CardEntry = {
  code:           string;
  pin:            string;
  showPin:        boolean;
  imagePath?:     string;
  imagePreview?:  string;
  imageUploading?: boolean;
  ocrScanning?:   boolean;
  ocrResult?:     OCRScanResult | null;
};

interface CodeEntryScreenProps {
  brand:            string;
  amountUsd:        string;
  estimatedNgn:     string;
  userId?:          string;
  onBack:           () => void;
  onContinue:       (code: string, pin?: string, imagePath?: string, ocrResult?: OCRScanResult) => void;
  onContinueBatch?: (cards: Array<{ cardCode: string; cardPin?: string; imagePath?: string; ocrResult?: OCRScanResult }>) => void;
}

// ── Risk badge ────────────────────────────────────────────────────────────────
function RiskBadge({ score }: { score: OCRScanResult["riskScore"] }) {
  if (score === "low")
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-green-500/15 text-green-400 border border-green-500/25">
        <ShieldCheck className="size-2.5" /> LOW RISK
      </span>
    );
  if (score === "medium")
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/25">
        <ShieldAlert className="size-2.5" /> MEDIUM RISK
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-red-500/15 text-red-400 border border-red-500/25">
      <ShieldX className="size-2.5" /> HIGH RISK
    </span>
  );
}

export function CodeEntryScreen({
  brand,
  amountUsd,
  estimatedNgn,
  userId,
  onBack,
  onContinue,
  onContinueBatch,
}: CodeEntryScreenProps) {
  const [cards, setCards] = useState<CardEntry[]>([{ code: "", pin: "", showPin: false }]);
  const [error, setError] = useState("");
  const cameraRefs  = useRef<Array<HTMLInputElement | null>>([]);
  const galleryRefs = useRef<Array<HTMLInputElement | null>>([]);

  const BRAND_LOGO_URLS: Record<string, string> = {
    "Apple":       "https://cdn.simpleicons.org/apple/ffffff",
    "Steam":       "https://cdn.simpleicons.org/steam/ffffff",
    "Amazon":      "https://cdn.simpleicons.org/amazon/FF9900",
    "Google Play": "https://cdn.simpleicons.org/googleplay/ffffff",
    "Xbox":        "https://cdn.simpleicons.org/xbox/52B043",
    "PlayStation": "https://cdn.simpleicons.org/playstation/ffffff",
    "Netflix":     "https://cdn.simpleicons.org/netflix/E50914",
    "Spotify":     "https://cdn.simpleicons.org/spotify/1DB954",
    "Razer Gold":  "https://cdn.simpleicons.org/razer/44D62C",
    "Sephora":     "https://cdn.simpleicons.org/sephora/ffffff",
    "Nordstrom":   "https://cdn.simpleicons.org/nordstrom/ffffff",
    "eBay":        "https://cdn.simpleicons.org/ebay/ffffff",
    "Walmart":     "https://cdn.simpleicons.org/walmart/0071CE",
    "iTunes":      "https://cdn.simpleicons.org/itunes/FC3C44",
    "Nike":        "https://cdn.simpleicons.org/nike/ffffff",
    "Visa":        "https://cdn.simpleicons.org/visa/1A1F71",
    "Mastercard":  "https://cdn.simpleicons.org/mastercard/EB001B",
  };
  const BRAND_EMOJI: Record<string, string> = {
    Apple: "🍎", Amazon: "📦", Steam: "🎮", "Google Play": "▶️",
    Xbox: "🟢", PlayStation: "🎯", Netflix: "🎬", Spotify: "🎵",
    "Razer Gold": "💎", Sephora: "💄", eBay: "🛒", Walmart: "🏪",
    iTunes: "🎵", Nike: "👟",
  };

  const isBatch = cards.length > 1;

  // ── Mutators ──────────────────────────────────────────────────────────────
  const updateCard = (i: number, field: "code" | "pin", val: string) =>
    setCards(cs => cs.map((c, idx) => idx === i ? { ...c, [field]: field === "code" ? val.toUpperCase() : val } : c));

  const togglePin = (i: number) =>
    setCards(cs => cs.map((c, idx) => idx === i ? { ...c, showPin: !c.showPin } : c));

  const addCard = () => {
    if (cards.length >= 10) return;
    setError("");
    setCards(cs => [...cs, { code: "", pin: "", showPin: false }]);
  };

  const removeCard = (i: number) =>
    setCards(cs => cs.filter((_, idx) => idx !== i));

  // ── Auto-fill from OCR ────────────────────────────────────────────────────
  const applyOCR = (i: number, result: OCRScanResult) => {
    setCards(cs => cs.map((c, idx) => {
      if (idx !== i) return c;
      return {
        ...c,
        code: c.code.trim() || (result.code ?? ""),
        pin:  c.pin.trim()  || (result.pin  ?? ""),
        ocrResult: result,
      };
    }));
  };

  // ── Image upload ──────────────────────────────────────────────────────────
  const handleImageSelect = async (i: number, file: File) => {
    if (!file) return;

    const preview = URL.createObjectURL(file);
    setCards(cs => cs.map((c, idx) =>
      idx === i ? { ...c, imagePreview: preview, imageUploading: true, imagePath: undefined, ocrResult: null, ocrScanning: false } : c
    ));

    if (!userId) {
      setCards(cs => cs.map((c, idx) => idx === i ? { ...c, imageUploading: false } : c));
      return;
    }

    // 1. Upload to Supabase Storage
    let uploadedPath: string | undefined;
    try {
      const ext  = file.name.split(".").pop()?.toLowerCase() || "jpg";
      const path = `${userId}/${Date.now()}_${i}.${ext}`;
      const { data, error: uploadErr } = await supabase.storage
        .from("card-images")
        .upload(path, file, { cacheControl: "3600", upsert: false });

      if (uploadErr) {
        console.warn("[CardImage] Upload failed:", uploadErr.message);
        setCards(cs => cs.map((c, idx) => idx === i ? { ...c, imageUploading: false } : c));
        return;
      }
      uploadedPath = data.path;
      setCards(cs => cs.map((c, idx) =>
        idx === i ? { ...c, imagePath: data.path, imageUploading: false, ocrScanning: true } : c
      ));
    } catch (e) {
      console.warn("[CardImage] Upload error:", e instanceof Error ? e.message : e);
      setCards(cs => cs.map((c, idx) => idx === i ? { ...c, imageUploading: false } : c));
      return;
    }

    // 2. Auto-run OCR scan
    if (uploadedPath) {
      try {
        const res = await scanGiftCardImage({ data: { imagePath: uploadedPath, brand } });
        if (res.success) {
          setCards(cs => cs.map((c, idx) => {
            if (idx !== i) return c;
            const updated: CardEntry = {
              ...c,
              ocrScanning: false,
              ocrResult:   res.result,
              // Auto-fill only if the field is still empty
              code: c.code.trim() || (res.result.code ?? ""),
              pin:  c.pin.trim()  || (res.result.pin  ?? ""),
            };
            return updated;
          }));
        } else {
          setCards(cs => cs.map((c, idx) => idx === i ? { ...c, ocrScanning: false, ocrResult: null } : c));
        }
      } catch (e) {
        console.warn("[OCR] Scan failed:", e instanceof Error ? e.message : e);
        setCards(cs => cs.map((c, idx) => idx === i ? { ...c, ocrScanning: false, ocrResult: null } : c));
      }
    }
  };

  const removeImage = (i: number) => {
    const prev = cards[i]?.imagePreview;
    if (prev) URL.revokeObjectURL(prev);
    setCards(cs => cs.map((c, idx) =>
      idx === i ? { ...c, imagePath: undefined, imagePreview: undefined, imageUploading: false, ocrScanning: false, ocrResult: null } : c
    ));
  };

  // ── Submit ─────────────────────────────────────────────────────────────────
  const handleContinue = () => {
    for (let i = 0; i < cards.length; i++) {
      const c = cards[i];
      const label = cards.length > 1 ? `Card ${i + 1}` : "Card";
      if (!c.code.trim()) { setError(`${label}: enter the card code`); return; }
      if (c.code.trim().length < 8) { setError(`${label}: code looks too short`); return; }
      if (c.imageUploading) { setError(`${label}: image still uploading — wait a moment`); return; }
      if (c.ocrScanning)   { setError(`${label}: still scanning image — wait a moment`); return; }
    }
    setError("");

    if (cards.length === 1) {
      onContinue(cards[0].code.trim(), cards[0].pin.trim() || undefined, cards[0].imagePath, cards[0].ocrResult ?? undefined);
    } else {
      onContinueBatch?.(cards.map(c => ({
        cardCode:  c.code.trim(),
        cardPin:   c.pin.trim() || undefined,
        imagePath: c.imagePath,
        ocrResult: c.ocrResult ?? undefined,
      })));
    }
  };

  const brandLogo = BRAND_LOGO_URLS[brand];
  const brandEmoji = BRAND_EMOJI[brand] ?? "🎁";

  return (
    <div className="flex flex-col pb-8">
      <header className="px-5 pt-12 pb-4 flex items-center gap-4">
        <button
          onClick={onBack}
          className="size-10 rounded-full bg-card border border-border grid place-items-center"
        >
          <ChevronLeft className="size-5" />
        </button>
        <div>
          <p className="text-xs text-muted-foreground font-bold uppercase tracking-wider">Step 2 of 3</p>
          <h1 className="text-xl font-extrabold">Enter Card Details</h1>
        </div>
      </header>

      {/* Progress dots */}
      <div className="px-5 flex items-center gap-2">
        <div className="h-1.5 flex-1 rounded-full bg-gradient-gold" />
        <div className="h-1.5 flex-1 rounded-full bg-gradient-gold" />
        <div className="h-1.5 flex-1 rounded-full bg-secondary" />
      </div>

      {/* Brand + amount summary */}
      <div className="px-5 mt-6">
        <div className="bg-card rounded-2xl border border-border p-4 flex items-center gap-4">
          <div className="size-14 rounded-2xl bg-secondary grid place-items-center overflow-hidden">
            {brandLogo ? (
              <img
                src={brandLogo}
                alt={brand}
                className="size-8 object-contain"
                onError={e => { e.currentTarget.style.display="none"; }}
              />
            ) : (
              <span className="text-3xl">{brandEmoji}</span>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold">{brand} Gift Card</p>
            <p className="text-xs text-muted-foreground">USA · ${amountUsd} each</p>
          </div>
          <div className="text-right">
            <p className="text-sm font-extrabold text-cyan">₦{estimatedNgn}</p>
            <p className="text-[10px] text-muted-foreground">per card</p>
          </div>
        </div>
      </div>

      {/* Multi-card banner */}
      {isBatch && (
        <div className="mx-5 mt-4 flex items-center gap-2 bg-gold/10 border border-gold/30 rounded-xl px-3 py-2.5">
          <Layers className="size-4 text-gold shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-extrabold text-gold">{cards.length} cards — risk distribution active</p>
            <p className="text-[10px] text-muted-foreground">Each card goes to a different vendor · No single vendor sees all codes</p>
          </div>
        </div>
      )}

      {/* Card entries */}
      <div className="px-5 mt-5 space-y-4">
        {cards.map((card, i) => (
          <div key={i} className="bg-card rounded-2xl border border-border overflow-hidden">
            {/* Card header */}
            <div className="flex items-center justify-between px-4 pt-3 pb-2">
              <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                <ScanLine className="size-3.5" />
                {cards.length > 1 ? `Card ${i + 1}` : "Card Code"}
              </p>
              {i > 0 && (
                <button
                  onClick={() => removeCard(i)}
                  className="size-5 grid place-items-center rounded-full bg-red-500/15 text-red-400 hover:bg-red-500/25 transition"
                >
                  <X className="size-3" />
                </button>
              )}
            </div>

            {/* Code input */}
            <div className="px-4 pb-2">
              <input
                type="text"
                placeholder="e.g. XXXX-XXXX-XXXX-XXXX"
                value={card.code}
                onChange={(e) => updateCard(i, "code", e.target.value)}
                className="bg-secondary rounded-xl px-3 py-2.5 text-sm font-mono font-bold w-full placeholder:text-muted-foreground/40 placeholder:font-sans tracking-wider outline-none focus:ring-1 focus:ring-gold/40"
                autoComplete="off"
                spellCheck={false}
              />
            </div>

            {/* PIN input */}
            <div className="px-4 pb-3">
              <div className="bg-secondary rounded-xl px-3 py-2.5 flex items-center gap-2">
                <input
                  type={card.showPin ? "text" : "password"}
                  placeholder="PIN (if required)"
                  value={card.pin}
                  onChange={(e) => updateCard(i, "pin", e.target.value)}
                  className="bg-transparent outline-none text-sm font-mono flex-1 placeholder:text-muted-foreground/40 placeholder:font-sans"
                  autoComplete="off"
                />
                <button onClick={() => togglePin(i)} className="text-muted-foreground shrink-0">
                  {card.showPin ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
            </div>

            {/* Image upload */}
            <div className="px-4 pb-4 space-y-2">
              {card.imagePreview ? (
                <div className="space-y-2">
                  <div className="relative rounded-xl overflow-hidden border border-border bg-secondary">
                    <img
                      src={card.imagePreview}
                      alt="Card photo"
                      className="w-full h-32 object-cover"
                    />
                    {card.imageUploading && (
                      <div className="absolute inset-0 bg-black/50 flex items-center justify-center gap-2">
                        <Loader2 className="size-5 text-white animate-spin" />
                        <span className="text-white text-xs font-bold">Uploading…</span>
                      </div>
                    )}
                    {card.ocrScanning && !card.imageUploading && (
                      <div className="absolute inset-0 bg-black/60 flex flex-col items-center justify-center gap-2">
                        <Sparkles className="size-5 text-gold animate-pulse" />
                        <span className="text-white text-xs font-bold">AI Scanning…</span>
                        <span className="text-white/60 text-[10px]">Extracting card details</span>
                      </div>
                    )}
                    {!card.imageUploading && !card.ocrScanning && (
                      <button
                        onClick={() => removeImage(i)}
                        className="absolute top-2 right-2 size-6 rounded-full bg-black/60 grid place-items-center text-white hover:bg-red-600/80 transition"
                      >
                        <X className="size-3.5" />
                      </button>
                    )}
                    {!card.imageUploading && !card.ocrScanning && card.imagePath && (
                      <div className="absolute bottom-2 left-2 bg-green-500/80 text-white text-[10px] font-bold px-2 py-0.5 rounded-full">
                        ✓ Uploaded
                      </div>
                    )}
                  </div>

                  {/* OCR Result Panel */}
                  {card.ocrResult && !card.ocrScanning && (
                    <div className={`rounded-xl border p-3 space-y-2 ${
                      card.ocrResult.riskScore === "high"
                        ? "border-red-500/30 bg-red-500/5"
                        : card.ocrResult.riskScore === "medium"
                        ? "border-amber-500/30 bg-amber-500/5"
                        : "border-green-500/30 bg-green-500/5"
                    }`}>
                      {/* Header */}
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5">
                          <Wand2 className="size-3.5 text-gold" />
                          <span className="text-[11px] font-extrabold text-gold">AI Scan Complete</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <RiskBadge score={card.ocrResult.riskScore} />
                          <span className="text-[10px] text-muted-foreground">{card.ocrResult.confidence}% confidence</span>
                        </div>
                      </div>

                      {/* Extracted values */}
                      <div className="space-y-1">
                        {card.ocrResult.brand && (
                          <p className="text-[11px] text-muted-foreground">
                            Brand detected: <span className="text-foreground font-semibold">{card.ocrResult.brand}</span>
                          </p>
                        )}
                        {card.ocrResult.denomination && (
                          <p className="text-[11px] text-muted-foreground">
                            Value: <span className="text-foreground font-semibold">{card.ocrResult.currency ?? "USD"} {card.ocrResult.denomination}</span>
                          </p>
                        )}
                        {card.ocrResult.code && card.code !== card.ocrResult.code && (
                          <button
                            onClick={() => applyOCR(i, card.ocrResult!)}
                            className="w-full flex items-center justify-center gap-1.5 text-xs font-bold text-gold border border-gold/30 rounded-lg py-1.5 bg-gold/5 hover:bg-gold/10 transition"
                          >
                            <CheckCircle2 className="size-3.5" />
                            Use extracted code: <code className="font-mono ml-1">{card.ocrResult.code}</code>
                          </button>
                        )}
                      </div>

                      {/* Fraud flags */}
                      {card.ocrResult.flags.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {card.ocrResult.flags.map(f => (
                            <span key={f} className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 uppercase tracking-wide">
                              {f}
                            </span>
                          ))}
                        </div>
                      )}

                      {/* High risk warning */}
                      {card.ocrResult.riskScore === "high" && (
                        <p className="text-[10px] text-red-400 font-semibold">
                          ⚠ This image was flagged for review. Edited or voided cards will be rejected.
                        </p>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => cameraRefs.current[i]?.click()}
                    className="flex-1 flex items-center justify-center gap-1.5 border border-dashed border-border/60 rounded-xl py-2.5 text-xs text-muted-foreground hover:border-gold/40 hover:text-gold transition"
                  >
                    <Camera className="size-3.5" />
                    <span>Camera</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => galleryRefs.current[i]?.click()}
                    className="flex-1 flex items-center justify-center gap-1.5 border border-dashed border-border/60 rounded-xl py-2.5 text-xs text-muted-foreground hover:border-gold/40 hover:text-gold transition"
                  >
                    <ImagePlus className="size-3.5" />
                    <span>Gallery</span>
                  </button>
                </div>
              )}

              {/* OCR tip when no image yet */}
              {!card.imagePreview && (
                <div className="flex items-start gap-2 bg-gold/5 border border-gold/20 rounded-xl px-3 py-2">
                  <Sparkles className="size-3.5 text-gold shrink-0 mt-0.5" />
                  <p className="text-[11px] text-muted-foreground leading-relaxed">
                    <span className="font-semibold text-gold">AI Auto-Fill:</span> Upload a photo and we'll automatically extract the card code, PIN, and denomination for you.
                  </p>
                </div>
              )}

              <input
                ref={(el) => { cameraRefs.current[i] = el; }}
                type="file"
                accept="image/*,image/heic,image/heif"
                capture="environment"
                className="sr-only"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleImageSelect(i, file);
                  e.target.value = "";
                }}
              />
              <input
                ref={(el) => { galleryRefs.current[i] = el; }}
                type="file"
                accept="image/*,image/heic,image/heif"
                className="sr-only"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleImageSelect(i, file);
                  e.target.value = "";
                }}
              />
            </div>
          </div>
        ))}
      </div>

      {/* Add card button */}
      {cards.length < 10 && (
        <div className="px-5 mt-3">
          <button
            onClick={addCard}
            className="w-full flex items-center justify-center gap-2 border border-dashed border-border rounded-2xl py-3 text-sm text-muted-foreground hover:border-gold/40 hover:text-gold transition"
          >
            <Plus className="size-4" /> Add Another Card
          </button>
          {cards.length === 1 && (
            <p className="text-center text-[10px] text-muted-foreground mt-1.5">
              Selling multiple? Add them here — each goes to a different vendor.
            </p>
          )}
        </div>
      )}

      {/* Error */}
      {error && (
        <p className="px-5 mt-3 text-sm text-pink font-semibold text-center">{error}</p>
      )}

      {/* CTA */}
      <div className="px-5 mt-6">
        <button
          onClick={handleContinue}
          className="w-full bg-gradient-gold text-jungle-deep font-extrabold py-4 rounded-2xl flex items-center justify-center gap-2 shadow-glow-gold active:scale-[0.99] transition"
        >
          {isBatch
            ? <><Layers className="size-5" /> Verify {cards.length} Cards</>
            : <>Verify Card <ChevronRight className="size-5" /></>
          }
        </button>
        <p className="text-center text-[11px] text-muted-foreground mt-3">
          {isBatch
            ? `${cards.length} cards · ₦${(Number(estimatedNgn.replace(/,/g, "")) * cards.length).toLocaleString()} total estimated`
            : "Your card details are encrypted and never stored"
          }
        </p>
      </div>
    </div>
  );
}
