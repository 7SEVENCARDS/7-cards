import { useState } from "react";
import { ChevronLeft, ChevronRight, Eye, EyeOff, ScanLine } from "lucide-react";

interface CodeEntryScreenProps {
  brand: string;
  amountUsd: string;
  estimatedNgn: string;
  onBack: () => void;
  onContinue: (code: string, pin?: string) => void;
}

export function CodeEntryScreen({
  brand,
  amountUsd,
  estimatedNgn,
  onBack,
  onContinue,
}: CodeEntryScreenProps) {
  const [cardCode, setCardCode] = useState("");
  const [cardPin, setCardPin] = useState("");
  const [showPin, setShowPin] = useState(false);
  const [error, setError] = useState("");

  const BRAND_EMOJI: Record<string, string> = {
    Apple: "🍎", Amazon: "📦", Steam: "🎮", "Google Play": "▶️",
    Xbox: "🟢", PlayStation: "🎯", Netflix: "🎬", Spotify: "🎵",
  };

  const handleContinue = () => {
    if (!cardCode.trim()) {
      setError("Enter your card code");
      return;
    }
    if (cardCode.trim().length < 8) {
      setError("Card code looks too short");
      return;
    }
    setError("");
    onContinue(cardCode.trim(), cardPin.trim() || undefined);
  };

  return (
    <div className="flex flex-col">
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
          <div className="size-14 rounded-2xl bg-secondary grid place-items-center text-3xl">
            {BRAND_EMOJI[brand] ?? "🎁"}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold">{brand} Gift Card</p>
            <p className="text-xs text-muted-foreground">USA · ${amountUsd}</p>
          </div>
          <div className="text-right">
            <p className="text-sm font-extrabold text-cyan">₦{estimatedNgn}</p>
            <p className="text-[10px] text-muted-foreground">You receive</p>
          </div>
        </div>
      </div>

      {/* Card code input */}
      <div className="px-5 mt-6">
        <h3 className="text-sm font-bold mb-2 flex items-center gap-2">
          <ScanLine className="size-4 text-cyan" /> Card Code / Redemption Code
        </h3>
        <div className="bg-card rounded-2xl border border-border p-4">
          <input
            type="text"
            placeholder="e.g. XXXX-XXXX-XXXX-XXXX"
            value={cardCode}
            onChange={(e) => setCardCode(e.target.value.toUpperCase())}
            className="bg-transparent outline-none text-base font-mono font-bold w-full placeholder:text-muted-foreground/40 placeholder:font-sans tracking-wider"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <p className="text-[11px] text-muted-foreground mt-2 px-1">
          Find this on the back of the card or in your email receipt.
        </p>
      </div>

      {/* PIN input (optional) */}
      <div className="px-5 mt-5">
        <h3 className="text-sm font-bold mb-2">PIN (if required)</h3>
        <div className="bg-card rounded-2xl border border-border p-4 flex items-center gap-3">
          <input
            type={showPin ? "text" : "password"}
            placeholder="Card PIN (optional)"
            value={cardPin}
            onChange={(e) => setCardPin(e.target.value)}
            className="bg-transparent outline-none text-base font-mono font-bold flex-1 placeholder:text-muted-foreground/40 placeholder:font-sans"
            autoComplete="off"
          />
          <button
            onClick={() => setShowPin((v) => !v)}
            className="text-muted-foreground"
          >
            {showPin ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </div>
        <p className="text-[11px] text-muted-foreground mt-2 px-1">
          Some gift cards require a separate PIN to redeem.
        </p>
      </div>

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
          Verify Card <ChevronRight className="size-5" />
        </button>
        <p className="text-center text-[11px] text-muted-foreground mt-3">
          Your card details are encrypted and never stored
        </p>
      </div>
    </div>
  );
}
