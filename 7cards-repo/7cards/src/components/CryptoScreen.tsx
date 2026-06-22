// ─────────────────────────────────────────────────────────────────────────────
// CryptoScreen — Coming Soon
// ─────────────────────────────────────────────────────────────────────────────
import React from "react";
import { ChevronLeft, Bitcoin, Clock, Bell } from "lucide-react";

export function CryptoScreen({
  onBack,
}: {
  wallets: Array<{ currency: string; balance: number; locked_balance: number }>;
  onBack: () => void;
}) {
  return (
    <div className="flex flex-col min-h-screen">
      {/* Header */}
      <header className="px-5 pt-12 pb-5">
        <div className="flex items-center gap-3 mb-6">
          <button
            onClick={onBack}
            className="size-10 rounded-full bg-card border border-border grid place-items-center"
          >
            <ChevronLeft className="size-5" />
          </button>
          <div className="flex-1">
            <p className="text-xl font-extrabold">Crypto</p>
            <p className="text-xs text-muted-foreground">Portfolio & Markets</p>
          </div>
        </div>
      </header>

      {/* Coming Soon card */}
      <div className="flex-1 flex flex-col items-center justify-center px-6 pb-24 gap-6">
        <div className="rounded-3xl bg-gradient-to-br from-[#0f3d2e] via-[#0a2a1f] to-[#041a12] p-8 w-full text-center shadow-glow-jungle relative overflow-hidden border border-cyan/10">
          <div className="absolute -right-8 -top-8 size-40 rounded-full bg-cyan/10 blur-3xl pointer-events-none" />
          <div className="absolute -left-4 -bottom-4 size-28 rounded-full bg-gold/5 blur-2xl pointer-events-none" />

          <div className="relative flex flex-col items-center gap-5">
            <div className="size-20 rounded-3xl bg-white/10 border border-white/15 grid place-items-center">
              <Bitcoin className="size-10 text-cyan" />
            </div>

            <div>
              <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-gold/20 border border-gold/30 mb-4">
                <Clock className="size-3.5 text-gold" />
                <span className="text-xs font-bold text-gold uppercase tracking-wide">Coming Soon</span>
              </div>
              <h2 className="text-2xl font-extrabold text-white leading-tight">
                Crypto Trading<br />is on the way
              </h2>
              <p className="text-sm text-white/60 mt-3 leading-relaxed">
                Buy, sell, and swap Bitcoin, Ethereum, USDT and more — directly in 7SEVEN CARDS. We're putting the finishing touches on something great.
              </p>
            </div>

            <div className="w-full grid grid-cols-3 gap-2 mt-2">
              {[
                { label: "BTC", icon: "₿", color: "bg-orange-500/20 text-orange-400" },
                { label: "ETH", icon: "Ξ", color: "bg-indigo-500/20 text-indigo-400" },
                { label: "USDT", icon: "₮", color: "bg-emerald-500/20 text-emerald-400" },
              ].map((c) => (
                <div key={c.label} className={`rounded-2xl border border-white/10 p-3 flex flex-col items-center gap-1.5 ${c.color} opacity-60`}>
                  <span className="text-lg font-extrabold">{c.icon}</span>
                  <span className="text-[10px] font-bold">{c.label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="w-full flex flex-col gap-3">
          <div className="bg-card rounded-2xl border border-border p-4 flex items-center gap-3">
            <div className="size-10 rounded-xl bg-gold/15 grid place-items-center flex-shrink-0">
              <Bell className="size-5 text-gold" />
            </div>
            <div className="flex-1">
              <p className="text-sm font-bold">Get notified when it launches</p>
              <p className="text-xs text-muted-foreground">We'll let you know the moment crypto goes live</p>
            </div>
          </div>

          <button
            onClick={onBack}
            className="w-full bg-gradient-gold text-jungle-deep font-extrabold py-4 rounded-2xl shadow-glow-gold active:scale-[0.99] transition"
          >
            Back to Home
          </button>
        </div>
      </div>
    </div>
  );
}
