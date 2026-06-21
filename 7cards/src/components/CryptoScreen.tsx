// ─────────────────────────────────────────────────────────────────────────────
// CryptoScreen — live portfolio, market prices, send / receive / swap
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownLeft,
  ArrowUpRight,
  ChevronLeft,
  CheckCircle2,
  Copy,
  AlertCircle,
  Loader2,
  Send,
  RefreshCw,
  XCircle,
  TrendingUp,
  TrendingDown,
} from "lucide-react";
import { getCryptoDepositAddress, initiateCryptoSwap, initiateCryptoSend, getCryptoTransactions } from "../server-functions/crypto";
import type { CryptoTxRow } from "../server-functions/crypto";

// ─── Types ────────────────────────────────────────────────────────────────────
type WalletData = { currency: string; balance: number; locked_balance: number };

type CryptoRate = {
  symbol: string;   // "BTC-NGN"
  price: string;
  change: string;   // "+2.4%"
  bid: string;
  ask: string;
};

// ─── Constants ───────────────────────────────────────────────────────────────
const COINS = [
  { symbol: "BTC",  name: "Bitcoin",   icon: "₿", color: "bg-orange-500 text-white",    gradient: "from-orange-500 to-amber-600" },
  { symbol: "ETH",  name: "Ethereum",  icon: "Ξ", color: "bg-indigo-500 text-white",    gradient: "from-indigo-500 to-violet-600" },
  { symbol: "USDT", name: "Tether",    icon: "₮", color: "bg-emerald-500 text-white",   gradient: "from-emerald-500 to-teal-600" },
  { symbol: "USDC", name: "USD Coin",  icon: "$", color: "bg-blue-500 text-white",      gradient: "from-blue-500 to-sky-600" },
  { symbol: "BNB",  name: "BNB",       icon: "B", color: "bg-yellow-500 text-white",    gradient: "from-yellow-400 to-orange-500" },
  { symbol: "SOL",  name: "Solana",    icon: "◎", color: "bg-purple-500 text-white",    gradient: "from-purple-500 to-fuchsia-600" },
] as const;

type CoinSymbol = typeof COINS[number]["symbol"];

