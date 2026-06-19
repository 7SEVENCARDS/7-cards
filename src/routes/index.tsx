import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Bell,
  Bitcoin,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Copy,
  Crown,
  Eye,
  EyeOff,
  Flame,
  Gamepad2,
  Gift,
  Home,
  Loader2,
  Plus,
  RefreshCw,
  ScanLine,
  Send,
  ShieldCheck,
  Sparkles,
  Trophy,
  User,
  Wallet,
  XCircle,
  Zap,
} from "lucide-react";
import logoBadge from "../assets/logo-badge.png.asset.json";
import logoFull from "../assets/logo-full.png.asset.json";

export const Route = createFileRoute("/")({
  component: App,
});

type Tab = "home" | "sell" | "verify" | "league" | "wallet" | "profile";

function App() {
  const [tab, setTab] = useState<Tab>("home");

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex min-h-screen max-w-[480px] flex-col bg-background pb-24 relative">
        {tab === "home" && <HomeScreen onSell={() => setTab("sell")} />}
        {tab === "sell" && <SellScreen onVerify={() => setTab("verify")} />}
        {tab === "verify" && <VerifyScreen onBack={() => setTab("sell")} onDone={() => setTab("wallet")} />}
        {tab === "league" && <LeagueScreen />}
        {tab === "wallet" && <WalletScreen />}
        {tab === "profile" && <ProfileScreen />}

        <BottomNav tab={tab} setTab={setTab} />
      </div>
    </div>
  );
}

/* ---------------------------------- HOME ---------------------------------- */

