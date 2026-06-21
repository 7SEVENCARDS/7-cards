import { useState } from "react";
import { ChevronLeft, ChevronRight, Eye, EyeOff, ScanLine, Plus, X, Layers } from "lucide-react";

type CardEntry = { code: string; pin: string; showPin: boolean };

interface CodeEntryScreenProps {
  brand:        string;
  amountUsd:    string;
  estimatedNgn: string;
  onBack:       () => void;
  onContinue:      (code: string, pin?: string) => void;
  onContinueBatch?: (cards: Array<{ cardCode: string; cardPin?: string }>) => void;
}

export function CodeEntryScreen({
  brand,
  amountUsd,
  estimatedNgn,
  onBack,
  onContinue,
  onContinueBatch,
}: CodeEntryScreenProps) {
  const [cards, setCards] = useState<CardEntry[]>([{ code: "", pin: "", showPin: false }]);
  const [error, setError] = useState("");

  const BRAND_EMOJI: Record<string, string> = {
    Apple: "🍎", Amazon: "📦", Steam: "🎮", "Google Play": "▶️",
    Xbox: "🟢", PlayStation: "🎯", Netflix: "🎬", Spotify: "🎵",
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

  // ── Submit ─────────────────────────────────────────────────────────────────
  const handleContinue = () => {
    // Validate all cards
    for (let i = 0; i < cards.length; i++) {
      const c = cards[i];
      const label = cards.length > 1 ? `Card ${i + 1}` : "Card";
      if (!c.code.trim()) { setError(`${label}: enter the card code`); return; }
      if (c.code.trim().length < 8) { setError(`${label}: code looks too short`); return; }
    }
    setError("");

    if (cards.length === 1) {
      onContinue(cards[0].code.trim(), cards[0].pin.trim() || undefined);
    } else {
      onContinueBatch?.(cards.map(c => ({
        cardCode: c.code.trim(),
        cardPin:  c.pin.trim() || undefined,
      })));
    }
  };

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
          <div className="size-14 rounded-2xl bg-secondary grid place-items-center text-3xl">
            {BRAND_EMOJI[brand] ?? "🎁"}
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
            <div className="px-4 pb-4">
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