function coinMeta(sym: string) {
  return COINS.find(c => c.symbol === sym) ?? { symbol: sym, name: sym, icon: sym[0], color: "bg-secondary text-foreground", gradient: "from-secondary to-secondary" };
}

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function formatNgn(n: number) {
  if (n >= 1_000_000) return `₦${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `₦${(n / 1_000).toFixed(1)}K`;
  return `₦${n.toLocaleString()}`;
}

function changeColor(change: string) {
  if (!change) return "text-muted-foreground";
  return change.startsWith("+") ? "text-emerald-400" : "text-pink-400";
}

// ─── Main screen ──────────────────────────────────────────────────────────────
export function CryptoScreen({
  wallets,
  onBack,
}: {
  wallets: WalletData[];
  onBack: () => void;
}) {
  const [activeTab, setActiveTab] = useState<"market" | "holdings" | "history">("market");
  const [modal, setModal]         = useState<null | "receive" | "send" | "swap">(null);

  // Live rates — refresh every 30 s
  const { data: rates = [], isFetching: ratesFetching, refetch: refetchRates } = useQuery({
    queryKey: ["crypto-rates"],
    queryFn: async () => {
      const { getCryptoExchangeRates } = await import("../server-functions/rates");
      return getCryptoExchangeRates() as Promise<CryptoRate[]>;
    },
    staleTime: 30_000,
    refetchInterval: 30_000,
  });

  // Crypto tx history
  const { data: txs = [] } = useQuery<CryptoTxRow[]>({
    queryKey: ["crypto-txs"],
    queryFn: () => getCryptoTransactions({ data: { limit: 30 } }),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const getRate = (sym: string) => {
    const r = rates.find(r => r.symbol === `${sym}-NGN`);
    return r ? parseFloat(r.price) : 0;
  };

  const cryptoWallets = wallets.filter(w => w.currency !== "NGN" && Number(w.balance) > 0);

  const totalCryptoNgn = cryptoWallets.reduce((sum, w) => {
    return sum + Number(w.balance) * getRate(w.currency);
  }, 0);

  return (
    <div className="flex flex-col min-h-screen">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
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
          <button
            onClick={() => refetchRates()}
            className="size-10 rounded-full bg-card border border-border grid place-items-center"
            aria-label="Refresh rates"
          >
            <RefreshCw className={`size-4 ${ratesFetching ? "animate-spin text-cyan" : "text-muted-foreground"}`} />
          </button>
        </div>

        {/* Portfolio card */}
        <div className="rounded-3xl bg-gradient-to-br from-[#0f3d2e] via-[#0a2a1f] to-[#041a12] p-6 shadow-glow-jungle relative overflow-hidden border border-cyan/10">
          <div className="absolute -right-8 -top-8 size-40 rounded-full bg-cyan/10 blur-3xl pointer-events-none" />
          <div className="absolute -left-4 -bottom-4 size-28 rounded-full bg-gold/5 blur-2xl pointer-events-none" />

          <p className="text-xs text-white/50 font-semibold uppercase tracking-widest">Crypto Portfolio</p>
          <h2 className="text-4xl font-extrabold text-white mt-1 tracking-tight">
            {totalCryptoNgn > 0 ? formatNgn(totalCryptoNgn) : "—"}
          </h2>
          {cryptoWallets.length === 0 && (
            <p className="text-xs text-white/40 mt-1">No crypto holdings yet — receive or swap to get started</p>
          )}

          {/* Quick actions */}
          <div className="mt-5 grid grid-cols-3 gap-3">
            {[
              { label: "Receive", icon: ArrowDownLeft, action: "receive" as const },
              { label: "Send",    icon: ArrowUpRight,  action: "send"    as const },
              { label: "Swap",    icon: RefreshCw,     action: "swap"    as const },
            ].map(({ label, icon: Icon, action }) => (
              <button
                key={label}
                onClick={() => setModal(action)}
                className="flex flex-col items-center gap-1.5"
              >
                <div className="size-12 rounded-full bg-white/10 backdrop-blur grid place-items-center border border-white/15 active:scale-95 transition">
                  <Icon className="size-5 text-white" />
                </div>
                <span className="text-[11px] text-white/70 font-semibold">{label}</span>
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* ── Tab bar ────────────────────────────────────────────────────────── */}
      <div className="px-5">
        <div className="flex gap-1 bg-card p-1 rounded-2xl border border-border">
          {(["market", "holdings", "history"] as const).map(t => (
            <button
              key={t}
              onClick={() => setActiveTab(t)}
              className={`flex-1 py-2 rounded-xl text-xs font-bold capitalize transition ${
                activeTab === t ? "bg-gold text-jungle-deep" : "text-muted-foreground"
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {/* ── Market tab ─────────────────────────────────────────────────────── */}
      {activeTab === "market" && (
        <div className="px-5 mt-4 space-y-2 pb-8">
          {COINS.map(coin => {
            const rate = rates.find(r => r.symbol === `${coin.symbol}-NGN`);
            const price = rate ? parseFloat(rate.price) : 0;
            const change = rate?.change ?? "";
            const up = change.startsWith("+");

            return (
              <div
                key={coin.symbol}
                className="bg-card rounded-2xl border border-border/60 p-4 flex items-center gap-3"
              >
                <div className={`size-11 rounded-2xl grid place-items-center font-extrabold text-lg shrink-0 ${coin.color}`}>
                  {coin.icon}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold">{coin.name}</p>
                  <p className="text-[11px] text-muted-foreground">{coin.symbol}</p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-sm font-extrabold">
                    {price > 0 ? formatNgn(price) : "—"}
                  </p>
                  {change ? (
                    <p className={`text-[11px] font-bold flex items-center justify-end gap-0.5 ${changeColor(change)}`}>
                      {up ? <TrendingUp className="size-3" /> : <TrendingDown className="size-3" />}
                      {change}
                    </p>
                  ) : (
                    <p className="text-[11px] text-muted-foreground">—</p>
                  )}
                </div>
              </div>
            );
          })}
          {rates.length === 0 && !ratesFetching && (
            <div className="text-center py-8 text-sm text-muted-foreground">
              <p>Could not load live rates</p>
              <button onClick={() => refetchRates()} className="mt-2 text-gold font-semibold text-xs">Retry</button>
            </div>
          )}
          {rates.length === 0 && ratesFetching && (
            <div className="flex items-center justify-center py-12 gap-2 text-muted-foreground text-sm">
              <Loader2 className="size-4 animate-spin" /> Loading rates…
            </div>
          )}
          <p className="text-center text-[10px] text-muted-foreground pt-2">
            Rates update every 30 seconds · includes 7% service margin
          </p>
        </div>
      )}

      {/* ── Holdings tab ───────────────────────────────────────────────────── */}
      {activeTab === "holdings" && (
        <div className="px-5 mt-4 space-y-2 pb-8">
          {cryptoWallets.length === 0 ? (
            <div className="text-center py-12 space-y-3">
              <p className="text-3xl">🪙</p>
              <p className="text-sm font-semibold">No crypto yet</p>
              <p className="text-xs text-muted-foreground">Receive crypto or swap NGN to get started</p>
              <button
                onClick={() => setModal("receive")}
                className="mt-2 px-5 py-2.5 bg-gold text-jungle-deep font-bold rounded-2xl text-sm"
              >
                Receive Crypto
              </button>
            </div>
          ) : (
            cryptoWallets.map(w => {
              const meta  = coinMeta(w.currency);
              const price = getRate(w.currency);
              const ngnVal = Number(w.balance) * price;
              const rate  = rates.find(r => r.symbol === `${w.currency}-NGN`);
              const change = rate?.change ?? "";

              return (
                <div key={w.currency} className="bg-card rounded-2xl border border-border/60 p-4 flex items-center gap-3">
                  <div className={`size-11 rounded-2xl grid place-items-center font-extrabold text-lg shrink-0 ${meta.color}`}>
                    {meta.icon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold">{meta.name}</p>
                    <p className="text-[11px] text-muted-foreground">{Number(w.balance).toFixed(6)} {w.currency}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-sm font-extrabold">{ngnVal > 0 ? formatNgn(ngnVal) : "—"}</p>
                    {change && (
                      <p className={`text-[11px] font-bold ${changeColor(change)}`}>{change}</p>
                    )}
                  </div>
                </div>
              );
            })
          )}

          {/* All wallets (including zero balances) */}
          {cryptoWallets.length > 0 && (
            <div className="mt-4">
              <p className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wide">Other wallets</p>
              {COINS.filter(c => !cryptoWallets.find(w => w.currency === c.symbol)).map(coin => (
                <div key={coin.symbol} className="bg-card/50 rounded-2xl border border-border/40 p-3 flex items-center gap-3 mb-2 opacity-60">
                  <div className={`size-9 rounded-xl grid place-items-center font-extrabold text-sm shrink-0 ${coin.color}`}>
                    {coin.icon}
                  </div>
                  <div className="flex-1">
                    <p className="text-xs font-bold">{coin.symbol}</p>
                  </div>
                  <p className="text-xs text-muted-foreground">0.000000</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── History tab ────────────────────────────────────────────────────── */}
      {activeTab === "history" && (
        <div className="px-5 mt-4 pb-8">
          {txs.length === 0 ? (
            <div className="text-center py-12 space-y-2">
              <p className="text-3xl">📋</p>
              <p className="text-sm font-semibold">No crypto transactions yet</p>
              <p className="text-xs text-muted-foreground">Your swaps, sends and receives will appear here</p>
            </div>
          ) : (
            <div className="space-y-2">
              {txs.map(tx => {
                const meta = coinMeta(tx.from_currency ?? tx.to_currency ?? "");
                const typeLabel =
                  tx.type === "swap"    ? `${tx.from_currency} → ${tx.to_currency}` :
                  tx.type === "send"    ? `Sent ${tx.from_currency}` :
                  tx.type === "receive" ? `Received ${tx.to_currency}` :
                  tx.type;
                const amtLabel =
                  tx.type === "swap"
                    ? `${Number(tx.from_amount).toFixed(4)} → ${Number(tx.to_amount).toFixed(4)} ${tx.to_currency}`
                    : `${Number(tx.from_amount ?? tx.to_amount).toFixed(6)} ${tx.from_currency ?? tx.to_currency}`;

                return (
                  <div key={tx.id} className="bg-card rounded-2xl border border-border/60 p-4 flex items-center gap-3">
                    <div className={`size-10 rounded-xl grid place-items-center font-extrabold text-sm shrink-0 ${meta.color}`}>
                      {tx.type === "swap" ? "⇄" : tx.type === "send" ? "↑" : "↓"}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-bold capitalize">{typeLabel}</p>
                      <p className="text-[11px] text-muted-foreground">{timeAgo(tx.created_at)}</p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-xs font-bold">{amtLabel}</p>
                      <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${
                        tx.status === "completed" ? "bg-cyan/10 text-cyan" :
                        tx.status === "failed"    ? "bg-pink/10 text-pink" :
                        "bg-gold/10 text-gold"
                      }`}>
                        {tx.status}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Modals ─────────────────────────────────────────────────────────── */}
      {modal === "receive" && (
        <CryptoReceiveModal wallets={wallets} onClose={() => setModal(null)} />
      )}
      {modal === "send" && (
        <CryptoSendModal wallets={wallets} onClose={() => setModal(null)} />
      )}
      {modal === "swap" && (
        <CryptoSwapModal wallets={wallets} rates={rates} onClose={() => setModal(null)} />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Receive Modal
// ─────────────────────────────────────────────────────────────────────────────
function CryptoReceiveModal({ wallets, onClose }: { wallets: WalletData[]; onClose: () => void }) {
  const [selected, setSelected] = useState<CoinSymbol>("BTC");
  const [copied,   setCopied]   = useState(false);

  const { data: addrData, isLoading } = useQuery({
    queryKey: ["deposit-address", selected],
    queryFn: () => getCryptoDepositAddress({ data: { currency: selected } }),
    staleTime: 10 * 60 * 1000,
  });

  const address = addrData?.address ?? "";
  const network = addrData?.network ?? selected;
  const isDemo  = addrData?.demo;
  const wallet  = wallets.find(w => w.currency === selected);

  const handleCopy = () => {
    if (!address) return;
    navigator.clipboard?.writeText(address).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 bg-background flex flex-col max-w-[480px] mx-auto">
      <header className="px-5 pt-12 pb-4 flex items-center gap-3 shrink-0">
        <button onClick={onClose} className="size-10 rounded-full bg-card border border-border grid place-items-center">
          <ChevronLeft className="size-5" />
        </button>
        <div>
          <p className="text-lg font-extrabold">Receive Crypto</p>
          <p className="text-xs text-muted-foreground">Send crypto to your 7SEVEN wallet</p>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-5 pb-8 space-y-4">
        {/* Currency picker */}
        <div>
          <p className="text-xs font-bold text-muted-foreground mb-2 uppercase tracking-wide">Select currency</p>
          <div className="grid grid-cols-4 gap-2">
            {COINS.slice(0, 4).map(coin => (
              <button key={coin.symbol} onClick={() => setSelected(coin.symbol as CoinSymbol)}
                className={`flex flex-col items-center gap-1.5 p-3 rounded-2xl border-2 transition ${
                  selected === coin.symbol ? "border-gold bg-gold/10" : "border-border bg-card"
                }`}>
                <div className={`size-9 rounded-xl grid place-items-center font-extrabold text-base ${coin.color}`}>{coin.icon}</div>
                <span className="text-[10px] font-bold">{coin.symbol}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Current balance */}
        {wallet && (
          <div className="bg-card rounded-2xl p-3 border border-border flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Current balance</span>
            <span className="text-sm font-bold">{Number(wallet.balance).toFixed(6)} {selected}</span>
          </div>
        )}

        {/* Address display */}
        <div className="bg-card rounded-3xl border border-border p-5 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-extrabold">Your {selected} Address</p>
            <span className="text-[10px] bg-secondary px-2 py-0.5 rounded-full text-muted-foreground font-semibold">{network}</span>
          </div>
          {isLoading ? (
            <div className="h-10 bg-secondary rounded-xl animate-pulse" />
          ) : address ? (
            <div className="bg-secondary rounded-2xl p-3 flex items-center gap-2">
              <p className="text-xs font-mono flex-1 break-all text-foreground leading-relaxed">{address}</p>
              <button onClick={handleCopy}
                className={`size-9 rounded-xl grid place-items-center shrink-0 transition ${copied ? "bg-cyan/20 text-cyan" : "bg-card text-muted-foreground"}`}>
                {copied ? <CheckCircle2 className="size-4" /> : <Copy className="size-4" />}
              </button>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Address unavailable</p>
          )}
          {isDemo && (
            <div className="flex items-start gap-2 p-3 rounded-xl bg-gold/10 border border-gold/30">
              <AlertCircle className="size-4 text-gold shrink-0 mt-0.5" />
              <p className="text-[11px] text-muted-foreground">Demo address shown — connect a Busha API key for your real deposit address.</p>
            </div>
          )}
          <p className="text-[11px] text-muted-foreground">Only send {selected} on the {network} network. Wrong network = permanent loss.</p>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Send Modal
// ─────────────────────────────────────────────────────────────────────────────
function CryptoSendModal({ wallets, onClose }: { wallets: WalletData[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<CoinSymbol>("BTC");
  const [amount,   setAmount]   = useState("");
  const [address,  setAddress]  = useState("");
  const [loading,  setLoading]  = useState(false);
  const [result,   setResult]   = useState<null | { ok: boolean; msg: string }>(null);

  const wallet       = wallets.find(w => w.currency === selected);
  const balance      = Number(wallet?.balance ?? 0);
  const parsedAmount = parseFloat(amount) || 0;

  const handleSend = async () => {
    if (!parsedAmount || !address.trim() || parsedAmount > balance) return;
    setLoading(true); setResult(null);
    try {
      const res = await initiateCryptoSend({ data: { currency: selected, amount: parsedAmount, address: address.trim() } });
      if ((res as { success: boolean }).success) {
        qc.invalidateQueries({ queryKey: ["wallets"] });
        qc.invalidateQueries({ queryKey: ["crypto-txs"] });
        setResult({ ok: true, msg: `${parsedAmount} ${selected} sent successfully${(res as { demo?: boolean }).demo ? " (demo)" : ""}` });
        setAmount(""); setAddress("");
      } else {
        const r = (res as { reason?: string }).reason ?? "Send failed";
        setResult({ ok: false, msg: r === "INSUFFICIENT_BALANCE" ? "Insufficient balance" : r });
      }
    } catch (e) {
      setResult({ ok: false, msg: "Send failed — please try again" });
    } finally { setLoading(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-background flex flex-col max-w-[480px] mx-auto">
      <header className="px-5 pt-12 pb-4 flex items-center gap-3 shrink-0">
        <button onClick={onClose} className="size-10 rounded-full bg-card border border-border grid place-items-center">
          <ChevronLeft className="size-5" />
        </button>
        <div>
          <p className="text-lg font-extrabold">Send Crypto</p>
          <p className="text-xs text-muted-foreground">Withdraw to an external wallet</p>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-5 pb-8 space-y-4">
        {/* Currency picker */}
        <div className="grid grid-cols-4 gap-2">
          {COINS.slice(0, 4).map(coin => {
            const w = wallets.find(x => x.currency === coin.symbol);
            return (
              <button key={coin.symbol} onClick={() => setSelected(coin.symbol as CoinSymbol)}
                className={`flex flex-col items-center gap-1 p-2.5 rounded-2xl border-2 transition ${
                  selected === coin.symbol ? "border-gold bg-gold/10" : "border-border bg-card"
                }`}>
                <div className={`size-8 rounded-xl grid place-items-center font-extrabold text-sm ${coin.color}`}>{coin.icon}</div>
                <span className="text-[9px] font-bold">{coin.symbol}</span>
                <span className="text-[9px] text-muted-foreground">{Number(w?.balance ?? 0).toFixed(4)}</span>
              </button>
            );
          })}
        </div>

        {/* Amount */}
        <div className="bg-card rounded-2xl border border-border p-4 space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs font-bold text-muted-foreground">Amount</p>
            <button onClick={() => setAmount(String(balance))} className="text-[11px] text-gold font-bold">
              Max: {balance.toFixed(6)} {selected}
            </button>
          </div>
          <div className="flex items-center gap-2 bg-secondary rounded-xl px-4 py-3">
            <input
              type="number"
              placeholder="0.00"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              className="flex-1 bg-transparent text-lg font-extrabold outline-none"
            />
            <span className="text-sm font-bold text-muted-foreground">{selected}</span>
          </div>
          {parsedAmount > balance && (
            <p className="text-[11px] text-pink-400 font-semibold">Exceeds available balance</p>
          )}
        </div>

        {/* Address */}
        <div className="bg-card rounded-2xl border border-border p-4 space-y-2">
          <p className="text-xs font-bold text-muted-foreground">Recipient Address</p>
          <textarea
            placeholder="Paste wallet address here…"
            value={address}
            onChange={e => setAddress(e.target.value)}
            rows={2}
            className="w-full bg-secondary rounded-xl px-4 py-3 text-sm font-mono outline-none resize-none"
          />
        </div>

        {result && (
          <div className={`flex items-start gap-2 p-3 rounded-xl border ${result.ok ? "bg-cyan/10 border-cyan/30 text-cyan" : "bg-pink-500/10 border-pink-500/30 text-pink-400"}`}>
            {result.ok ? <CheckCircle2 className="size-4 shrink-0 mt-0.5" /> : <XCircle className="size-4 shrink-0 mt-0.5" />}
            <p className="text-xs font-semibold">{result.msg}</p>
          </div>
        )}

        <button
          onClick={handleSend}
          disabled={loading || !parsedAmount || parsedAmount > balance || !address.trim()}
          className="w-full bg-gradient-gold text-jungle-deep font-extrabold py-4 rounded-2xl flex items-center justify-center gap-2 disabled:opacity-40 active:scale-[0.98] transition"
        >
          {loading ? <Loader2 className="size-5 animate-spin" /> : <><Send className="size-5" /> Send {selected}</>}
        </button>
        <p className="text-[11px] text-center text-muted-foreground">
          Always verify the address. Crypto transactions are irreversible.
        </p>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Swap Modal
// ─────────────────────────────────────────────────────────────────────────────
function CryptoSwapModal({ wallets, rates, onClose }: {
  wallets: WalletData[];
  rates: CryptoRate[];
  onClose: () => void;
}) {
  const qc  = useQueryClient();
  const [from,    setFrom]    = useState("BTC");
  const [to,      setTo]      = useState("USDT");
  const [amount,  setAmount]  = useState("");
  const [loading, setLoading] = useState(false);
  const [result,  setResult]  = useState<null | { ok: boolean; msg: string }>(null);

  const fromWallet   = wallets.find(w => w.currency === from);
  const balance      = Number(fromWallet?.balance ?? 0);
  const parsedAmount = parseFloat(amount) || 0;

  const getPrice = (sym: string) => {
    if (sym === "NGN") return 1;
    const r = rates.find(x => x.symbol === `${sym}-NGN`);
    return r ? parseFloat(r.price) : 0;
  };

  const previewAmount = (() => {
    const fromP = getPrice(from); const toP = getPrice(to);
    if (!parsedAmount || fromP === 0 || toP === 0) return null;
    return (parsedAmount * fromP) / toP * 0.93; // ~7% margin preview
  })();

  const allSymbols = [...COINS.map(c => c.symbol), "NGN"] as string[];

  const handleSwap = async () => {
    if (!parsedAmount || parsedAmount > balance || from === to) return;
    setLoading(true); setResult(null);
    try {
      const res = await initiateCryptoSwap({ data: { fromCurrency: from, toCurrency: to, amount: parsedAmount } });
      if ((res as { success: boolean }).success) {
        qc.invalidateQueries({ queryKey: ["wallets"] });
        qc.invalidateQueries({ queryKey: ["crypto-txs"] });
        const got = ((res as { toAmount?: number }).toAmount ?? 0).toFixed(6);
        setResult({ ok: true, msg: `Swapped ${parsedAmount} ${from} → ${got} ${to}${(res as { demo?: boolean }).demo ? " (demo)" : ""}` });
        setAmount("");
      } else {
        const r = (res as { reason?: string }).reason ?? "Swap failed";
        setResult({ ok: false, msg: r === "INSUFFICIENT_BALANCE" ? "Insufficient balance" : r });
      }
    } catch { setResult({ ok: false, msg: "Swap failed — try again" }); }
    finally { setLoading(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-background flex flex-col max-w-[480px] mx-auto">
      <header className="px-5 pt-12 pb-4 flex items-center gap-3 shrink-0">
        <button onClick={onClose} className="size-10 rounded-full bg-card border border-border grid place-items-center">
          <ChevronLeft className="size-5" />
        </button>
        <div>
          <p className="text-lg font-extrabold">Swap</p>
          <p className="text-xs text-muted-foreground">Exchange currencies instantly</p>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-5 pb-8 space-y-4">
        {/* From */}
        <div>
          <p className="text-xs font-bold text-muted-foreground mb-2 uppercase tracking-wide">From</p>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {allSymbols.filter(s => s !== to).map(sym => {
              const w = wallets.find(x => x.currency === sym);
              return (
                <button key={sym} onClick={() => setFrom(sym)}
                  className={`flex flex-col items-center gap-1 px-3 py-2 rounded-2xl border-2 shrink-0 transition ${from === sym ? "border-gold bg-gold/10" : "border-border bg-card"}`}>
                  <span className="text-xs font-bold">{sym}</span>
                  <span className="text-[9px] text-muted-foreground">{Number(w?.balance ?? 0).toFixed(4)}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* To */}
        <div>
          <p className="text-xs font-bold text-muted-foreground mb-2 uppercase tracking-wide">To</p>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {allSymbols.filter(s => s !== from).map(sym => (
              <button key={sym} onClick={() => setTo(sym)}
                className={`flex flex-col items-center gap-1 px-3 py-2 rounded-2xl border-2 shrink-0 transition ${to === sym ? "border-cyan bg-cyan/10" : "border-border bg-card"}`}>
                <span className="text-xs font-bold">{sym}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Amount */}
        <div className="bg-card rounded-2xl border border-border p-4 space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs font-bold text-muted-foreground">Amount ({from})</p>
            <button onClick={() => setAmount(String(balance))} className="text-[11px] text-gold font-bold">
              Max: {balance.toFixed(6)}
            </button>
          </div>
          <div className="flex items-center gap-2 bg-secondary rounded-xl px-4 py-3">
            <input
              type="number"
              placeholder="0.00"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              className="flex-1 bg-transparent text-lg font-extrabold outline-none"
            />
            <span className="text-sm font-bold text-muted-foreground">{from}</span>
          </div>
          {parsedAmount > balance && <p className="text-[11px] text-pink-400 font-semibold">Exceeds available balance</p>}
        </div>

        {/* Preview */}
        {previewAmount !== null && (
          <div className="bg-cyan/10 border border-cyan/20 rounded-2xl p-4 flex items-center justify-between">
            <span className="text-xs text-muted-foreground">You receive approx.</span>
            <span className="text-sm font-extrabold text-cyan">{previewAmount.toFixed(6)} {to}</span>
          </div>
        )}

        {result && (
          <div className={`flex items-start gap-2 p-3 rounded-xl border ${result.ok ? "bg-cyan/10 border-cyan/30 text-cyan" : "bg-pink-500/10 border-pink-500/30 text-pink-400"}`}>
            {result.ok ? <CheckCircle2 className="size-4 shrink-0 mt-0.5" /> : <XCircle className="size-4 shrink-0 mt-0.5" />}
            <p className="text-xs font-semibold">{result.msg}</p>
          </div>
        )}

        <button
          onClick={handleSwap}
          disabled={loading || !parsedAmount || parsedAmount > balance || from === to}
          className="w-full bg-gradient-to-r from-gold to-amber-500 text-jungle-deep font-extrabold py-4 rounded-2xl flex items-center justify-center gap-2 disabled:opacity-40 active:scale-[0.98] transition"
        >
          {loading ? <Loader2 className="size-5 animate-spin" /> : `Swap ${from} → ${to}`}
        </button>
        <p className="text-[11px] text-center text-muted-foreground">
          Rates include a 7% service margin. Swaps are immediate and final.
        </p>
      </div>
    </div>
  );
}