function HomeScreen({ onSell }: { onSell: () => void }) {
  const [hideBalance, setHideBalance] = useState(false);

  return (
    <div className="flex flex-col">
      {/* Header */}
      <header className="bg-gradient-hero px-5 pt-12 pb-8 rounded-b-[2rem] shadow-glow-jungle relative overflow-hidden">
        <div className="absolute -right-10 -top-10 size-40 rounded-full bg-gold/10 blur-2xl" />
        <div className="absolute right-20 top-32 size-24 rounded-full bg-pink/20 blur-2xl" />

        <div className="flex items-center justify-between relative">
          <div className="flex items-center gap-3">
            <div className="size-11 rounded-2xl bg-jungle-deep grid place-items-center overflow-hidden ring-1 ring-gold/40 shadow-glow-gold">
              <img src={logoBadge.url} alt="7SEVEN" className="size-11 object-cover" />
            </div>
            <div>
              <p className="text-xs text-white/60 font-medium">Welcome back</p>
              <p className="text-sm font-semibold text-white">Tunde A. 👋</p>
            </div>
          </div>
          <button className="size-10 rounded-full bg-white/10 grid place-items-center backdrop-blur relative">
            <Bell className="size-5 text-white" />
            <span className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-pink ring-2 ring-jungle-deep" />
          </button>
        </div>

        {/* Balance card */}
        <div className="mt-7 relative">
          <p className="text-xs text-white/60 font-medium flex items-center gap-2">
            Available Balance
            <button onClick={() => setHideBalance((v) => !v)}>
              {hideBalance ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
            </button>
          </p>
          <div className="flex items-end gap-2 mt-1">
            <h1 className="text-4xl font-extrabold text-white tracking-tight">
              {hideBalance ? "₦ ••••••" : "₦ 247,580"}
            </h1>
            <span className="text-xs text-cyan font-semibold mb-2">+12.4% ↑</span>
          </div>

          <div className="mt-5 grid grid-cols-2 gap-3">
            <button
              onClick={onSell}
              className="bg-gradient-gold text-jungle-deep font-bold py-3.5 rounded-2xl flex items-center justify-center gap-2 shadow-glow-gold active:scale-[0.98] transition"
            >
              <Gift className="size-4" /> Sell Card
            </button>
            <button className="bg-white/10 backdrop-blur text-white font-semibold py-3.5 rounded-2xl flex items-center justify-center gap-2 border border-white/15">
              <Send className="size-4" /> Withdraw
            </button>
          </div>
        </div>
      </header>

      {/* Live rate ticker */}
      <div className="px-5 mt-5">
        <div className="bg-gradient-card rounded-2xl p-4 border border-border flex items-center gap-3">
          <div className="size-10 rounded-xl bg-cyan/15 grid place-items-center pulse-ring">
            <Zap className="size-5 text-cyan" />
          </div>
          <div className="flex-1">
            <p className="text-xs text-muted-foreground">Live rate · locked for 5 min</p>
            <p className="text-sm font-bold">Apple USA · ₦1,485 / $1</p>
          </div>
          <span className="text-xs font-bold text-cyan">+₦15</span>
        </div>
      </div>

      {/* Hustle League snapshot */}
      <div className="px-5 mt-5">
        <div className="rounded-3xl bg-gradient-pink p-5 relative overflow-hidden shadow-glow-pink">
          <div className="absolute -right-6 -bottom-6 text-[120px] opacity-15 leading-none">🔥</div>
          <div className="flex items-center justify-between relative">
            <div>
              <p className="text-xs text-white/80 font-semibold uppercase tracking-wide">Hustle League</p>
              <p className="text-2xl font-extrabold text-white mt-1">Level 14 · Pro</p>
              <div className="flex items-center gap-1.5 mt-1">
                <Flame className="size-4 text-gold fill-gold" />
                <span className="text-sm text-white font-semibold">12 day streak</span>
              </div>
            </div>
            <div className="text-right">
              <p className="text-xs text-white/80">Rank</p>
              <p className="text-3xl font-extrabold text-white">#247</p>
            </div>
          </div>

          <div className="mt-4 relative">
            <div className="flex justify-between text-[11px] text-white/80 mb-1.5 font-medium">
              <span>2,840 XP</span>
              <span>3,500 XP · Boss</span>
            </div>
            <div className="h-2 rounded-full bg-white/20 overflow-hidden">
              <div className="h-full w-[81%] bg-gradient-gold rounded-full" />
            </div>
          </div>
        </div>
      </div>

      {/* Quick actions */}
      <div className="px-5 mt-6">
        <div className="grid grid-cols-4 gap-3">
          {[
            { icon: Gift, label: "Gift Card", color: "bg-gold/15 text-gold" },
            { icon: Bitcoin, label: "Crypto", color: "bg-cyan/15 text-cyan" },
            { icon: ScanLine, label: "Scan", color: "bg-pink/15 text-pink" },
            { icon: Sparkles, label: "Rewards", color: "bg-orange/15 text-orange" },
          ].map(({ icon: Icon, label, color }) => (
            <button key={label} className="flex flex-col items-center gap-2">
              <div className={`size-14 rounded-2xl grid place-items-center ${color}`}>
                <Icon className="size-6" />
              </div>
              <span className="text-[11px] font-semibold text-muted-foreground">{label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Trending cards */}
      <div className="px-5 mt-7">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold">Best Rates Today</h2>
          <button className="text-xs text-gold font-semibold flex items-center gap-0.5">
            See all <ChevronRight className="size-3" />
          </button>
        </div>
        <div className="mt-3 flex gap-3 overflow-x-auto scrollbar-hide -mx-5 px-5 pb-2">
          <RateCard brand="Apple" region="USA" rate="₦1,485" trend="+2.1%" gradient="bg-gradient-to-br from-slate-700 to-slate-900" emoji="🍎" />
          <RateCard brand="Amazon" region="USA" rate="₦1,420" trend="+1.5%" gradient="bg-gradient-to-br from-orange-500 to-yellow-600" emoji="📦" />
          <RateCard brand="Steam" region="USA" rate="₦1,380" trend="-0.3%" gradient="bg-gradient-to-br from-blue-700 to-indigo-900" emoji="🎮" />
          <RateCard brand="Google" region="USA" rate="₦1,460" trend="+0.8%" gradient="bg-gradient-to-br from-emerald-600 to-teal-800" emoji="▶️" />
        </div>
      </div>

      {/* Recent activity */}
      <div className="px-5 mt-6">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold">Recent Trades</h2>
          <button className="text-xs text-gold font-semibold flex items-center gap-0.5">
            History <ChevronRight className="size-3" />
          </button>
        </div>
        <div className="mt-3 space-y-2">
          <TxRow icon={Gift} title="Apple $100" sub="Paystack · 2m" amount="+₦142,800" color="text-cyan" status="paid" />
          <TxRow icon={Bitcoin} title="USDT 50" sub="Busha · 18m" amount="+₦78,500" color="text-cyan" status="paid" />
          <TxRow icon={Gift} title="Steam $25" sub="Verifying…" amount="₦34,500" color="text-gold" status="pending" />
          <TxRow icon={ArrowUpRight} title="Withdraw GTBank" sub="GTB ••6721" amount="-₦200,000" color="text-pink" status="paid" />
        </div>
      </div>
    </div>
  );
}

function RateCard({
  brand,
  region,
  rate,
  trend,
  gradient,
  emoji,
}: {
  brand: string;
  region: string;
  rate: string;
  trend: string;
  gradient: string;
  emoji: string;
}) {
  const up = trend.startsWith("+");
  return (
    <div className={`min-w-[160px] rounded-2xl p-4 ${gradient} relative overflow-hidden shadow-card`}>
      <div className="text-2xl">{emoji}</div>
      <p className="text-xs text-white/70 mt-3 font-medium">{brand}</p>
      <p className="text-sm font-bold text-white">{region}</p>
      <div className="mt-3 flex items-end justify-between">
        <span className="text-lg font-extrabold text-white">{rate}</span>
        <span className={`text-[11px] font-bold ${up ? "text-cyan" : "text-pink"}`}>{trend}</span>
      </div>
    </div>
  );
}

function TxRow({
  icon: Icon,
  title,
  sub,
  amount,
  color,
  status,
}: {
  icon: any;
  title: string;
  sub: string;
  amount: string;
  color: string;
  status: "paid" | "pending";
}) {
  return (
    <div className="flex items-center gap-3 bg-card rounded-2xl p-3.5 border border-border/60">
      <div className="size-11 rounded-xl bg-secondary grid place-items-center">
        <Icon className="size-5 text-muted-foreground" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold truncate">{title}</p>
        <p className="text-xs text-muted-foreground">{sub}</p>
      </div>
      <div className="text-right">
        <p className={`text-sm font-bold ${color}`}>{amount}</p>
        <p className="text-[10px] text-muted-foreground capitalize flex items-center gap-1 justify-end">
          {status === "paid" && <CheckCircle2 className="size-3 text-cyan" />}
          {status}
        </p>
      </div>
    </div>
  );
}

/* ---------------------------------- SELL ---------------------------------- */

function SellScreen({ onVerify }: { onVerify: () => void }) {
  const brands = [
    { name: "Apple", emoji: "🍎", rate: "₦1,485" },
    { name: "Amazon", emoji: "📦", rate: "₦1,420" },
    { name: "Steam", emoji: "🎮", rate: "₦1,380" },
    { name: "Google Play", emoji: "▶️", rate: "₦1,460" },
    { name: "Xbox", emoji: "🟢", rate: "₦1,395" },
    { name: "PlayStation", emoji: "🎯", rate: "₦1,410" },
    { name: "Netflix", emoji: "🎬", rate: "₦1,350" },
    { name: "Spotify", emoji: "🎵", rate: "₦1,325" },
  ];
  const [selected, setSelected] = useState("Apple");
  const [amount, setAmount] = useState("100");

  const naira = useMemo(() => {
    const n = Number(amount || 0);
    return (n * 1485).toLocaleString();
  }, [amount]);

  return (
    <div className="flex flex-col">
      <header className="px-5 pt-12 pb-4">
        <p className="text-xs text-muted-foreground font-semibold uppercase tracking-wider">Step 1 of 3</p>
        <h1 className="text-2xl font-extrabold mt-1">Sell a Gift Card</h1>
        <p className="text-sm text-muted-foreground mt-1">Verified in 3 seconds. Paid in under 5 minutes.</p>
      </header>

      {/* Progress dots */}
      <div className="px-5 flex items-center gap-2">
        <div className="h-1.5 flex-1 rounded-full bg-gradient-gold" />
        <div className="h-1.5 flex-1 rounded-full bg-secondary" />
        <div className="h-1.5 flex-1 rounded-full bg-secondary" />
      </div>

      {/* Brand selector */}
      <div className="mt-6 px-5">
        <h3 className="text-sm font-bold mb-3">Choose Brand</h3>
        <div className="grid grid-cols-4 gap-3">
          {brands.map((b) => {
            const active = selected === b.name;
            return (
              <button
                key={b.name}
                onClick={() => setSelected(b.name)}
                className={`aspect-square rounded-2xl flex flex-col items-center justify-center gap-1 border-2 transition ${
                  active
                    ? "border-gold bg-gold/10 shadow-glow-gold"
                    : "border-border bg-card"
                }`}
              >
                <span className="text-2xl">{b.emoji}</span>
                <span className="text-[10px] font-semibold text-center px-1 leading-tight">{b.name}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Amount */}
      <div className="px-5 mt-6">
        <h3 className="text-sm font-bold mb-3">Card Value (USD)</h3>
        <div className="bg-card rounded-2xl p-5 border border-border">
          <div className="flex items-center gap-2">
            <span className="text-3xl font-extrabold text-muted-foreground">$</span>
            <input
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="bg-transparent outline-none text-4xl font-extrabold flex-1 min-w-0"
            />
          </div>
          <div className="mt-3 flex gap-2">
            {["25", "50", "100", "200", "500"].map((a) => (
              <button
                key={a}
                onClick={() => setAmount(a)}
                className={`px-3 py-1.5 rounded-full text-xs font-semibold border ${
                  amount === a ? "bg-gold text-jungle-deep border-gold" : "bg-secondary border-border text-muted-foreground"
                }`}
              >
                ${a}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Quote card */}
      <div className="px-5 mt-5">
        <div className="bg-gradient-hero rounded-3xl p-5 shadow-glow-jungle relative overflow-hidden">
          <div className="absolute right-4 top-4 px-2 py-1 rounded-full bg-cyan/20 backdrop-blur text-cyan text-[10px] font-bold flex items-center gap-1">
            <span className="size-1.5 rounded-full bg-cyan pulse-ring" /> LIVE RATE
          </div>
          <p className="text-xs text-white/70 font-medium">You will receive</p>
          <h2 className="text-4xl font-extrabold text-white mt-1 tracking-tight">₦ {naira}</h2>
          <p className="text-xs text-white/60 mt-1">@ ₦1,485 / $1 · locked for 5:00</p>

          <div className="mt-5 grid grid-cols-3 gap-3 pt-4 border-t border-white/10">
            <Stat label="Fee" value="0%" hint="Today" />
            <Stat label="Speed" value="<5min" hint="Guaranteed" />
            <Stat label="Bonus" value="+50 XP" hint="Streak day 12" />
          </div>
        </div>
      </div>

      {/* CTA */}
      <div className="px-5 mt-6">
        <button onClick={onVerify} className="w-full bg-gradient-gold text-jungle-deep font-extrabold py-4 rounded-2xl flex items-center justify-center gap-2 shadow-glow-gold active:scale-[0.99] transition">
          Continue to Verify <ChevronRight className="size-5" />
        </button>
        <div className="mt-3 flex items-center justify-center gap-2 text-[11px] text-muted-foreground">
          <ShieldCheck className="size-3.5 text-cyan" />
          Verified with Reloadly · Paid via Paystack
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div>
      <p className="text-[10px] text-white/60 font-medium">{label}</p>
      <p className="text-sm font-extrabold text-white">{value}</p>
      <p className="text-[9px] text-white/50">{hint}</p>
    </div>
  );
}

/* --------------------------------- LEAGUE --------------------------------- */

function LeagueScreen() {
  const leaders = [
    { rank: 2, name: "Chioma O.", xp: "18,420", emoji: "🥈", color: "bg-slate-400/20" },
    { rank: 1, name: "Emeka K.", xp: "24,180", emoji: "🥇", color: "bg-gold/25" },
    { rank: 3, name: "Aisha B.", xp: "16,990", emoji: "🥉", color: "bg-orange/20" },
  ];
  const rest = [
    { rank: 4, name: "Tunde A. (You)", xp: "12,840", me: true },
    { rank: 5, name: "Femi L.", xp: "11,210" },
    { rank: 6, name: "Ngozi P.", xp: "10,500" },
    { rank: 7, name: "Bola S.", xp: "9,720" },
    { rank: 8, name: "Kemi D.", xp: "8,990" },
  ];

  return (
    <div className="flex flex-col">
      <header className="px-5 pt-12 pb-4 bg-gradient-pink rounded-b-[2rem] shadow-glow-pink relative overflow-hidden">
        <div className="absolute -right-8 -top-8 text-[140px] opacity-15 leading-none">🏆</div>
        <p className="text-xs text-white/80 font-semibold uppercase tracking-wider">The Hustle League</p>
        <h1 className="text-3xl font-extrabold text-white mt-1">Weekly Top Traders</h1>
        <p className="text-sm text-white/80 mt-1">Resets in 2d 14h · Win ₦50,000 + Boss badge</p>
      </header>

      {/* Podium */}
      <div className="px-5 mt-6 grid grid-cols-3 gap-3 items-end">
        {leaders.map((l, i) => (
          <div key={l.rank} className={`rounded-2xl ${l.color} p-3 text-center border border-border ${i === 1 ? "pb-8 -mb-4 scale-105" : ""}`}>
            <div className="text-3xl">{l.emoji}</div>
            <div className="size-12 mx-auto rounded-full bg-gradient-gold mt-2 grid place-items-center font-extrabold text-jungle-deep">
              {l.name[0]}
            </div>
            <p className="text-xs font-bold mt-2 truncate">{l.name}</p>
            <p className="text-[10px] text-muted-foreground">{l.xp} XP</p>
          </div>
        ))}
      </div>

      {/* Streak banner */}
      <div className="px-5 mt-6">
        <div className="rounded-2xl bg-gradient-card border border-border p-4 flex items-center gap-4">
          <div className="size-14 rounded-2xl bg-orange/20 grid place-items-center">
            <Flame className="size-7 text-orange fill-orange" />
          </div>
          <div className="flex-1">
            <p className="text-sm font-bold">12 Day Streak 🔥</p>
            <p className="text-[11px] text-muted-foreground">Trade today for +3% bonus rate</p>
          </div>
          <div className="flex gap-1">
            {Array.from({ length: 7 }).map((_, i) => (
              <div
                key={i}
                className={`size-2 rounded-full ${i < 6 ? "bg-orange" : "bg-secondary"}`}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Badges */}
      <div className="px-5 mt-6">
        <h3 className="text-sm font-bold mb-3">Your Badges</h3>
        <div className="flex gap-3 overflow-x-auto scrollbar-hide -mx-5 px-5 pb-2">
          <Badge icon="⚡" label="Speed Demon" sub="<2 min" earned />
          <Badge icon="💰" label="Big Baller" sub=">$500" earned />
          <Badge icon="🚀" label="First Trade" sub="Unlocked" earned />
          <Badge icon="👑" label="Crypto King" sub="50 swaps" />
          <Badge icon="🎯" label="Sharp Shoot" sub="100 trades" />
        </div>
      </div>

      {/* Leaderboard list */}
      <div className="px-5 mt-6">
        <h3 className="text-sm font-bold mb-3">Leaderboard</h3>
        <div className="bg-card rounded-2xl border border-border overflow-hidden">
          {rest.map((u, i) => (
            <div
              key={u.rank}
              className={`flex items-center gap-3 p-3.5 ${
                i !== rest.length - 1 ? "border-b border-border" : ""
              } ${u.me ? "bg-gold/10" : ""}`}
            >
              <span className={`text-sm font-bold w-6 text-center ${u.me ? "text-gold" : "text-muted-foreground"}`}>
                {u.rank}
              </span>
              <div className="size-9 rounded-full bg-secondary grid place-items-center text-sm font-bold">
                {u.name[0]}
              </div>
              <div className="flex-1">
                <p className={`text-sm font-semibold ${u.me ? "text-gold" : ""}`}>{u.name}</p>
                <p className="text-[11px] text-muted-foreground">{u.xp} XP</p>
              </div>
              {u.me && <Crown className="size-4 text-gold" />}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Badge({ icon, label, sub, earned }: { icon: string; label: string; sub: string; earned?: boolean }) {
  return (
    <div
      className={`min-w-[100px] rounded-2xl p-3 text-center border ${
        earned ? "bg-gradient-card border-gold/40" : "bg-secondary/50 border-border opacity-50"
      }`}
    >
      <div className={`text-3xl ${earned ? "" : "grayscale"}`}>{icon}</div>
      <p className="text-[11px] font-bold mt-1">{label}</p>
      <p className="text-[9px] text-muted-foreground">{sub}</p>
    </div>
  );
}

/* --------------------------------- WALLET --------------------------------- */

function WalletScreen() {
  const assets = [
    { name: "Naira", code: "NGN", balance: "247,580.00", value: "₦247,580", icon: "₦", color: "bg-jungle/30 text-cyan" },
    { name: "Bitcoin", code: "BTC", balance: "0.0184", value: "₦28,420", icon: "₿", color: "bg-orange/20 text-orange" },
    { name: "Tether", code: "USDT", balance: "182.50", value: "₦271,012", icon: "₮", color: "bg-cyan/15 text-cyan" },
    { name: "Ethereum", code: "ETH", balance: "0.241", value: "₦94,200", icon: "Ξ", color: "bg-pink/15 text-pink" },
  ];

  return (
    <div className="flex flex-col">
      <header className="px-5 pt-12 pb-6">
        <h1 className="text-2xl font-extrabold">Wallet</h1>

        <div className="mt-5 rounded-3xl bg-gradient-hero p-6 shadow-glow-jungle relative overflow-hidden">
          <div className="absolute -right-12 -top-12 size-48 rounded-full bg-cyan/10 blur-3xl" />
          <p className="text-xs text-white/60 font-medium">Total Net Worth</p>
          <h2 className="text-4xl font-extrabold text-white mt-1 tracking-tight">₦ 641,212</h2>
          <div className="flex items-center gap-2 mt-1.5">
            <span className="text-xs font-bold text-cyan bg-cyan/15 px-2 py-0.5 rounded-full">+8.2% · 7d</span>
            <span className="text-[11px] text-white/60">≈ $431.92</span>
          </div>

          <div className="mt-5 grid grid-cols-3 gap-2">
            <CircleBtn icon={Plus} label="Add" />
            <CircleBtn icon={ArrowUpRight} label="Send" />
            <CircleBtn icon={ArrowDownLeft} label="Swap" />
          </div>
        </div>
      </header>

      <div className="px-5">
        <div className="flex gap-2 bg-card p-1 rounded-2xl border border-border">
          {["Assets", "Activity", "Rewards"].map((t, i) => (
            <button
              key={t}
              className={`flex-1 py-2 rounded-xl text-xs font-bold ${
                i === 0 ? "bg-gold text-jungle-deep" : "text-muted-foreground"
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      <div className="px-5 mt-4 space-y-2">
        {assets.map((a) => (
          <div key={a.code} className="bg-card rounded-2xl p-4 border border-border/60 flex items-center gap-3">
            <div className={`size-11 rounded-2xl grid place-items-center font-extrabold text-lg ${a.color}`}>
              {a.icon}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold">{a.name}</p>
              <p className="text-[11px] text-muted-foreground">{a.balance} {a.code}</p>
            </div>
            <div className="text-right">
              <p className="text-sm font-bold">{a.value}</p>
              <p className="text-[11px] text-cyan font-semibold">+2.1%</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function CircleBtn({ icon: Icon, label }: { icon: any; label: string }) {
  return (
    <button className="flex flex-col items-center gap-1.5">
      <div className="size-11 rounded-full bg-white/10 backdrop-blur grid place-items-center border border-white/15">
        <Icon className="size-5 text-white" />
      </div>
      <span className="text-[10px] text-white/80 font-semibold">{label}</span>
    </button>
  );
}

/* -------------------------------- PROFILE -------------------------------- */

function ProfileScreen() {
  return (
    <div className="flex flex-col">
      <header className="px-5 pt-12 pb-6 bg-gradient-hero rounded-b-[2rem] shadow-glow-jungle relative overflow-hidden">
        <div className="absolute -right-8 -top-8 size-40 rounded-full bg-gold/10 blur-2xl" />
        <h1 className="text-2xl font-extrabold text-white">Profile</h1>

        <div className="mt-5 flex items-center gap-4">
          <div className="size-20 rounded-3xl bg-gradient-gold grid place-items-center font-extrabold text-jungle-deep text-3xl shadow-glow-gold">
            T
          </div>
          <div className="flex-1">
            <p className="text-lg font-extrabold text-white">Tunde Adebayo</p>
            <p className="text-xs text-white/70">tunde@7sevencards.app</p>
            <div className="mt-2 flex gap-2">
              <span className="px-2 py-0.5 rounded-full bg-cyan/20 text-cyan text-[10px] font-bold flex items-center gap-1">
                <ShieldCheck className="size-3" /> KYC Verified
              </span>
              <span className="px-2 py-0.5 rounded-full bg-gold/20 text-gold text-[10px] font-bold">PRO</span>
            </div>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-3 gap-2 text-center">
          <ProfStat n="142" label="Trades" />
          <ProfStat n="12,840" label="XP" />
          <ProfStat n="#247" label="Rank" />
        </div>
      </header>

      <div className="px-5 mt-6 space-y-2">
        <MenuItem icon={Trophy} label="The Hustle League" sub="Level 14 · Pro" tint="text-gold" />
        <MenuItem icon={Gift} label="Referral Program" sub="₦500 per friend · 8 invited" tint="text-pink" />
        <MenuItem icon={ShieldCheck} label="Security & KYC" sub="BVN verified" tint="text-cyan" />
        <MenuItem icon={Wallet} label="Payout Accounts" sub="GTBank ••6721" tint="text-orange" />
        <MenuItem icon={Gamepad2} label="Low Data Mode" sub="Save bandwidth" tint="text-cyan" toggle />
      </div>

      <div className="px-5 mt-6">
        <div className="bg-gradient-card rounded-2xl p-5 border border-gold/30">
          <div className="flex items-center gap-2 text-gold text-xs font-bold uppercase">
            <Sparkles className="size-4" /> Upgrade
          </div>
          <p className="text-lg font-extrabold mt-2">7SEVEN Premium</p>
          <p className="text-xs text-muted-foreground mt-1">
            Higher limits · +2% better rates · Priority payouts · 24/7 support
          </p>
          <button className="mt-4 bg-gradient-gold text-jungle-deep font-bold px-4 py-2.5 rounded-xl text-sm shadow-glow-gold">
            Get Premium · ₦2,000/mo
          </button>
        </div>
      </div>

      <p className="text-center text-[10px] text-muted-foreground mt-8 px-5">
        7SEVEN CARDS · v1.0.0 · Built for Africa 🌍
      </p>
    </div>
  );
}

function ProfStat({ n, label }: { n: string; label: string }) {
  return (
    <div className="bg-white/10 backdrop-blur rounded-2xl py-2.5 border border-white/10">
      <p className="text-lg font-extrabold text-white">{n}</p>
      <p className="text-[10px] text-white/70 font-medium">{label}</p>
    </div>
  );
}

function MenuItem({
  icon: Icon,
  label,
  sub,
  tint,
  toggle,
}: {
  icon: any;
  label: string;
  sub: string;
  tint: string;
  toggle?: boolean;
}) {
  const [on, setOn] = useState(true);
  return (
    <button
      onClick={() => toggle && setOn((v) => !v)}
      className="w-full bg-card rounded-2xl p-4 border border-border/60 flex items-center gap-3"
    >
      <div className={`size-10 rounded-xl bg-secondary grid place-items-center ${tint}`}>
        <Icon className="size-5" />
      </div>
      <div className="flex-1 text-left">
        <p className="text-sm font-semibold">{label}</p>
        <p className="text-[11px] text-muted-foreground">{sub}</p>
      </div>
      {toggle ? (
        <div className={`w-10 h-6 rounded-full p-0.5 transition ${on ? "bg-gold" : "bg-secondary"}`}>
          <div className={`size-5 rounded-full bg-white transition ${on ? "translate-x-4" : ""}`} />
        </div>
      ) : (
        <ChevronRight className="size-4 text-muted-foreground" />
      )}
    </button>
  );
}

/* ------------------------------- BOTTOM NAV ------------------------------- */

function BottomNav({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }) {
  const items: { id: Tab; icon: any; label: string }[] = [
    { id: "home", icon: Home, label: "Home" },
    { id: "league", icon: Trophy, label: "League" },
    { id: "sell", icon: Plus, label: "Sell" },
    { id: "wallet", icon: Wallet, label: "Wallet" },
    { id: "profile", icon: User, label: "Profile" },
  ];

  return (
    <nav className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[480px] px-4 pb-4 pt-2 bg-gradient-to-t from-background via-background to-transparent z-50">
      <div className="bg-card/95 backdrop-blur-xl rounded-3xl border border-border shadow-card flex items-center justify-around py-2 px-2">
        {items.map((it) => {
          const active = tab === it.id;
          const isCenter = it.id === "sell";
          if (isCenter) {
            return (
              <button
                key={it.id}
                onClick={() => setTab(it.id)}
                className="size-14 -mt-7 rounded-2xl bg-gradient-gold grid place-items-center shadow-glow-gold active:scale-95 transition"
              >
                <Plus className="size-7 text-jungle-deep" strokeWidth={3} />
              </button>
            );
          }
          return (
            <button
              key={it.id}
              onClick={() => setTab(it.id)}
              className="flex flex-col items-center gap-0.5 px-4 py-1.5"
            >
              <it.icon className={`size-5 ${active ? "text-gold" : "text-muted-foreground"}`} />
              <span className={`text-[10px] font-bold ${active ? "text-gold" : "text-muted-foreground"}`}>
                {it.label}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
