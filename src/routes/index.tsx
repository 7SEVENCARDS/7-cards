import React, { useState, useEffect, useMemo } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
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
  TrendingUp,
  User,
  Wallet,
  XCircle,
  Zap,
  LogOut,
  MessageCircle as MessageCircleIcon,
  CalendarClock,
  Users,
} from "lucide-react";


import { AuthScreen } from "../components/AuthScreen";
import { CodeEntryScreen } from "../components/CodeEntryScreen";
import { KYCScreen } from "../components/KYCScreen";
import { PayoutAccountsScreen } from "../components/PayoutAccountsScreen";
import { NotificationsScreen } from "../components/NotificationsScreen";
import { ReferralScreen } from "../components/ReferralScreen";
import { PremiumScreen } from "../components/PremiumScreen";
import { TradeHistoryScreen } from "../components/TradeHistoryScreen";
import { TradeStatusScreen } from "../components/TradeStatusScreen";
import { SupportScreen } from "../components/SupportScreen";
import { AdminScreen } from "../components/AdminScreen";
import { EscrowScreen } from "../components/EscrowScreen";
import { useSession } from "../hooks/useSession";
import {
  useExchangeRates,
  useWallets,
  useRecentTrades,
  useUserXP,
  useLeaderboard,
  useUserBadges,
  useNotifications,
} from "../hooks/useAppData";
import { supabase } from "../lib/supabase";
import { createTrade, verifyGiftCard, processPayout, submitCardBatch, getTradeLimits } from "../server-functions/trades";
import { getKYCStatus } from "../server-functions/kyc";
import { lookupAccount, addPayoutAccount } from "../server-functions/payout-accounts";
import { requestUserWithdrawal, getEarningsHistory } from "../server-functions/wallet";
import type { EarningsData } from "../server-functions/wallet";

export const Route = createFileRoute("/")({
  component: App,
});

type Tab = "home" | "sell" | "code" | "verify" | "league" | "wallet" | "profile" | "kyc" | "payout" | "withdraw" | "notifications" | "referral" | "premium" | "history" | "status" | "support" | "admin";

type ActiveSell = {
  brand: string;
  amountUsd: string;
  rate: number;
  region: string;
};

/* ─────────────────────────────────── APP ─────────────────────────────────── */

function App() {
  const { user, loading: sessionLoading } = useSession();
  const [tab, setTab] = useState<Tab>("home");
  const [activeSell, setActiveSell] = useState<ActiveSell | null>(null);
  const [pendingCode, setPendingCode] = useState<{ code: string; pin?: string } | null>(null);
  const [activeTradeId, setActiveTradeId] = useState<string | null>(null);
  const [activeStatusTradeId, setActiveStatusTradeId] = useState<string | null>(null);
  const [creatingTrade, setCreatingTrade] = useState(false);

  // ── Real data hooks ──────────────────────────────────────────────────────
  const { data: rates = [] } = useExchangeRates();
  const { data: wallets = [] } = useWallets(user?.id);
  const { data: recentTrades = [] } = useRecentTrades(user?.id, 5);
  const { data: xp } = useUserXP(user?.id);
  const { data: leaderboard = [] } = useLeaderboard();
  const { data: badges = [] } = useUserBadges(user?.id);
  const { data: notifications = [] } = useNotifications(user?.id);

  const { data: kycStatus } = useQuery({
    queryKey: ["kyc-status", user?.id],
    queryFn: () => user?.id ? getKYCStatus({ data: { userId: user.id } }) : null,
    enabled: !!user?.id,
    staleTime: 60_000,
  });

  const { data: profile } = useQuery({
    queryKey: ["profile", user?.id],
    queryFn: async () => {
      if (!user?.id) return null;
      const { data } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", user.id)
        .single();
      return data;
    },
    enabled: !!user?.id,
  });

  const { data: payoutAccounts = [] } = useQuery({
    queryKey: ["payout-accounts", user?.id],
    queryFn: async () => {
      if (!user?.id) return [];
      const { data } = await supabase
        .from("payout_accounts")
        .select("*")
        .eq("user_id", user.id)
        .order("is_default", { ascending: false });
      return data ?? [];
    },
    enabled: !!user?.id,
  });

  // ── Loading splash ────────────────────────────────────────────────────────
  if (sessionLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="size-16 rounded-3xl bg-gradient-gold grid place-items-center shadow-glow-gold animate-pulse">
            <span className="text-jungle-deep text-2xl font-extrabold">7</span>
          </div>
          <Loader2 className="size-5 text-muted-foreground animate-spin" />
        </div>
      </div>
    );
  }

  // ── Auth gate ─────────────────────────────────────────────────────────────
  if (!user) {
    return <AuthScreen onAuthenticated={() => {}} />;
  }

  // ── Derived helpers ───────────────────────────────────────────────────────
  const ngnWallet = wallets.find((w) => w.currency === "NGN");
  const ngnBalance = Number(ngnWallet?.balance ?? 0);
  const userName = profile?.display_name ?? (profile?.full_name ?? "").split(" ")[0] || "7Trader";
  const defaultPayoutAccount = (payoutAccounts as Array<{bank_code:string;account_number:string;account_name:string}>)[0];
  const emailVerified = !!(user as { email_confirmed_at?: string | null }).email_confirmed_at;

  const getRateForBrand = (brand: string) => {
    const r = rates.find((r) => r.brand === brand);
    return Number(r?.rate_per_dollar ?? 1485);
  };

  const handleCodeContinue = async (code: string, pin?: string, _imagePath?: string) => {
    if (!activeSell || !user) return;
    setPendingCode({ code, pin });
    setCreatingTrade(true);
    try {
      const trade = await createTrade({
        data: {
          type: "gift_card",
          brand:        activeSell.brand,
          amountUsd:    Number(activeSell.amountUsd),
          exchangeRate: activeSell.rate,
          region:       activeSell.region ?? "US",
        },
      });
      setActiveTradeId((trade as {id:string}).id);
    } catch {
      // Fallback trade ID so UX isn't blocked when DB isn't configured
      setActiveTradeId("demo-" + Date.now());
    } finally {
      setCreatingTrade(false);
    }
    setTab("verify");
  };

  // ── Multi-card batch handler ───────────────────────────────────────────────
  // When the user enters multiple cards in CodeEntryScreen, each card is sent
  // to a DIFFERENT vendor (round-robin). Only 1 active vendor → sequential
  // queue (one card dispatched at a time to minimise exposure risk).
  const handleCodeContinueBatch = async (
    cards: Array<{ cardCode: string; cardPin?: string; imagePath?: string; ocrResult?: { brand: string | null; code: string | null; pin: string | null; denomination: number | null; currency: string | null; country: string | null; confidence: number; riskScore: "low" | "medium" | "high"; flags: string[]; rawText: string | null } }>
  ) => {
    if (!activeSell || !user) return;
    setCreatingTrade(true);
    try {
      const result = await submitCardBatch({
        data: {
          cards,
          brand:        activeSell.brand,
          amountUsd:    Number(activeSell.amountUsd),
          exchangeRate: activeSell.rate,
          region:       activeSell.region ?? "US",
        },
      }) as {
        batchId:       string;
        strategy:      string;
        vendorCount:   number;
        verifiedCount: number;
        failedCount:   number;
        queuedCount:   number;
        cards:         Array<{ position: number; status: string; failureReason?: string; assignedVendorName?: string }>;
      };

      // Show a summary notification then land on history
      const { verifiedCount, failedCount, strategy } = result;
      const stratLabel = strategy === "sequential" ? "sequential" : "risk-distributed";
      await queryClient.invalidateQueries({ queryKey: ["trades", user.id] });

      // Navigate to trade history so user sees all their batch trades
      setActiveSell(null);
      setPendingCode(null);
      setActiveTradeId(null);
      setTab("history");

      // Surface a summary notification (non-blocking)
      console.info(
        `[Batch] ${verifiedCount} verified, ${failedCount} failed · ${stratLabel}`
      );
    } catch (e) {
      console.error("[Batch] submitCardBatch failed:", e instanceof Error ? e.message : e);
      // Fall back to history tab so user isn't stuck
      setTab("history");
    } finally {
      setCreatingTrade(false);
      setActiveSell(null);
    }
  };

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    setTab("home");
  };

  const unreadCount = (notifications as Array<{read:boolean}>).filter((n) => !n.read).length;

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <div className="mx-auto flex min-h-dvh max-w-[480px] flex-col bg-background pb-safe-nav relative">
        {tab === "home" && (
          <HomeScreen
            onSell={() => setTab("sell")}
            onNotifications={() => setTab("notifications")}
            onWithdraw={() => setTab("withdraw")}
            onHistory={() => setTab("history")}
            onLeague={() => setTab("league")}
            userName={userName}
            ngnBalance={ngnBalance}
            recentTrades={recentTrades as TradeRow[]}
            bestRate={getRateForBrand("Apple")}
            xp={xp as XPData | undefined}
            unreadCount={unreadCount}
          />
        )}
        {tab === "sell" && (
          <SellScreen
            onVerify={(brand, amountUsd, rate, region) => {
              setActiveSell({ brand, amountUsd, rate, region: region ?? "US" });
              setTab("code");
            }}
            rates={rates as RateData[]}
            kycStatus={kycStatus?.status ?? profile?.kyc_status ?? "pending"}
            emailVerified={emailVerified}
            onNavigateKYC={() => setTab("kyc")}
          />
        )}
        {tab === "code" && activeSell && (
          <CodeEntryScreen
            brand={activeSell.brand}
            amountUsd={activeSell.amountUsd}
            estimatedNgn={Math.round(
              Number(activeSell.amountUsd) * activeSell.rate
            ).toLocaleString()}
            userId={user?.id}
            onBack={() => setTab("sell")}
            onContinue={creatingTrade ? () => {} : handleCodeContinue}
            onContinueBatch={creatingTrade ? undefined : handleCodeContinueBatch}
          />
        )}
        {tab === "verify" && activeSell && (
          <VerifyScreen
            onBack={() => setTab("code")}
            onDone={() => {
              setTab("wallet");
              setActiveSell(null);
              setPendingCode(null);
              setActiveTradeId(null);
            }}
            onNavigateSupport={() => setTab("support")}
            tradeId={activeTradeId}
            userId={user.id}
            cardCode={pendingCode?.code ?? ""}
            cardPin={pendingCode?.pin}
            brand={activeSell.brand}
            amountUsd={Number(activeSell.amountUsd)}
            amountNgn={Math.round(Number(activeSell.amountUsd) * activeSell.rate)}
            recipientEmail={user.email ?? ""}
            payoutBankCode={defaultPayoutAccount?.bank_code ?? "058"}
            payoutAccountNumber={defaultPayoutAccount?.account_number ?? "0000000000"}
            payoutAccountName={defaultPayoutAccount?.account_name ?? "Demo Account"}
          />
        )}
        {tab === "league" && (
          <LeagueScreen
            userId={user.id}
            leaderboard={leaderboard as LeaderEntry[]}
            xp={xp as XPData | undefined}
            badges={badges as string[]}
          />
        )}
        {tab === "wallet" && (
          <WalletScreen
            wallets={wallets as WalletData[]}
            recentTrades={recentTrades as TradeRow[]}
            userId={user?.id ?? ""}
            onViewHistory={() => setTab("history")}
            onWithdraw={() => setTab("withdraw")}
          />
        )}
        {tab === "withdraw" && user && (
          <WithdrawScreen
            userId={user.id}
            ngnBalance={ngnBalance}
            payoutAccounts={payoutAccounts as PayoutAccount[]}
            onBack={() => setTab("wallet")}
            onNavigatePayout={() => setTab("payout")}
          />
        )}
        {tab === "profile" && (
          <ProfileScreen
            profile={profile as ProfileData | null | undefined}
            xp={xp as XPData | undefined}
            emailVerified={emailVerified}
            userEmail={user?.email ?? ""}
            userId={user?.id}
            onSignOut={handleSignOut}
            onNavigateKYC={() => setTab("kyc")}
            onNavigatePayout={() => setTab("payout")}
            onNavigateReferral={() => setTab("referral")}
            onNavigatePremium={() => setTab("premium")}
            onNavigateSupport={() => setTab("support")}
            onNavigateLeague={() => setTab("league")}
            onNavigateAdmin={profile?.role === "admin" ? () => setTab("admin") : undefined}
          />
        )}
        {tab === "kyc" && user && (
          <KYCScreen
            userId={user.id}
            currentStatus={kycStatus?.status ?? profile?.kyc_status ?? "pending"}
            hasBVN={kycStatus?.hasBVN ?? !!profile?.kyc_bvn}
            hasNIN={kycStatus?.hasNIN ?? !!profile?.kyc_nin}
            onBack={() => setTab("profile")}
            onComplete={() => setTab("profile")}
          />
        )}
        {tab === "payout" && user && (
          <PayoutAccountsScreen
            userId={user.id}
            onBack={() => setTab("profile")}
          />
        )}
        {tab === "notifications" && user && (
          <NotificationsScreen
            userId={user.id}
            notifications={notifications as Array<{ id: string; title: string; message: string; read: boolean; type: "info" | "success" | "warning" | "error"; created_at: string }>}
            onBack={() => setTab("home")}
          />
        )}
        {tab === "referral" && user && (
          <ReferralScreen
            userId={user.id}
            onBack={() => setTab("profile")}
          />
        )}
        {tab === "premium" && user && (
          <PremiumScreen
            userId={user.id}
            userEmail={user.email ?? ""}
            userName={(profile as ProfileData | null | undefined)?.display_name ?? (profile as ProfileData | null | undefined)?.full_name ?? "7Trader"}
            onBack={() => setTab("profile")}
          />
        )}
        {tab === "history" && user && (
          <TradeHistoryScreen
            userId={user.id}
            onBack={() => setTab("wallet")}
            onViewStatus={(id) => { setActiveStatusTradeId(id); setTab("status"); }}
          />
        )}
        {tab === "status" && activeStatusTradeId && user && (
          <TradeStatusScreen
            tradeId={activeStatusTradeId}
            userId={user.id}
            onBack={() => setTab("history")}
            payoutBankCode={defaultPayoutAccount?.bank_code}
            payoutAccountNumber={defaultPayoutAccount?.account_number}
            payoutAccountName={defaultPayoutAccount?.account_name}
          />
        )}
        {tab === "support" && user && (
          <SupportScreen
            userId={user.id}
            isPremium={(profile as ProfileData | null | undefined)?.premium ?? false}
            userName={(profile as ProfileData | null | undefined)?.display_name ?? (profile as ProfileData | null | undefined)?.full_name ?? "7Trader"}
            onBack={() => setTab("profile")}
          />
        )}
        {tab === "admin" && user && (
          <AdminScreen
            adminId={user.id}
            onBack={() => setTab("profile")}
          />
        )}

        {tab !== "code" && tab !== "verify" && tab !== "kyc" && tab !== "payout" && tab !== "withdraw" && tab !== "notifications" && tab !== "referral" && tab !== "premium" && tab !== "history" && tab !== "status" && tab !== "support" && tab !== "admin" && (
          <BottomNav tab={tab} setTab={(t) => setTab(t as Tab)} />
        )}
      </div>
    </div>
  );
}

/* ─────────────────────────── SHARED TYPES (local) ────────────────────────── */
type TradeRow = {
  id: string; type: string; brand: string | null; amount_usd: number | null;
  amount_ngn: number | null; status: string; created_at: string;
};
type RateData = { brand: string; rate_per_dollar: number; trend: string; region?: string };
type XPData = {
  totalXp: number; weeklyXp: number; level: number;
  streakDays: number; tradeCount: number; weeklyRank: number; allTimeRank: number;
};
type LeaderEntry = {
  id: string; display_name: string; full_name?: string; total_xp: number; weekly_xp: number;
  level: number; streak_days: number; weekly_rank: number;
};
type WalletData = { currency: string; balance: number; locked_balance: number };
type PortfolioData = { totalNgn: number; changePercent: string };
type ProfileData = {
  id: string; full_name: string; display_name?: string | null; phone: string | null; kyc_status: string; premium: boolean; role?: string;
};
type PayoutAccount = {
  id: string; bank_name: string; bank_code: string; account_number: string; account_name: string; is_default: boolean;
};

/* ─────────────────────────────────── HOME ─────────────────────────────────── */

const BRAND_EMOJI: Record<string, string> = {
  Apple: "🍎", Amazon: "📦", Steam: "🎮", "Google Play": "▶️",
  Xbox: "🟢", PlayStation: "🎯", Netflix: "🎬", Spotify: "🎵",
  "Razer Gold": "🟡", Sephora: "💄", Nordstrom: "🛍️",
};

function timeAgo(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return `${Math.round(diff)}s`;
  if (diff < 3600) return `${Math.round(diff / 60)}m`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h`;
  return `${Math.round(diff / 86400)}d`;
}

function HomeScreen({
  onSell, onNotifications, onWithdraw, onHistory, onLeague, userName, ngnBalance, recentTrades, bestRate, xp, unreadCount,
}: {
  onSell: () => void; onNotifications: () => void; onWithdraw: () => void; onHistory: () => void; onLeague: () => void;
  userName: string; ngnBalance: number; recentTrades: TradeRow[]; bestRate: number; xp?: XPData; unreadCount: number;
}) {
  const [hideBalance, setHideBalance] = useState(false);
  const [showCryptoSoon, setShowCryptoSoon] = useState(false);

  const levelName = (xp?.level ?? 1) >= 15 ? "Boss" : (xp?.level ?? 1) >= 10 ? "Pro" : "Rookie";
  const xpToNext = ((xp?.level ?? 1) + 1) * 1000;
  const xpProgress = Math.min(100, Math.round(((xp?.totalXp ?? 0) % 1000) / 10));

  return (
    <div className="flex flex-col">
      {/* Header */}
      <header className="bg-gradient-hero px-5 pt-safe-top pb-8 rounded-b-[2rem] shadow-glow-jungle relative overflow-hidden">
        <div className="absolute -right-10 -top-10 size-40 rounded-full bg-gold/10 blur-2xl" />
        <div className="absolute right-20 top-32 size-24 rounded-full bg-pink/20 blur-2xl" />

        <div className="flex items-center justify-between relative">
          <div className="flex items-center gap-3">
            <div className="size-11 rounded-2xl bg-jungle-deep grid place-items-center overflow-hidden ring-1 ring-gold/40 shadow-glow-gold">
              <img src="/logo-badge.png" alt="7SEVEN" className="size-11 object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display="none"; }} />
            </div>
            <div>
              <p className="text-xs text-white/60 font-medium">Welcome back</p>
              <p className="text-sm font-semibold text-white">{userName} 👋</p>
            </div>
          </div>
          <button
            onClick={onNotifications}
            className="size-10 rounded-full bg-white/10 grid place-items-center backdrop-blur relative"
          >
            <Bell className="size-5 text-white" />
            {unreadCount > 0 && (
              <span className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-pink ring-2 ring-jungle-deep" />
            )}
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
              {hideBalance ? "₦ ••••••" : `₦ ${ngnBalance.toLocaleString()}`}
            </h1>
          </div>

          <div className="mt-5 grid grid-cols-2 gap-3">
            <button
              onClick={onSell}
              className="bg-gradient-gold text-jungle-deep font-bold py-3.5 rounded-2xl flex items-center justify-center gap-2 shadow-glow-gold active:scale-[0.98] transition"
            >
              <Gift className="size-4" /> Sell Card
            </button>
            <button
              onClick={onWithdraw}
              className="bg-white/10 backdrop-blur text-white font-semibold py-3.5 rounded-2xl flex items-center justify-center gap-2 border border-white/15 active:scale-[0.98] transition"
            >
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
            <p className="text-xs text-muted-foreground">Live rate · Apple USA</p>
            <p className="text-sm font-bold">₦{bestRate.toLocaleString()} / $1</p>
          </div>
          <span className="text-xs font-bold text-cyan px-2 py-1 rounded-full bg-cyan/10">LIVE</span>
        </div>
      </div>

      {/* Hustle League snapshot */}
      <div className="px-5 mt-5">
        <div className="rounded-3xl bg-gradient-pink p-5 relative overflow-hidden shadow-glow-pink">
          <div className="absolute -right-6 -bottom-6 text-[120px] opacity-15 leading-none">🔥</div>
          <div className="flex items-center justify-between relative">
            <div>
              <p className="text-xs text-white/80 font-semibold uppercase tracking-wide">Hustle League</p>
              <p className="text-2xl font-extrabold text-white mt-1">Level {xp?.level ?? 1} · {levelName}</p>
              <div className="flex items-center gap-1.5 mt-1">
                <Flame className="size-4 text-gold fill-gold" />
                <span className="text-sm text-white font-semibold">{xp?.streakDays ?? 0} day streak</span>
              </div>
            </div>
            <div className="text-right">
              <p className="text-xs text-white/80">Rank</p>
              <p className="text-3xl font-extrabold text-white">
                {xp?.weeklyRank ? `#${xp.weeklyRank}` : "—"}
              </p>
            </div>
          </div>

          <div className="mt-4 relative">
            <div className="flex justify-between text-[11px] text-white/80 mb-1.5 font-medium">
              <span>{(xp?.totalXp ?? 0).toLocaleString()} XP</span>
              <span>{xpToNext.toLocaleString()} XP · {levelName === "Rookie" ? "Pro" : "Boss"}</span>
            </div>
            <div className="h-2 rounded-full bg-white/20 overflow-hidden">
              <div className="h-full bg-gradient-gold rounded-full transition-all" style={{ width: `${xpProgress}%` }} />
            </div>
          </div>
        </div>
      </div>

      {/* Quick actions */}
      <div className="px-5 mt-6">
        <div className="grid grid-cols-4 gap-3">
          {[
            { icon: Gift, label: "Gift Card", color: "bg-gold/15 text-gold", comingSoon: false, onClick: onSell },
            { icon: Bitcoin, label: "Crypto", color: "bg-cyan/15 text-cyan", comingSoon: true, onClick: () => setShowCryptoSoon(true) },
            { icon: ScanLine, label: "Scan", color: "bg-pink/15 text-pink", comingSoon: false, onClick: onSell },
            { icon: Sparkles, label: "Rewards", color: "bg-orange/15 text-orange", comingSoon: false, onClick: onLeague },
          ].map(({ icon: Icon, label, color, comingSoon, onClick }) => (
            <button key={label} onClick={onClick} className="flex flex-col items-center gap-2 relative">
              <div className="relative">
                <div className={`size-14 rounded-2xl grid place-items-center ${color} ${comingSoon ? "opacity-60" : ""}`}>
                  <Icon className="size-6" />
                </div>
                {comingSoon && (
                  <span className="absolute -top-2 -right-2 bg-gold text-jungle-deep text-[8px] font-extrabold px-1.5 py-0.5 rounded-full leading-none uppercase tracking-wide">
                    Soon
                  </span>
                )}
              </div>
              <span className="text-[11px] font-semibold text-muted-foreground">{label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Best rates carousel */}
      <div className="px-5 mt-7">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold">Best Rates Today</h2>
          <button className="text-xs text-gold font-semibold flex items-center gap-0.5">
            See all <ChevronRight className="size-3" />
          </button>
        </div>
        <div className="mt-3 flex gap-3 overflow-x-auto scrollbar-hide -mx-5 px-5 pb-2">
          <RateCard brand="Apple"  region="USA" rate={`₦1,${(bestRate).toLocaleString()}`} trend="+2.1%" gradient="bg-gradient-to-br from-slate-700 to-slate-900" emoji="🍎" />
          <RateCard brand="Amazon" region="USA" rate="₦1,420" trend="+1.5%" gradient="bg-gradient-to-br from-orange-500 to-yellow-600" emoji="📦" />
          <RateCard brand="Steam"  region="USA" rate="₦1,380" trend="-0.3%" gradient="bg-gradient-to-br from-blue-700 to-indigo-900" emoji="🎮" />
          <RateCard brand="Google" region="USA" rate="₦1,460" trend="+0.8%" gradient="bg-gradient-to-br from-emerald-600 to-teal-800" emoji="▶️" />
        </div>
      </div>

      {/* Recent activity */}
      <div className="px-5 mt-6">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold">Recent Trades</h2>
          <button onClick={onHistory} className="text-xs text-gold font-semibold flex items-center gap-0.5">
            History <ChevronRight className="size-3" />
          </button>
        </div>
        <div className="mt-3 space-y-2">
          {recentTrades.length > 0 ? (
            recentTrades.map((t) => (
              <TxRow
                key={t.id}
                icon={Gift}
                title={`${t.brand ?? "Card"} $${t.amount_usd ?? ""}`}
                sub={`${t.status} · ${timeAgo(t.created_at)}`}
                amount={t.amount_ngn ? `+₦${Number(t.amount_ngn).toLocaleString()}` : "—"}
                color={t.status === "paid" ? "text-cyan" : "text-gold"}
                status={t.status === "paid" ? "paid" : "pending"}
              />
            ))
          ) : (
            <div className="flex flex-col items-center gap-4 py-8 text-center">
              <img src="/mascot.png" alt="Seven" className="size-20 object-contain drop-shadow-lg" />
              <div>
                <p className="text-sm font-extrabold">No trades yet</p>
                <p className="text-xs text-muted-foreground mt-1">Sell a gift card to see your history here</p>
              </div>
              <button
                onClick={onSell}
                className="bg-gradient-gold text-jungle-deep font-extrabold text-xs px-5 py-2.5 rounded-xl shadow-glow-gold flex items-center gap-1.5 active:scale-[0.98] transition"
              >
                <Gift className="size-3.5" /> Sell Now
              </button>
            </div>
          )}
        </div>
      </div>
      {showCryptoSoon && <CryptoComingSoonModal onClose={() => setShowCryptoSoon(false)} />}
    </div>
  );
}

function RateCard({ brand, region, rate, trend, gradient, emoji }: {
  brand: string; region: string; rate: string; trend: string; gradient: string; emoji: string;
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

function TxRow({ icon: Icon, title, sub, amount, color, status }: {
  icon: React.ComponentType<{ className?: string }>;
  title: string; sub: string; amount: string; color: string; status: "paid" | "pending";
}) {
  return (
    <div className="flex items-center gap-3 bg-card rounded-2xl p-3.5 border border-border/60">
      <div className="size-11 rounded-xl bg-secondary grid place-items-center">
        <Icon className="size-5 text-muted-foreground" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold truncate">{title}</p>
        <p className="text-xs text-muted-foreground capitalize">{sub}</p>
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


/* ─────────────────────────────────── SELL ─────────────────────────────────── */

const REGION_CONFIG = {
  US: { name: "United States", flag: "🇺🇸", symbol: "$",   code: "USD", forexMultiplier: 1.000, quickAmounts: ["25","50","100","200"] },
  UK: { name: "United Kingdom", flag: "🇬🇧", symbol: "£",   code: "GBP", forexMultiplier: 1.270, quickAmounts: ["10","25","50","100"] },
  EU: { name: "Eurozone",       flag: "🇪🇺", symbol: "€",   code: "EUR", forexMultiplier: 1.080, quickAmounts: ["10","25","50","100"] },
  CA: { name: "Canada",         flag: "🇨🇦", symbol: "C$",  code: "CAD", forexMultiplier: 0.740, quickAmounts: ["25","50","100","200"] },
} as const;
type Region = keyof typeof REGION_CONFIG;

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
};

const REGION_BRANDS: Record<Region, Array<{ name: string; emoji: string }>> = {
  US: [
    { name: "Apple",       emoji: "🍎" },
    { name: "Steam",       emoji: "🎮" },
    { name: "Amazon",      emoji: "📦" },
    { name: "Google Play", emoji: "▶️"  },
    { name: "Xbox",        emoji: "🟢" },
    { name: "PlayStation", emoji: "🎯" },
    { name: "Netflix",     emoji: "🎬" },
    { name: "Spotify",     emoji: "🎵" },
    { name: "Razer Gold",  emoji: "🟡" },
    { name: "Sephora",     emoji: "💄" },
    { name: "Nordstrom",   emoji: "🛍️" },
  ],
  UK: [
    { name: "Google Play", emoji: "▶️"  },
    { name: "Steam",       emoji: "🎮" },
    { name: "Amazon",      emoji: "📦" },
    { name: "Apple",       emoji: "🍎" },
    { name: "Netflix",     emoji: "🎬" },
    { name: "Spotify",     emoji: "🎵" },
  ],
  EU: [
    { name: "Steam",       emoji: "🎮" },
    { name: "Google Play", emoji: "▶️"  },
    { name: "Amazon",      emoji: "📦" },
    { name: "Apple",       emoji: "🍎" },
  ],
  CA: [
    { name: "Apple",       emoji: "🍎" },
    { name: "Amazon",      emoji: "📦" },
    { name: "Steam",       emoji: "🎮" },
    { name: "Google Play", emoji: "▶️"  },
    { name: "Xbox",        emoji: "🟢" },
    { name: "PlayStation", emoji: "🎯" },
    { name: "Spotify",     emoji: "🎵" },
  ],
};

const TIER_LIMITS = {
  unverified:    200,
  email_verified: 500,
  kyc_verified:  5_000,
  premium:       10_000,
} as const;

function SellScreen({
  onVerify,
  rates,
  kycStatus,
  emailVerified,
  onNavigateKYC,
}: {
  onVerify: (brand: string, amountUsd: string, rate: number, region: string) => void;
  rates: RateData[];
  kycStatus?: string;
  emailVerified?: boolean;
  onNavigateKYC?: () => void;
}) {
  const [region, setRegion] = useState<Region>("US");
  const [selected, setSelected] = useState("Apple");
  const [amount, setAmount] = useState("50");

  const { symbol, code, forexMultiplier, quickAmounts } = REGION_CONFIG[region];
  const brands = REGION_BRANDS[region];

  const handleRegionChange = (r: Region) => {
    setRegion(r);
    setSelected(REGION_BRANDS[r][0].name);
    setAmount(REGION_CONFIG[r].quickAmounts[1]);
  };

  const isKycVerified = kycStatus === "verified";
  const tier = isKycVerified ? "kyc_verified" : emailVerified ? "email_verified" : "unverified";
  const limitUsd = TIER_LIMITS[tier];
  const amountNum = Number(amount || 0);
  const amountUsdEquiv = amountNum * forexMultiplier;
  const overLimit = amountUsdEquiv > limitUsd;

  const baseRate = useMemo(() => {
    const r = rates.find((r) => r.brand === selected && r.region === region) ??
              rates.find((r) => r.brand === selected);
    return Number(r?.rate_per_dollar ?? 1485);
  }, [selected, rates, region]);

  const currentRate = useMemo(() => Math.round(baseRate * forexMultiplier), [baseRate, forexMultiplier]);

  const naira = useMemo(() => (amountNum * currentRate).toLocaleString(), [amountNum, currentRate]);

  return (
    <div className="flex flex-col pb-8">
      <header className="px-5 pt-safe-top pb-4">
        <p className="text-xs text-muted-foreground font-semibold uppercase tracking-wider">Step 1 of 3</p>
        <h1 className="text-2xl font-extrabold mt-1">Sell a Gift Card</h1>
        <p className="text-sm text-muted-foreground mt-1">Verified in 3 seconds. Paid in under 5 minutes.</p>
      </header>

      {/* Trade limit banner — 3-tier */}
      {!isKycVerified && onNavigateKYC && (
        <button
          onClick={onNavigateKYC}
          className="mx-5 mb-1 flex items-center justify-between gap-3 bg-gold/10 border border-gold/30 rounded-2xl px-4 py-3"
        >
          <div className="flex items-center gap-2 min-w-0">
            <ShieldCheck className="size-4 text-gold shrink-0" />
            {!emailVerified ? (
              <p className="text-xs text-left">
                <span className="font-bold text-gold">$200 limit</span>
                <span className="text-muted-foreground"> · Verify email → </span>
                <span className="font-bold text-gold">$500</span>
                <span className="text-muted-foreground"> · KYC → </span>
                <span className="font-bold text-gold">$5,000</span>
              </p>
            ) : (
              <p className="text-xs text-left">
                <span className="font-bold text-gold">$500 limit</span>
                <span className="text-muted-foreground"> · Complete KYC to unlock </span>
                <span className="font-bold text-gold">$5,000 per trade</span>
              </p>
            )}
          </div>
          <ChevronRight className="size-4 text-gold shrink-0" />
        </button>
      )}

      {/* Progress dots */}
      <div className="px-5 flex items-center gap-2">
        <div className="h-1.5 flex-1 rounded-full bg-gradient-gold" />
        <div className="h-1.5 flex-1 rounded-full bg-secondary" />
        <div className="h-1.5 flex-1 rounded-full bg-secondary" />
      </div>

      {/* Region selector */}
      <div className="px-5 mt-5">
        <h3 className="text-sm font-bold mb-3">Card Region</h3>
        <div className="grid grid-cols-4 gap-2">
          {(Object.keys(REGION_CONFIG) as Region[]).map((key) => {
            const cfg = REGION_CONFIG[key];
            return (
              <button
                key={key}
                onClick={() => handleRegionChange(key)}
                className={`flex flex-col items-center gap-1 py-2.5 rounded-2xl border-2 transition ${
                  region === key
                    ? "border-gold bg-gold/10 shadow-glow-gold"
                    : "border-border bg-card"
                }`}
              >
                <span className="text-xl">{cfg.flag}</span>
                <span className={`text-[10px] font-bold ${region === key ? "text-gold" : "text-muted-foreground"}`}>{key}</span>
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground text-center">
          {REGION_CONFIG[region].name} · {code}
          {region !== "US" && (
            <span className="ml-1 text-gold font-semibold">· ₦{currentRate.toLocaleString()}/{symbol}1</span>
          )}
        </p>
      </div>

      {/* Brand selector */}
      <div className="mt-4 px-5">
        <h3 className="text-sm font-bold mb-3">Choose Brand</h3>
        <div className="grid grid-cols-4 gap-3">
          {brands.map((b) => {
            const active = selected === b.name;
            return (
              <button
                key={b.name}
                onClick={() => setSelected(b.name)}
                className={`aspect-square rounded-2xl flex flex-col items-center justify-center gap-1.5 border-2 transition ${
                  active ? "border-gold bg-gold/10 shadow-glow-gold" : "border-border bg-card"
                }`}
              >
                <BrandLogo name={b.name} emoji={b.emoji} />
                <span className="text-[10px] font-semibold text-center px-1 leading-tight">{b.name}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Amount */}
      <div className="px-5 mt-5">
        <h3 className="text-sm font-bold mb-3">Card Value ({code})</h3>
        <div className="bg-card rounded-2xl p-5 border border-border">
          <div className="flex items-center gap-2">
            <span className="text-3xl font-extrabold text-muted-foreground">{symbol}</span>
            <input
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="bg-transparent outline-none text-4xl font-extrabold flex-1 min-w-0"
              inputMode="decimal"
              min="1"
            />
          </div>
          <div className="mt-3 flex gap-2 flex-wrap">
            {quickAmounts.map((a) => (
              <button
                key={a}
                onClick={() => setAmount(a)}
                className={`px-3 py-1.5 rounded-full text-xs font-semibold border ${
                  amount === a ? "bg-gold text-jungle-deep border-gold" : "bg-secondary border-border text-muted-foreground"
                }`}
              >
                {symbol}{a}
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
          <p className="text-xs text-white/60 mt-1">
            @ ₦{currentRate.toLocaleString()} / {symbol}1
            {region !== "US" && ` · ₦${baseRate.toLocaleString()}/$`}
          </p>
          <div className="mt-5 grid grid-cols-3 gap-3 pt-4 border-t border-white/10">
            <Stat label="Fee" value="0%" hint="Today" />
            <Stat label="Speed" value="<5min" hint="Guaranteed" />
            <Stat label="Bonus" value="+50 XP" hint={`Streak day ${0}`} />
          </div>
        </div>
      </div>

      {/* CTA */}
      <div className="px-5 mt-6">
        {overLimit ? (
          <div className="space-y-2">
            <div className="bg-red-500/10 border border-red-500/30 rounded-2xl px-4 py-3 text-xs text-red-400 font-semibold text-center">
              ${limitUsd} per-trade limit · ≈ {symbol}{Math.round(limitUsd / forexMultiplier)} {code}
            </div>
            {!emailVerified ? (
              <button
                onClick={onNavigateKYC}
                className="w-full bg-gradient-gold text-jungle-deep font-extrabold py-4 rounded-2xl flex items-center justify-center gap-2 shadow-glow-gold"
              >
                <ShieldCheck className="size-5" /> Verify Email → Unlock $500 Limit
              </button>
            ) : !isKycVerified ? (
              <button
                onClick={onNavigateKYC}
                className="w-full bg-gradient-gold text-jungle-deep font-extrabold py-4 rounded-2xl flex items-center justify-center gap-2 shadow-glow-gold"
              >
                <ShieldCheck className="size-5" /> Complete KYC → Unlock $5,000 Limit
              </button>
            ) : null}
            <button
              onClick={() => setAmount(String(Math.round(limitUsd / forexMultiplier)))}
              className="w-full bg-card border border-border text-foreground font-semibold py-3 rounded-2xl text-sm"
            >
              Reduce to {symbol}{Math.round(limitUsd / forexMultiplier)} and continue
            </button>
          </div>
        ) : (
          <button
            onClick={() => onVerify(selected, String(Math.round(amountUsdEquiv * 100) / 100), baseRate, region)}
            disabled={amountNum <= 0}
            className="w-full bg-gradient-gold text-jungle-deep font-extrabold py-4 rounded-2xl flex items-center justify-center gap-2 shadow-glow-gold active:scale-[0.99] transition disabled:opacity-50"
          >
            Continue to Verify <ChevronRight className="size-5" />
          </button>
        )}
        <div className="mt-3 flex items-center justify-center gap-2 text-[11px] text-muted-foreground">
          <ShieldCheck className="size-3.5 text-cyan" />
          Verified with Reloadly · Paid via Squad
        </div>
      </div>
    </div>
  );
}

function BrandLogo({ name, emoji }: { name: string; emoji: string }) {
  const [failed, setFailed] = useState(false);
  const logo = BRAND_LOGO_URLS[name];
  if (!logo || failed) {
    return <span className="text-3xl leading-none">{emoji}</span>;
  }
  return (
    <img
      src={logo}
      alt={name}
      className="size-10 object-contain rounded-xl"
      onError={() => setFailed(true)}
    />
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

/* ─────────────────────────────────── LEAGUE ─────────────────────────────────── */

function LeagueScreen({
  userId, leaderboard, xp, badges,
}: {
  userId: string; leaderboard: LeaderEntry[]; xp?: XPData; badges: string[];
}) {
  // Top 3 for podium (ordered 2nd, 1st, 3rd)
  const top3 = leaderboard.slice(0, 3);
  const podiumOrder = top3.length >= 3
    ? [top3[1], top3[0], top3[2]]
    : top3;
  const rest = leaderboard.slice(3, 10);

  const podiumEmoji = ["🥈", "🥇", "🥉"];
  const podiumColor = ["bg-slate-400/20", "bg-gold/25", "bg-orange/20"];

  const ALL_BADGES = [
    { key: "speed_demon", icon: "⚡", label: "Speed Demon", sub: "<2 min" },
    { key: "big_baller",  icon: "💰", label: "Big Baller",  sub: ">$500" },
    { key: "first_trade", icon: "🚀", label: "First Trade", sub: "Unlocked" },
    { key: "crypto_king", icon: "👑", label: "Crypto King", sub: "50 swaps" },
    { key: "sharp_shoot", icon: "🎯", label: "Sharp Shoot", sub: "100 trades" },
  ];

  return (
    <div className="flex flex-col">
      <header className="px-5 pt-safe-top pb-4 bg-gradient-pink rounded-b-[2rem] shadow-glow-pink relative overflow-hidden">
        <div className="absolute -right-8 -top-8 text-[140px] opacity-15 leading-none">🏆</div>
        <p className="text-xs text-white/80 font-semibold uppercase tracking-wider">The Hustle League</p>
        <h1 className="text-3xl font-extrabold text-white mt-1">Weekly Top Traders</h1>
        <p className="text-sm text-white/80 mt-1">Resets in 2d 14h · Win ₦50,000 + Boss badge</p>
      </header>

      {/* Podium */}
      <div className="px-5 mt-6 grid grid-cols-3 gap-3 items-end">
        {podiumOrder.length > 0 ? (
          podiumOrder.map((l, i) => (
            <div key={l?.id ?? i} className={`rounded-2xl ${podiumColor[i]} p-3 text-center border border-border ${i === 1 ? "pb-8 -mb-4 scale-105" : ""}`}>
              <div className="text-3xl">{podiumEmoji[i]}</div>
              <div className="size-12 mx-auto rounded-full bg-gradient-gold mt-2 overflow-hidden grid place-items-center font-extrabold text-jungle-deep">
                <img
                  src={`https://api.dicebear.com/9.x/bottts-neutral/svg?seed=${encodeURIComponent(l?.id ?? l?.display_name ?? "")}&backgroundColor=transparent`}
                  alt={l?.display_name ?? "Trader"}
                  className="size-12 object-cover"
                  onError={(e) => { const t = e.target as HTMLImageElement; t.style.display="none"; }}
                />
              </div>
              <p className="text-xs font-bold mt-2 truncate">{l?.display_name ?? "7Trader"}</p>
              <p className="text-[10px] text-muted-foreground">{(l?.weekly_xp ?? 0).toLocaleString()} XP</p>
            </div>
          ))
        ) : (
          <div className="col-span-3 flex flex-col items-center gap-3 py-8 text-center">
            <img src="/mascot.png" alt="Seven" className="size-16 object-contain opacity-60" />
            <p className="text-xs text-muted-foreground">No trades this week yet — be the first!</p>
          </div>
        )}
      </div>

      {/* Streak banner */}
      <div className="px-5 mt-6">
        <div className="rounded-2xl bg-gradient-card border border-border p-4 flex items-center gap-4">
          <div className="size-14 rounded-2xl bg-orange/20 grid place-items-center">
            <Flame className="size-7 text-orange fill-orange" />
          </div>
          <div className="flex-1">
            <p className="text-sm font-bold">{xp?.streakDays ?? 0} Day Streak 🔥</p>
            <p className="text-[11px] text-muted-foreground">Trade today for +3% bonus rate</p>
          </div>
          <div className="flex gap-1">
            {Array.from({ length: 7 }).map((_, i) => (
              <div key={i} className={`size-2 rounded-full ${i < Math.min(xp?.streakDays ?? 0, 7) ? "bg-orange" : "bg-secondary"}`} />
            ))}
          </div>
        </div>
      </div>

      {/* Badges */}
      <div className="px-5 mt-6">
        <h3 className="text-sm font-bold mb-3">Your Badges</h3>
        <div className="flex gap-3 overflow-x-auto scrollbar-hide -mx-5 px-5 pb-2">
          {ALL_BADGES.map((b) => (
            <Badge key={b.key} icon={b.icon} label={b.label} sub={b.sub} earned={badges.includes(b.key)} />
          ))}
        </div>
      </div>

      {/* Leaderboard list */}
      <div className="px-5 mt-6">
        <h3 className="text-sm font-bold mb-3">Leaderboard</h3>
        <div className="bg-card rounded-2xl border border-border overflow-hidden">
          {rest.map((u, i) => {
            const isMe = u.id === userId;
            return (
              <div
                key={u.id}
                className={`flex items-center gap-3 p-3.5 ${i !== rest.length - 1 ? "border-b border-border" : ""} ${isMe ? "bg-gold/10" : ""}`}
              >
                <span className={`text-sm font-bold w-6 text-center ${isMe ? "text-gold" : "text-muted-foreground"}`}>
                  {u.weekly_rank}
                </span>
                <div className="size-9 rounded-full bg-secondary overflow-hidden grid place-items-center text-sm font-bold">
                  <img
                    src={`https://api.dicebear.com/9.x/bottts-neutral/svg?seed=${encodeURIComponent(u.id ?? u.display_name ?? "")}&backgroundColor=transparent`}
                    alt={u.display_name ?? "Trader"}
                    className="size-9 object-cover"
                    onError={(e) => { const t = e.target as HTMLImageElement; t.style.display="none"; }}
                  />
                </div>
                <div className="flex-1">
                  <p className={`text-sm font-semibold ${isMe ? "text-gold" : ""}`}>
                    {u.display_name ?? "7Trader"}{isMe ? " (You)" : ""}
                  </p>
                  <p className="text-[11px] text-muted-foreground">{(u.weekly_xp ?? 0).toLocaleString()} XP</p>
                </div>
                {isMe && <Crown className="size-4 text-gold" />}
              </div>
            );
          })}
          {rest.length === 0 && (
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <img src="/mascot.png" alt="Seven" className="size-14 object-contain opacity-60" />
              <p className="text-xs text-muted-foreground px-4">Trade this week to appear on the leaderboard</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Badge({ icon, label, sub, earned }: { icon: string; label: string; sub: string; earned?: boolean }) {
  return (
    <div className={`min-w-[100px] rounded-2xl p-3 text-center border ${earned ? "bg-gradient-card border-gold/40" : "bg-secondary/50 border-border opacity-50"}`}>
      <div className={`text-3xl ${earned ? "" : "grayscale"}`}>{icon}</div>
      <p className="text-[11px] font-bold mt-1">{label}</p>
      <p className="text-[9px] text-muted-foreground">{sub}</p>
    </div>
  );
}

/* ─────────────────────────────────── WALLET ─────────────────────────────────── */

function WalletScreen({
  wallets, recentTrades, userId, onViewHistory, onWithdraw,
}: {
  wallets: WalletData[]; recentTrades: TradeRow[]; userId: string; onViewHistory: () => void; onWithdraw: () => void;
}) {
  const [activeTab, setActiveTab] = useState(0);
  const [showCryptoSoon, setShowCryptoSoon] = useState(false);

  const { data: earnings, isLoading: earningsLoading } = useQuery<EarningsData>({
    queryKey: ["earnings-history", userId],
    queryFn:  () => getEarningsHistory({ data: { userId } }),
    staleTime: 60_000,
    enabled:   !!userId,
  });

  const ngnWallet = wallets.find((w) => w.currency === "NGN");
  const ngnBalance = Number(ngnWallet?.balance ?? 0);

  return (
    <div className="flex flex-col pb-28">
      <header className="px-5 pt-safe-top pb-6">
        <h1 className="text-2xl font-extrabold">Wallet</h1>

        {/* NGN Balance Card */}
        <div className="mt-5 rounded-3xl bg-gradient-hero p-6 shadow-glow-jungle relative overflow-hidden">
          <div className="absolute -right-12 -top-12 size-48 rounded-full bg-cyan/10 blur-3xl" />
          <div className="absolute left-0 bottom-0 size-32 rounded-full bg-gold/5 blur-2xl" />
          <p className="text-xs text-white/60 font-medium tracking-wide uppercase">Naira Balance</p>
          <h2 className="text-4xl font-extrabold text-white mt-1 tracking-tight">
            ₦ {ngnBalance.toLocaleString()}
          </h2>
          <p className="text-[11px] text-white/50 mt-1.5">Earned from gift card trades</p>
          <button
            onClick={onWithdraw}
            className="mt-4 w-full bg-white/15 backdrop-blur border border-white/20 text-white font-bold py-3 rounded-2xl flex items-center justify-center gap-2 active:scale-[0.98] transition text-sm"
          >
            <Send className="size-4" /> Withdraw to Bank
          </button>
        </div>
      </header>

      {/* Crypto Coming Soon Banner */}
      <div className="px-5 mb-5">
        <div className="rounded-3xl bg-gradient-to-br from-[#071525] to-[#0a1e35] border border-cyan/20 p-5 relative overflow-hidden">
          <div className="absolute -right-8 -top-8 size-40 rounded-full bg-cyan/8 blur-2xl pointer-events-none" />
          <div className="absolute -left-4 -bottom-4 size-28 rounded-full bg-gold/8 blur-xl pointer-events-none" />

          <div className="flex items-start gap-3 relative">
            <div className="size-12 rounded-2xl bg-gradient-to-br from-cyan/25 to-blue-900/60 border border-cyan/25 grid place-items-center shrink-0">
              <Bitcoin className="size-6 text-cyan" />
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-0.5">
                <p className="text-sm font-extrabold text-white">Crypto Trading</p>
                <span className="bg-gold text-jungle-deep text-[9px] font-extrabold px-2 py-0.5 rounded-full uppercase tracking-wider">Coming Soon</span>
              </div>
              <p className="text-[11px] text-white/55 leading-relaxed">
                BTC · ETH · USDT · USDC. Secure, compliant digital assets built for Nigeria.
              </p>
            </div>
          </div>

          {/* Progress steps */}
          <div className="mt-4 flex gap-2">
            {[
              { label: "Dev Complete", done: true },
              { label: "Security Audit", done: true },
              { label: "Regulatory", done: true },
              { label: "Launch 🚀", done: false },
            ].map((step) => (
              <div key={step.label} className="flex-1 text-center">
                <div className={`h-1 rounded-full mb-1.5 ${step.done ? "bg-gradient-to-r from-gold to-amber-400" : "bg-white/15"}`} />
                <p className="text-[8px] text-white/40 font-semibold leading-tight">{step.label}</p>
              </div>
            ))}
          </div>

          <button
            onClick={() => setShowCryptoSoon(true)}
            className="w-full mt-4 py-3 rounded-2xl bg-cyan/12 border border-cyan/25 text-cyan text-xs font-extrabold flex items-center justify-center gap-2 active:scale-[0.98] transition"
          >
            <Bell className="size-4" /> Get Early Access
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="px-5">
        <div className="flex gap-2 bg-card p-1 rounded-2xl border border-border">
          {["Assets", "Activity", "Earnings"].map((t, i) => (
            <button
              key={t}
              onClick={() => setActiveTab(i)}
              className={`flex-1 py-2 rounded-xl text-xs font-bold ${activeTab === i ? "bg-gold text-jungle-deep" : "text-muted-foreground"}`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {/* Assets */}
      {activeTab === 0 && (
        <div className="px-5 mt-4 space-y-2">
          {/* NGN wallet */}
          {ngnWallet ? (
            <div className="bg-card rounded-2xl p-4 border border-border/60 flex items-center gap-3">
              <div className="size-11 rounded-2xl grid place-items-center font-extrabold text-lg bg-jungle/30 text-cyan">₦</div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-bold">Naira</p>
                <p className="text-[11px] text-muted-foreground">Nigerian Naira · NGN</p>
              </div>
              <div className="text-right">
                <p className="text-sm font-bold">₦{ngnBalance.toLocaleString()}</p>
                <p className="text-[10px] text-cyan font-semibold">Available</p>
              </div>
            </div>
          ) : (
            <div className="text-center py-6 text-sm text-muted-foreground">
              Sell your first gift card to earn ₦
            </div>
          )}

          {/* Locked crypto assets — Coming Soon tiles */}
          {[
            { symbol: "BTC", name: "Bitcoin",  icon: "₿", color: "bg-orange-500/15 text-orange-400" },
            { symbol: "ETH", name: "Ethereum", icon: "Ξ", color: "bg-indigo-500/15 text-indigo-400" },
            { symbol: "USDT", name: "Tether",  icon: "₮", color: "bg-emerald-500/15 text-emerald-400" },
          ].map(({ symbol, name, icon, color }) => (
            <button
              key={symbol}
              onClick={() => setShowCryptoSoon(true)}
              className="w-full bg-card/40 rounded-2xl p-4 border border-border/30 flex items-center gap-3 opacity-55 hover:opacity-75 active:opacity-90 transition"
            >
              <div className={`size-11 rounded-2xl grid place-items-center font-extrabold text-lg ${color}`}>{icon}</div>
              <div className="flex-1 text-left min-w-0">
                <p className="text-sm font-bold">{name}</p>
                <p className="text-[11px] text-muted-foreground">{symbol} · Launching Soon</p>
              </div>
              <span className="text-[10px] bg-gold/20 text-gold font-extrabold px-2.5 py-1 rounded-full shrink-0">Soon</span>
            </button>
          ))}
        </div>
      )}

      {/* Activity */}
      {activeTab === 1 && (
        <div className="px-5 mt-4 space-y-2">
          <div className="flex items-center justify-between mb-1">
            <p className="text-xs font-semibold text-muted-foreground">Recent Activity</p>
            <button onClick={onViewHistory} className="text-xs font-semibold text-gold">
              See All →
            </button>
          </div>
          {recentTrades.length > 0 ? (
            recentTrades.map((t) => (
              <TxRow
                key={t.id}
                icon={Gift}
                title={`${t.brand ?? "Card"} $${t.amount_usd ?? ""}`}
                sub={`${t.status} · ${timeAgo(t.created_at)}`}
                amount={t.amount_ngn ? `+₦${Number(t.amount_ngn).toLocaleString()}` : "—"}
                color={t.status === "paid" ? "text-cyan" : "text-gold"}
                status={t.status === "paid" ? "paid" : "pending"}
              />
            ))
          ) : (
            <div className="flex flex-col items-center gap-4 py-8 text-center">
              <img src="/mascot.png" alt="Seven" className="size-20 object-contain drop-shadow-lg" />
              <div>
                <p className="text-sm font-extrabold">No activity yet</p>
                <p className="text-xs text-muted-foreground mt-1">Completed trades appear here</p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Earnings */}
      {activeTab === 2 && (
        <div className="px-5 mt-4 space-y-3">

          {/* Next payout banner */}
          {earningsLoading ? (
            <div className="h-24 bg-card rounded-3xl border border-border animate-pulse" />
          ) : earnings ? (
            <div className={`rounded-3xl p-4 border ${earnings.eligibleThisWeek ? "bg-jungle/20 border-cyan/30" : "bg-card border-border"}`}>
              <div className="flex items-center gap-3">
                <div className={`size-11 rounded-2xl grid place-items-center ${earnings.eligibleThisWeek ? "bg-cyan/20" : "bg-secondary"}`}>
                  <CalendarClock className={`size-5 ${earnings.eligibleThisWeek ? "text-cyan" : "text-muted-foreground"}`} />
                </div>
                <div className="flex-1">
                  <p className="text-sm font-extrabold">
                    {earnings.eligibleThisWeek ? "₦500 Coming Thursday! 🎉" : "Earn ₦500 This Thursday"}
                  </p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    {earnings.eligibleThisWeek
                      ? `You've traded ₦${earnings.weeklyVolumeNgn.toLocaleString()} this week — payout at 7pm on Thursday`
                      : "Trade ₦7,000+ this week to qualify for the Thursday payout"}
                  </p>
                </div>
                {earnings.eligibleThisWeek && (
                  <div className="text-right shrink-0">
                    <p className="text-xl font-extrabold text-cyan">₦500</p>
                    <p className="text-[9px] text-cyan/60 font-semibold">incoming</p>
                  </div>
                )}
              </div>
              {!earnings.eligibleThisWeek && (
                <div className="mt-3 bg-secondary rounded-xl h-1.5 overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-gold to-amber-400 rounded-full transition-all"
                    style={{ width: `${Math.min(100, (earnings.weeklyVolumeNgn / 7000) * 100)}%` }}
                  />
                </div>
              )}
            </div>
          ) : null}

          {/* Total lifetime earnings */}
          {earnings && earnings.totalEarnedNgn > 0 && (
            <div className="bg-card rounded-3xl border border-border p-4 flex items-center gap-3">
              <div className="size-11 rounded-2xl bg-gold/15 grid place-items-center">
                <TrendingUp className="size-5 text-gold" />
              </div>
              <div className="flex-1">
                <p className="text-xs text-muted-foreground font-semibold">Total Commission Earned</p>
                <p className="text-lg font-extrabold text-gold">₦{earnings.totalEarnedNgn.toLocaleString()}</p>
              </div>
            </div>
          )}

          {/* Timeline */}
          {earningsLoading ? (
            [...Array(3)].map((_, i) => (
              <div key={i} className="h-16 bg-card rounded-2xl border border-border animate-pulse" />
            ))
          ) : earnings && earnings.entries.length > 0 ? (
            <>
              <p className="text-xs text-muted-foreground font-bold uppercase tracking-wider">Commission History</p>
              {earnings.entries.map((e) => (
                <div key={e.id} className="bg-card rounded-2xl border border-border/60 p-4 flex items-center gap-3">
                  <div className={`size-10 rounded-xl grid place-items-center shrink-0 ${e.type === "weekly_commission" ? "bg-gold/15" : "bg-cyan/15"}`}>
                    {e.type === "weekly_commission"
                      ? <CalendarClock className="size-4 text-gold" />
                      : <Users className="size-4 text-cyan" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold truncate">{e.label}</p>
                    <p className="text-[11px] text-muted-foreground">{e.sub}</p>
                  </div>
                  <p className={`text-sm font-extrabold shrink-0 ${e.type === "weekly_commission" ? "text-gold" : "text-cyan"}`}>
                    +₦{e.amount_ngn.toLocaleString()}
                  </p>
                </div>
              ))}
            </>
          ) : (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <div className="size-16 rounded-3xl bg-card border border-border grid place-items-center">
                <TrendingUp className="size-8 text-muted-foreground" />
              </div>
              <div>
                <p className="text-sm font-bold">No earnings yet</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Trade ₦7,000+ this week for your first ₦500 Thursday payout
                </p>
              </div>
            </div>
          )}
        </div>
      )}

      {showCryptoSoon && <CryptoComingSoonModal onClose={() => setShowCryptoSoon(false)} />}
    </div>
  );
}

function CircleBtn({ icon: Icon, label, onClick }: { icon: React.ComponentType<{ className?: string }>; label: string; onClick?: () => void }) {
  return (
    <button onClick={onClick} className="flex flex-col items-center gap-1.5">
      <div className="size-11 rounded-full bg-white/10 backdrop-blur grid place-items-center border border-white/15">
        <Icon className="size-5 text-white" />
      </div>
      <span className="text-[10px] text-white/80 font-semibold">{label}</span>
    </button>
  );
}

/* ─────────────────────────────────── PROFILE ─────────────────────────────────── */

function ProfileScreen({
  profile, xp, emailVerified, userEmail, userId, onSignOut, onNavigateKYC, onNavigatePayout, onNavigateReferral, onNavigatePremium, onNavigateSupport, onNavigateLeague, onNavigateAdmin,
}: {
  profile?: ProfileData | null; xp?: XPData; emailVerified?: boolean; userEmail?: string; userId?: string; onSignOut: () => void; onNavigateKYC: () => void; onNavigatePayout: () => void; onNavigateReferral: () => void; onNavigatePremium: () => void; onNavigateSupport: () => void; onNavigateLeague?: () => void; onNavigateAdmin?: () => void;
}) {
  const moniker = profile?.display_name ?? (profile?.full_name ?? "").split(" ")[0] || "7Trader";
  const levelName = (xp?.level ?? 1) >= 15 ? "Boss" : (xp?.level ?? 1) >= 10 ? "Pro" : "Rookie";
  const avatarSeed = userId ?? profile?.id ?? moniker;
  const avatarUrl = `https://api.dicebear.com/9.x/bottts-neutral/svg?seed=${encodeURIComponent(avatarSeed)}&backgroundColor=transparent&radius=24`;
  const [avatarFailed, setAvatarFailed] = useState(false);

  return (
    <div className="flex flex-col">
      <header className="px-5 pt-safe-top pb-6 bg-gradient-hero rounded-b-[2rem] shadow-glow-jungle relative overflow-hidden">
        <div className="absolute -right-8 -top-8 size-40 rounded-full bg-gold/10 blur-2xl" />
        <h1 className="text-2xl font-extrabold text-white">Profile</h1>

        <div className="mt-5 flex items-center gap-4">
          <div className="size-20 rounded-3xl bg-gradient-gold overflow-hidden shadow-glow-gold shrink-0 flex items-center justify-center">
            {!avatarFailed ? (
              <img
                src={avatarUrl}
                alt={moniker}
                className="size-20 object-cover"
                onError={() => setAvatarFailed(true)}
              />
            ) : (
              <span className="font-extrabold text-jungle-deep text-3xl">{moniker[0]?.toUpperCase() ?? "7"}</span>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-lg font-extrabold text-white truncate">{moniker}</p>
            <p className="text-[11px] text-white/40 truncate mt-0.5 font-mono">ID verified • private account</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {emailVerified ? (
                <span className="px-2 py-0.5 rounded-full bg-green-500/20 text-green-400 text-[10px] font-bold flex items-center gap-1">
                  ✉️ Email Verified
                </span>
              ) : (
                <span className="px-2 py-0.5 rounded-full bg-orange-500/20 text-orange-400 text-[10px] font-bold flex items-center gap-1">
                  ✉️ Unverified
                </span>
              )}
              {profile?.kyc_status === "verified" ? (
                <span className="px-2 py-0.5 rounded-full bg-cyan/20 text-cyan text-[10px] font-bold flex items-center gap-1">
                  <ShieldCheck className="size-3" /> KYC Verified
                </span>
              ) : profile?.kyc_status === "submitted" ? (
                <span className="px-2 py-0.5 rounded-full bg-yellow-500/20 text-yellow-400 text-[10px] font-bold">
                  ⏳ KYC Pending
                </span>
              ) : null}
              {profile?.premium && (
                <span className="px-2 py-0.5 rounded-full bg-gold/20 text-gold text-[10px] font-bold flex items-center gap-1">
                  <Crown className="size-3" /> PRO
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-4 gap-2 text-center">
          <ProfStat n={String(xp?.tradeCount ?? 0)}        label="Trades" />
          <ProfStat n={(xp?.totalXp ?? 0).toLocaleString()} label="XP" />
          <ProfStat n={`Lv.${xp?.level ?? 1}`}             label={levelName} />
          <ProfStat n={xp?.weeklyRank ? `#${xp.weeklyRank}` : "—"} label="Rank" />
        </div>
      </header>

      <div className="px-5 mt-6 space-y-2">
        <MenuItem icon={Trophy}      label="The Hustle League"  sub={`Level ${xp?.level ?? 1} · ${levelName} · ${(xp?.streakDays ?? 0)}d streak`} tint="text-gold"   onClick={onNavigateLeague} />
        <MenuItem icon={Gift}        label="Referral Network"   sub="5% commission after 7 trades/month" tint="text-pink" onClick={onNavigateReferral} />
        <MenuItem icon={ShieldCheck} label="Security & KYC"     sub={profile?.kyc_status === "verified" ? "✅ Verified · Higher limits unlocked" : profile?.kyc_status === "submitted" ? "⏳ Under Review" : "Tap to verify — unlock $5,000 limit"} tint="text-cyan" onClick={onNavigateKYC} />
        <MenuItem icon={Wallet}      label="Payout Accounts"    sub="Manage bank accounts"           tint="text-orange" onClick={onNavigatePayout} />
        <MenuItem icon={MessageCircleIcon} label="Support & Help" sub={profile?.premium ? "Priority · replies in 1 hour" : "24/7 AI · 1-day human reply"} tint="text-gold" onClick={onNavigateSupport} />
        <MenuItem icon={Gamepad2}    label="Low Data Mode"      sub="Save bandwidth"                 tint="text-cyan" toggle storageKey="7sc_low_data_mode" />
        {onNavigateAdmin && (
          <MenuItem icon={ShieldCheck} label="Admin Panel" sub="Operator access" tint="text-red-400" onClick={onNavigateAdmin} />
        )}
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
          <button
            onClick={onNavigatePremium}
            className="mt-4 bg-gradient-gold text-jungle-deep font-bold px-4 py-2.5 rounded-xl text-sm shadow-glow-gold"
          >
            {profile?.premium ? "Manage Premium" : "Get Premium · ₦2,000/mo"}
          </button>
        </div>
      </div>

      <div className="px-5 mt-4">
        <button
          onClick={onSignOut}
          className="w-full bg-card border border-border rounded-2xl p-4 flex items-center gap-3 text-pink"
        >
          <div className="size-10 rounded-xl bg-pink/10 grid place-items-center">
            <LogOut className="size-5" />
          </div>
          <span className="text-sm font-semibold">Sign Out</span>
        </button>
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
  icon: Icon, label, sub, tint, toggle, onClick, storageKey,
}: {
  icon: React.ComponentType<{ className?: string }>; label: string; sub: string; tint: string; toggle?: boolean; onClick?: () => void; storageKey?: string;
}) {
  const [on, setOn] = useState<boolean>(() => {
    if (storageKey) {
      try {
        const stored = localStorage.getItem(storageKey);
        return stored !== null ? stored === "true" : true;
      } catch { return true; }
    }
    return true;
  });
  return (
    <button
      onClick={() => {
        if (toggle) {
          setOn((v) => {
            const next = !v;
            if (storageKey) { try { localStorage.setItem(storageKey, String(next)); } catch { /* ignore */ } }
            return next;
          });
        } else { onClick?.(); }
      }}
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

/* ─────────────────────────────────── VERIFY ─────────────────────────────────── */

type VState = "scanning" | "escrow" | "valid" | "invalid" | "processing" | "paid";

const NG_BANKS = [
  { code: "058", name: "GTBank" },
  { code: "011", name: "First Bank" },
  { code: "033", name: "UBA" },
  { code: "057", name: "Zenith Bank" },
  { code: "044", name: "Access Bank" },
  { code: "070", name: "Fidelity Bank" },
  { code: "035", name: "Wema Bank / ALAT" },
  { code: "076", name: "Polaris Bank" },
  { code: "032", name: "Union Bank" },
  { code: "039", name: "Stanbic IBTC" },
  { code: "050", name: "Ecobank" },
  { code: "068", name: "Standard Chartered" },
  { code: "082", name: "Keystone Bank" },
  { code: "030", name: "Heritage Bank" },
  { code: "301", name: "Jaiz Bank" },
  { code: "999991", name: "OPay" },
  { code: "999992", name: "PalmPay" },
  { code: "50515",  name: "Moniepoint MFB" },
  { code: "090110", name: "VFD Microfinance Bank" },
  { code: "120001", name: "9PSB (9mobile)" },
  { code: "000013", name: "GTBank (MFB)" },
  { code: "100004", name: "Opay (MFB)" },
];

const BRAND_LOGOS = [
  { name: "Apple",       emoji: "🍎", color: "from-slate-700 to-slate-900" },
  { name: "Amazon",      emoji: "📦", color: "from-orange-500 to-yellow-600" },
  { name: "Steam",       emoji: "🎮", color: "from-blue-700 to-indigo-900" },
  { name: "Google Play", emoji: "▶️", color: "from-emerald-600 to-teal-800" },
  { name: "Xbox",        emoji: "🟢", color: "from-green-700 to-green-900" },
  { name: "PlayStation", emoji: "🎯", color: "from-blue-600 to-blue-900" },
  { name: "Netflix",     emoji: "🎬", color: "from-red-700 to-red-950" },
  { name: "Spotify",     emoji: "🎵", color: "from-green-500 to-green-800" },
  { name: "Razer Gold",  emoji: "🟡", color: "from-yellow-500 to-green-700" },
  { name: "Sephora",     emoji: "💄", color: "from-pink-700 to-rose-900" },
  { name: "Nordstrom",   emoji: "🛍️", color: "from-neutral-600 to-neutral-900" },
];

function VerifyScreen({
  onBack, onDone, onNavigateSupport,
  tradeId, userId, cardCode, cardPin,
  brand, amountUsd, amountNgn, recipientEmail,
  payoutBankCode, payoutAccountNumber, payoutAccountName,
}: {
  onBack: () => void; onDone: () => void; onNavigateSupport?: () => void;
  tradeId: string | null; userId: string;
  cardCode: string; cardPin?: string;
  brand: string; amountUsd: number; amountNgn: number;
  recipientEmail: string;
  payoutBankCode?: string; payoutAccountNumber?: string; payoutAccountName?: string;
}) {
  const [state, setState] = useState<VState>("scanning");
  const [progress, setProgress] = useState(0);
  const [transactionRef, setTransactionRef] = useState<string | null>(null);
  const [failureReason, setFailureReason] = useState<string>("");
  const [escrowEndsAt, setEscrowEndsAt] = useState<number>(0);
  const [extended, setExtended] = useState(false);
  const queryClient = useQueryClient();
  const hasSavedBank = !!payoutAccountNumber && payoutAccountNumber !== "0000000000";
  const [bankEntry, setBankEntry] = useState({ bankCode: payoutBankCode ?? "", bankName: "", accountNumber: payoutAccountNumber ?? "" });
  const [resolvedName, setResolvedName] = useState<string | null>(hasSavedBank ? (payoutAccountName ?? null) : null);
  const [lookingUp, setLookingUp] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [bankConfirmed, setBankConfirmed] = useState(hasSavedBank);
  const [payoutTo, setPayoutTo] = useState<"bank" | "wallet">("bank");
  const activeBankCode    = bankConfirmed ? bankEntry.bankCode    : (payoutBankCode    ?? "058");
  const activeBankAccount = bankConfirmed ? bankEntry.accountNumber : (payoutAccountNumber ?? "0000000000");
  const activeBankName    = bankConfirmed ? (resolvedName ?? bankEntry.bankName) : (payoutAccountName ?? "Account");

  const handleBankLookup = async () => {
    if (!bankEntry.bankCode || bankEntry.accountNumber.length < 10) return;
    setLookingUp(true);
    setLookupError(null);
    setResolvedName(null);
    try {
      const res = await lookupAccount({ data: { bankCode: bankEntry.bankCode, accountNumber: bankEntry.accountNumber } });
      if ((res as { success: boolean }).success) {
        const name = (res as { accountName: string }).accountName;
        setResolvedName(name);
      } else {
        setLookupError((res as { error?: string }).error ?? "Could not verify account");
      }
    } catch {
      setLookupError("Account lookup failed — try again");
    } finally {
      setLookingUp(false);
    }
  };

  // ── Real verification on mount ────────────────────────────────────────────
  useEffect(() => {
    if (!tradeId || !cardCode) return;

    let progressInterval: ReturnType<typeof setInterval>;
    let stopped = false;

    const run = async () => {
      // Animate progress bar while calling Reloadly
      progressInterval = setInterval(() => {
        setProgress((p) => Math.min(85, p + 2));
      }, 80);

      try {
        const result = await verifyGiftCard({
          data: {
            tradeId,
            cardCode,
            cardPin,
            brand,
            amountUsd,
            recipientEmail,
          },
        });

        if (stopped) return;
        clearInterval(progressInterval);
        setProgress(100);

        if ((result as { success: boolean }).success) {
          setState("escrow");
          setEscrowEndsAt(Date.now() + 5 * 60_000);
          setProgress(0);
        } else {
          setFailureReason((result as { reason?: string }).reason ?? "Verification failed");
          setState("invalid");
        }
      } catch {
        if (stopped) return;
        clearInterval(progressInterval);
        setFailureReason("Verification service unavailable");
        setState("invalid");
      }
    };

    run();
    return () => {
      stopped = true;
      clearInterval(progressInterval);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tradeId]);

  // ── Escrow extension ──────────────────────────────────────────────────────
  const handleExtend = () => {
    setExtended(true);
    setEscrowEndsAt(Date.now() + 3 * 60_000);
  };

  // ── Real payout when user clicks "Redeem & Credit Wallet" ────────────────
  const handlePayout = async () => {
    if (!tradeId) return;
    setState("processing");
    setProgress(0);

    let progressInterval = setInterval(() => {
      setProgress((p) => Math.min(90, p + 2));
    }, 100);

    try {
      const result = await processPayout({
        data: { tradeId, payoutMethod: payoutTo },
      });

      clearInterval(progressInterval);
      setProgress(100);

      if ((result as { success: boolean }).success) {
        setTransactionRef((result as { transactionRef?: string }).transactionRef ?? null);
        // Invalidate caches so Home/Wallet show updated balance
        queryClient.invalidateQueries({ queryKey: ["wallets", userId] });
        queryClient.invalidateQueries({ queryKey: ["trades", userId] });
        queryClient.invalidateQueries({ queryKey: ["xp", userId] });
        queryClient.invalidateQueries({ queryKey: ["portfolio", userId] });
        queryClient.invalidateQueries({ queryKey: ["notifications", userId] });
        // Save the bank account for next time if it was entered ad-hoc
        if (!hasSavedBank && bankConfirmed && resolvedName) {
          const bank = NG_BANKS.find(b => b.code === bankEntry.bankCode);
          addPayoutAccount({
            data: {
              bankCode: bankEntry.bankCode,
              bankName: bank?.name ?? bankEntry.bankCode,
              accountNumber: bankEntry.accountNumber,
              accountName: resolvedName,
              makeDefault: true,
            },
          }).catch(() => {});
          queryClient.invalidateQueries({ queryKey: ["payout-accounts", userId] });
        }
        setState("paid");
      } else {
        setFailureReason((result as { reason?: string }).reason ?? "Payout failed");
        setState("invalid");
      }
    } catch {
      clearInterval(progressInterval);
      setFailureReason("Payment service unavailable");
      setState("invalid");
    }
  };

  if (state === "escrow") {
    return (
      <EscrowScreen
        tradeId={tradeId}
        brand={brand}
        amountUsd={amountUsd}
        amountNgn={amountNgn}
        escrowEndsAt={escrowEndsAt}
        extended={extended}
        onExtend={handleExtend}
        onProceed={onDone}
        onSupport={onNavigateSupport}
      />
    );
  }

  const cfg = STATE_CONFIG[state];

  return (
    <div className="flex flex-col">
      <header className="px-5 pt-safe-top pb-3 flex items-center justify-between">
        <button onClick={onBack} className="size-10 rounded-full bg-card border border-border grid place-items-center">
          <ChevronLeft className="size-5" />
        </button>
        <div className="text-center">
          <p className="text-[10px] text-muted-foreground font-bold uppercase tracking-wider">Step 3 of 3</p>
          <p className="text-sm font-extrabold">Verification</p>
        </div>
        <button
          onClick={() => { setState("scanning"); setProgress(0); }}
          className="size-10 rounded-full bg-card border border-border grid place-items-center"
        >
          <RefreshCw className="size-4 text-muted-foreground" />
        </button>
      </header>

      {/* The Money Maker — central animation */}
      <div className="px-5 mt-2">
        <div
          className={`relative aspect-square rounded-[2.5rem] overflow-hidden border-2 transition-colors duration-500 ${cfg.borderClass}`}
          style={{ background: cfg.bg }}
        >
          {/* Speed lines */}
          <div className="absolute inset-0 opacity-40">
            {Array.from({ length: 12 }).map((_, i) => (
              <div
                key={i}
                className={`absolute left-1/2 top-1/2 h-px w-32 origin-left ${cfg.lineClass}`}
                style={{
                  transform: `rotate(${i * 30}deg) translateX(80px)`,
                  animation: `pulse-ring 1.6s ${i * 0.08}s ease-out infinite`,
                }}
              />
            ))}
          </div>

          {/* Pulsing aura rings */}
          <div className={`absolute inset-8 rounded-full border-2 ${cfg.ringClass} ${state === "scanning" ? "animate-ping" : ""}`} />
          <div className={`absolute inset-16 rounded-full border ${cfg.ringClass} opacity-60`} />

          {/* 7 gift cards rotating around the central 7 */}
          <div className="absolute inset-0 grid place-items-center">
            <div
              className="relative size-56"
              style={{
                animation: state === "scanning" || state === "processing" ? `spin-slow 6s linear infinite` : "none",
              }}
            >
              {BRAND_LOGOS.map((b, i) => {
                const n = BRAND_LOGOS.length;
                const angle = (i / n) * 2 * Math.PI - Math.PI / 2;
                const radius = 96;
                const x = Math.cos(angle) * radius;
                const y = Math.sin(angle) * radius;
                const rotateDeg = (i / n) * 360;
                return (
                  <div
                    key={b.name}
                    className={`absolute top-1/2 left-1/2 -mt-7 -ml-5 w-10 h-14 rounded-lg bg-gradient-to-br ${b.color} shadow-card flex flex-col items-center justify-center gap-0.5 ring-1 ring-white/30 overflow-hidden`}
                    style={{
                      transform: `translate(${x}px, ${y}px) rotate(${rotateDeg}deg)`,
                      animation: state === "scanning" ? `card-pulse 1.4s ${i * 0.15}s ease-in-out infinite` : "none",
                    }}
                  >
                    <div style={{ transform: `rotate(${-rotateDeg}deg)` }} className="flex flex-col items-center justify-center size-full">
                      {BRAND_LOGO_URLS[b.name] ? (
                        <img
                          src={BRAND_LOGO_URLS[b.name]}
                          alt={b.name}
                          className="size-6 object-contain drop-shadow-sm"
                          onError={(e) => {
                            (e.currentTarget as HTMLImageElement).style.display = "none";
                            const fb = (e.currentTarget as HTMLImageElement).nextElementSibling as HTMLElement | null;
                            if (fb) fb.style.display = "block";
                          }}
                        />
                      ) : null}
                      <span style={{ display: BRAND_LOGO_URLS[b.name] ? "none" : "block", fontSize: "1.1rem" }}>{b.emoji}</span>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Central 7 + status overlay */}
            <div className="absolute grid place-items-center">
              <div className="size-28 rounded-full bg-jungle-deep/80 backdrop-blur-md grid place-items-center ring-2 ring-gold/40 shadow-glow-gold">
                {cfg.centerIcon ?? <span className="text-6xl font-extrabold text-white font-display">7</span>}
              </div>
            </div>
          </div>

          {/* Status pill */}
          <div className="absolute top-4 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-full bg-black/40 backdrop-blur-md flex items-center gap-2 border border-white/15">
            <span className={`size-2 rounded-full ${cfg.dotClass} ${state === "scanning" || state === "processing" ? "animate-pulse" : ""}`} />
            <span className="text-[11px] font-bold text-white uppercase tracking-wider">{cfg.statusLabel}</span>
          </div>

          {/* Progress bar bottom */}
          {(state === "scanning" || state === "processing") && (
            <div className="absolute bottom-4 left-6 right-6">
              <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
                <div className={`h-full ${cfg.barClass} transition-all`} style={{ width: `${progress}%` }} />
              </div>
            </div>
          )}

          {/* Confetti for paid */}
          {state === "paid" && (
            <div className="absolute inset-0 pointer-events-none">
              {Array.from({ length: 24 }).map((_, i) => {
                const colors = ["bg-gold", "bg-cyan", "bg-pink", "bg-orange"];
                return (
                  <span
                    key={i}
                    className={`absolute size-2 rounded-sm ${colors[i % 4]}`}
                    style={{
                      left: `${(i * 37) % 100}%`,
                      top: `${10 + ((i * 53) % 70)}%`,
                      animation: `confetti 1.8s ${i * 0.05}s ease-out forwards`,
                    }}
                  />
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Status card */}
      <div className="px-5 mt-5">
        <div className="bg-card rounded-3xl border border-border p-5">
          <div className="flex items-start gap-3">
            <div className={`size-11 rounded-2xl grid place-items-center ${cfg.iconBg}`}>
              {cfg.smallIcon}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-base font-extrabold">{cfg.title}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{cfg.subtitle}</p>
            </div>
          </div>

          {/* Real trade details */}
          <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
            <DetailRow label="Brand" value={`${brand} USA`} />
            <DetailRow label="Card Value" value={`$${amountUsd}`} />
            <DetailRow label="Exchange Rate" value={`₦${(amountNgn / amountUsd).toLocaleString()} / $1`} />
            <DetailRow label="You Receive" value={`₦${amountNgn.toLocaleString()}`} highlight />
          </div>

          {state === "invalid" && (
            <div className="mt-4 p-3 rounded-2xl bg-pink/10 border border-pink/30 flex items-start gap-2">
              <XCircle className="size-4 text-pink shrink-0 mt-0.5" />
              <div>
                <p className="text-xs font-bold text-pink">Verification Failed</p>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  {failureReason || "Card could not be verified. Try a different card or contact support."}
                </p>
              </div>
            </div>
          )}

          {state === "paid" && (
            <div className="mt-4 p-3 rounded-2xl bg-cyan/10 border border-cyan/30">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-[10px] text-muted-foreground font-bold uppercase">Transaction ID</p>
                  <p className="text-xs font-mono font-bold text-cyan">{transactionRef ?? "—"}</p>
                </div>
                <button
                  onClick={() => transactionRef && navigator.clipboard?.writeText(transactionRef)}
                  className="size-8 rounded-lg bg-cyan/15 grid place-items-center text-cyan"
                >
                  <Copy className="size-3.5" />
                </button>
              </div>
              <p className="text-[11px] text-muted-foreground mt-2">
                ₦{amountNgn.toLocaleString()} credited · +50 XP earned
              </p>
            </div>
          )}
        </div>
      </div>

      {/* CTA buttons */}
      <div className="px-5 mt-5 space-y-2">
        {state === "valid" && (
          <>
            {/* Payout method selector */}
            <div className="flex gap-1 bg-secondary rounded-2xl p-1">
              <button
                onClick={() => setPayoutTo("bank")}
                className={`flex-1 py-2.5 rounded-xl text-xs font-bold transition ${payoutTo === "bank" ? "bg-gold text-jungle-deep" : "text-muted-foreground"}`}
              >
                🏦 Pay to Bank
              </button>
              <button
                onClick={() => setPayoutTo("wallet")}
                className={`flex-1 py-2.5 rounded-xl text-xs font-bold transition ${payoutTo === "wallet" ? "bg-cyan/20 text-cyan border border-cyan/30" : "text-muted-foreground"}`}
              >
                💰 Keep in Wallet
              </button>
            </div>

            {payoutTo === "wallet" && (
              <div className="space-y-3">
                <div className="bg-cyan/10 border border-cyan/20 rounded-2xl p-4 space-y-1">
                  <p className="text-xs font-extrabold text-cyan">Credit to your 7SEVEN wallet</p>
                  <p className="text-[11px] text-muted-foreground">₦{amountNgn.toLocaleString()} will be added instantly — no bank account needed. Withdraw to your bank any time.</p>
                </div>
                <button
                  onClick={handlePayout}
                  className="w-full bg-gradient-to-r from-cyan to-teal-500 text-jungle-deep font-extrabold py-4 rounded-2xl flex items-center justify-center gap-2 shadow-glow-jungle"
                >
                  Add ₦{amountNgn.toLocaleString()} to Wallet <Wallet className="size-5" />
                </button>
              </div>
            )}

            {/* Bank capture — only shown when bank method selected and no saved account */}
            {payoutTo === "bank" && !bankConfirmed && (
              <div className="bg-card rounded-3xl border border-border p-5 space-y-4">
                <div>
                  <p className="text-sm font-extrabold">Where should we send ₦{amountNgn.toLocaleString()}?</p>
                  <p className="text-xs text-muted-foreground mt-0.5">Enter your bank account to receive funds instantly — no KYC required.</p>
                </div>

                {/* Bank selector */}
                <select
                  value={bankEntry.bankCode}
                  onChange={(e) => {
                    const b = NG_BANKS.find(x => x.code === e.target.value);
                    setBankEntry(prev => ({ ...prev, bankCode: e.target.value, bankName: b?.name ?? "" }));
                    setResolvedName(null);
                    setLookupError(null);
                  }}
                  className="w-full bg-secondary rounded-xl px-4 py-3 text-sm outline-none"
                >
                  <option value="">Select your bank…</option>
                  {NG_BANKS.map(b => <option key={b.code} value={b.code}>{b.name}</option>)}
                </select>

                {/* Account number */}
                <div className="flex gap-2">
                  <input
                    type="tel"
                    inputMode="numeric"
                    maxLength={10}
                    placeholder="10-digit account number"
                    value={bankEntry.accountNumber}
                    onChange={(e) => {
                      setBankEntry(prev => ({ ...prev, accountNumber: e.target.value.replace(/\D/g, "") }));
                      setResolvedName(null);
                      setLookupError(null);
                    }}
                    className="flex-1 bg-secondary rounded-xl px-4 py-3 text-sm outline-none font-mono"
                  />
                  <button
                    disabled={lookingUp || !bankEntry.bankCode || bankEntry.accountNumber.length < 10}
                    onClick={handleBankLookup}
                    className="px-4 py-3 rounded-xl bg-gold/15 text-gold text-sm font-bold disabled:opacity-40"
                  >
                    {lookingUp ? <Loader2 className="size-4 animate-spin" /> : "Verify"}
                  </button>
                </div>

                {/* Resolved name */}
                {resolvedName && (
                  <div className="flex items-center justify-between bg-cyan/10 rounded-xl px-4 py-3">
                    <div>
                      <p className="text-[10px] text-muted-foreground font-bold uppercase">Account Name</p>
                      <p className="text-sm font-extrabold text-cyan">{resolvedName}</p>
                    </div>
                    <button
                      onClick={() => setBankConfirmed(true)}
                      className="bg-cyan text-jungle-deep font-extrabold text-xs px-4 py-2 rounded-xl"
                    >
                      Confirm
                    </button>
                  </div>
                )}

                {lookupError && (
                  <p className="text-xs text-red-400 font-semibold">{lookupError}</p>
                )}
              </div>
            )}

            {/* Payout CTA — only shown once bank is confirmed */}
            {payoutTo === "bank" && bankConfirmed && (
              <>
                <div className="text-center text-xs text-muted-foreground">
                  Paying to <span className="font-bold text-foreground">{resolvedName ?? payoutAccountName}</span>
                  <button onClick={() => { setBankConfirmed(false); setResolvedName(null); }} className="ml-2 text-cyan underline">
                    Change
                  </button>
                </div>
                <button
                  onClick={handlePayout}
                  className="w-full bg-gradient-gold text-jungle-deep font-extrabold py-4 rounded-2xl flex items-center justify-center gap-2 shadow-glow-gold"
                >
                  Receive ₦{amountNgn.toLocaleString()} Now <ChevronRight className="size-5" />
                </button>
              </>
            )}
          </>
        )}
        {state === "invalid" && (
          <button
            onClick={() => { setState("scanning"); setProgress(0); setFailureReason(""); }}
            className="w-full bg-pink text-white font-extrabold py-4 rounded-2xl flex items-center justify-center gap-2"
          >
            Try a Different Card
          </button>
        )}
        {state === "paid" && (
          <>
            <button
              onClick={onDone}
              className="w-full bg-gradient-gold text-jungle-deep font-extrabold py-4 rounded-2xl flex items-center justify-center gap-2 shadow-glow-gold"
            >
              View Wallet <Wallet className="size-5" />
            </button>
            <button
              onClick={() => { setState("scanning"); setProgress(0); }}
              className="w-full bg-card border border-border text-foreground font-semibold py-3 rounded-2xl"
            >
              Sell Another Card
            </button>
          </>
        )}
      </div>

      <style>{`
        @keyframes spin-slow { to { transform: rotate(360deg); } }
        @keyframes card-pulse {
          0%, 100% { transform: translate(var(--tw-translate-x, 0), var(--tw-translate-y, 0)) scale(1); }
          50% { filter: brightness(1.3) drop-shadow(0 0 8px rgba(255,215,0,0.6)); }
        }
        @keyframes confetti {
          0% { transform: translateY(-20px) rotate(0); opacity: 0; }
          20% { opacity: 1; }
          100% { transform: translateY(140px) rotate(720deg); opacity: 0; }
        }
      `}</style>
    </div>
  );
}

const STATE_CONFIG: Record<VState, {
  statusLabel: string; title: string; subtitle: string; bg: string;
  borderClass: string; borderActiveClass: string; ringClass: string;
  lineClass: string; dotClass: string; barClass: string;
  iconBg: string; smallIcon: React.ReactNode; centerIcon?: React.ReactNode;
}> = {
  scanning: {
    statusLabel: "Scanning",
    title: "Verifying your card…",
    subtitle: "Connecting to Reloadly · Takes ~10 seconds",
    bg: "radial-gradient(circle at 50% 50%, oklch(0.3 0.15 200 / 0.7), oklch(0.18 0.08 220) 70%)",
    borderClass: "border-cyan/60",
    borderActiveClass: "border-cyan text-cyan",
    ringClass: "border-cyan/60",
    lineClass: "bg-gradient-to-r from-cyan to-transparent",
    dotClass: "bg-cyan",
    barClass: "bg-gradient-to-r from-cyan to-blue-400",
    iconBg: "bg-cyan/15 text-cyan",
    smallIcon: <Loader2 className="size-5 animate-spin" />,
    centerIcon: <ScanLine className="size-14 text-cyan animate-pulse" strokeWidth={1.5} />,
  },
  valid: {
    statusLabel: "Verified",
    title: "Card verified ✓",
    subtitle: "Rate locked · Click below to receive your Naira",
    bg: "radial-gradient(circle at 50% 50%, oklch(0.4 0.18 150 / 0.5), oklch(0.18 0.08 160) 70%)",
    borderClass: "border-gold/60",
    borderActiveClass: "border-gold text-gold",
    ringClass: "border-gold/60",
    lineClass: "bg-gradient-to-r from-gold to-transparent",
    dotClass: "bg-gold",
    barClass: "bg-gradient-gold",
    iconBg: "bg-gold/15 text-gold",
    smallIcon: <CheckCircle2 className="size-5" />,
    centerIcon: <CheckCircle2 className="size-14 text-gold" strokeWidth={2} />,
  },
  invalid: {
    statusLabel: "Invalid",
    title: "Card could not be verified",
    subtitle: "The card may be redeemed, expired, or have zero balance",
    bg: "radial-gradient(circle at 50% 50%, oklch(0.35 0.2 10 / 0.5), oklch(0.18 0.08 10) 70%)",
    borderClass: "border-pink/60",
    borderActiveClass: "border-pink text-pink",
    ringClass: "border-pink/60",
    lineClass: "bg-gradient-to-r from-pink to-transparent",
    dotClass: "bg-pink",
    barClass: "bg-pink",
    iconBg: "bg-pink/15 text-pink",
    smallIcon: <XCircle className="size-5" />,
    centerIcon: <XCircle className="size-14 text-pink" strokeWidth={2} />,
  },
  processing: {
    statusLabel: "Paying Out",
    title: "Sending to your account…",
    subtitle: "Processing via Squad · Usually under 30 seconds",
    bg: "radial-gradient(circle at 50% 50%, oklch(0.45 0.18 60 / 0.5), oklch(0.18 0.08 50) 70%)",
    borderClass: "border-gold/60",
    borderActiveClass: "border-gold text-gold",
    ringClass: "border-gold/60",
    lineClass: "bg-gradient-to-r from-gold to-transparent",
    dotClass: "bg-gold",
    barClass: "bg-gradient-to-r from-gold to-orange",
    iconBg: "bg-gold/15 text-gold",
    smallIcon: <Loader2 className="size-5 animate-spin" />,
    centerIcon: <Loader2 className="size-14 text-gold animate-spin" strokeWidth={2.5} />,
  },
  paid: {
    statusLabel: "Paid",
    title: `Naira sent to your wallet 🎉`,
    subtitle: "Transaction complete",
    bg: "radial-gradient(circle at 50% 50%, oklch(0.5 0.2 145 / 0.55), oklch(0.18 0.08 160) 70%)",
    borderClass: "border-emerald-400/60",
    borderActiveClass: "border-emerald-400 text-emerald-400",
    ringClass: "border-emerald-400/60",
    lineClass: "bg-gradient-to-r from-emerald-400 to-transparent",
    dotClass: "bg-emerald-400",
    barClass: "bg-emerald-400",
    iconBg: "bg-emerald-400/15 text-emerald-400",
    smallIcon: <CheckCircle2 className="size-5" />,
    centerIcon: <Sparkles className="size-14 text-gold" strokeWidth={2.5} />,
  },
};

function DetailRow({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="bg-secondary/40 rounded-xl p-2.5">
      <p className="text-[10px] text-muted-foreground font-medium">{label}</p>
      <p className={`text-xs font-extrabold ${highlight ? "text-gold" : ""}`}>{value}</p>
    </div>
  );
}

/* ─────────────────────────────── WITHDRAW ─────────────────────────────── */

function WithdrawScreen({
  ngnBalance, payoutAccounts, onBack, onNavigatePayout,
}: {
  userId: string; ngnBalance: number; payoutAccounts: PayoutAccount[];
  onBack: () => void; onNavigatePayout: () => void;
}) {
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState("");
  const [step, setStep] = useState<"form" | "loading" | "success" | "error">("form");
  const [error, setError] = useState("");
  const [txRef, setTxRef] = useState("");

  const defaultAccount = payoutAccounts.find((a) => a.is_default) ?? payoutAccounts[0] ?? null;
  const amountNum = Number(amount.replace(/,/g, "")) || 0;
  const canWithdraw = amountNum >= 500 && amountNum <= ngnBalance && !!defaultAccount;
  const QUICK = [500, 1_000, 5_000, 10_000];

  const handleWithdraw = async () => {
    if (!canWithdraw || !defaultAccount) return;
    setStep("loading");
    setError("");
    try {
      const result = await requestUserWithdrawal({
        data: {
          amountNgn: amountNum,
          bankCode: defaultAccount.bank_code,
          accountNumber: defaultAccount.account_number,
          accountName: defaultAccount.account_name,
          bankName: defaultAccount.bank_name,
        },
      });
      setTxRef((result as { ref: string }).ref ?? "");
      await queryClient.invalidateQueries({ queryKey: ["wallets"] });
      setStep("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Withdrawal failed. Please try again.");
      setStep("error");
    }
  };

  if (step === "success") {
    return (
      <div className="flex flex-col min-h-dvh items-center justify-center px-6 text-center gap-6">
        <div className="size-24 rounded-full bg-emerald-500/15 border border-emerald-500/30 grid place-items-center">
          <CheckCircle2 className="size-12 text-emerald-400" />
        </div>
        <div>
          <p className="text-2xl font-extrabold">Withdrawal Sent!</p>
          <p className="text-sm text-muted-foreground mt-2">
            ₦{amountNum.toLocaleString()} is on its way to{" "}
            <span className="font-bold text-foreground">{defaultAccount?.account_name}</span>
            {" "}· {defaultAccount?.bank_name}
          </p>
          <p className="text-xs text-muted-foreground mt-1">Usually arrives within 5 minutes.</p>
          {txRef && <p className="text-[10px] text-muted-foreground mt-2 font-mono">Ref: {txRef}</p>}
        </div>
        <button
          onClick={onBack}
          className="bg-gradient-gold text-jungle-deep font-extrabold px-8 py-3.5 rounded-2xl shadow-glow-gold active:scale-[0.98] transition"
        >
          Back to Wallet
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col pb-28">
      {/* Header */}
      <header className="px-5 pt-safe-top pb-6 bg-gradient-hero rounded-b-[2rem] shadow-glow-jungle relative overflow-hidden">
        <div className="absolute -right-8 -top-8 size-40 rounded-full bg-gold/10 blur-2xl" />
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="size-10 rounded-2xl bg-white/10 grid place-items-center active:scale-90 transition">
            <ChevronLeft className="size-5 text-white" />
          </button>
          <h1 className="text-xl font-extrabold text-white">Withdraw</h1>
        </div>

        {/* Balance pill */}
        <div className="mt-5 bg-white/10 backdrop-blur rounded-2xl px-5 py-4 border border-white/15">
          <p className="text-xs text-white/60 font-medium">Available Balance</p>
          <p className="text-3xl font-extrabold text-white mt-0.5 tracking-tight">
            ₦{ngnBalance.toLocaleString()}
          </p>
        </div>
      </header>

      <div className="px-5 mt-6 space-y-5">
        {/* No bank account state */}
        {!defaultAccount ? (
          <div className="rounded-3xl bg-card border border-border p-6 text-center space-y-4">
            <div className="size-16 mx-auto rounded-2xl bg-gold/10 grid place-items-center">
              <Wallet className="size-8 text-gold" />
            </div>
            <div>
              <p className="font-extrabold text-base">Add a Bank Account First</p>
              <p className="text-xs text-muted-foreground mt-1.5">You need a saved Nigerian bank account to withdraw your Naira balance.</p>
            </div>
            <button
              onClick={onNavigatePayout}
              className="w-full bg-gradient-gold text-jungle-deep font-extrabold py-3.5 rounded-2xl shadow-glow-gold active:scale-[0.98] transition"
            >
              Add Bank Account →
            </button>
          </div>
        ) : (
          <>
            {/* Amount input */}
            <div>
              <p className="text-xs font-bold text-muted-foreground uppercase tracking-wide mb-3">Amount (₦)</p>
              <div className="bg-card border border-border rounded-2xl px-4 py-3.5 flex items-center gap-2">
                <span className="text-xl font-extrabold text-muted-foreground">₦</span>
                <input
                  type="number"
                  inputMode="numeric"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0"
                  min={500}
                  max={ngnBalance}
                  className="flex-1 bg-transparent text-2xl font-extrabold outline-none text-foreground placeholder-muted-foreground/40"
                />
                {amount && (
                  <button onClick={() => setAmount("")} className="text-muted-foreground">
                    <XCircle className="size-5" />
                  </button>
                )}
              </div>
              {amountNum > ngnBalance && (
                <p className="text-xs text-pink mt-1.5 font-semibold">Amount exceeds your balance</p>
              )}
              {amountNum > 0 && amountNum < 500 && (
                <p className="text-xs text-orange/80 mt-1.5 font-semibold">Minimum withdrawal is ₦500</p>
              )}
            </div>

            {/* Quick amounts */}
            <div className="grid grid-cols-4 gap-2">
              {QUICK.map((q) => (
                <button
                  key={q}
                  onClick={() => setAmount(String(q))}
                  disabled={q > ngnBalance}
                  className={`rounded-xl py-2 text-xs font-bold border transition active:scale-95 ${
                    amountNum === q
                      ? "bg-gold text-jungle-deep border-gold"
                      : "bg-card border-border text-muted-foreground disabled:opacity-40"
                  }`}
                >
                  ₦{q >= 1000 ? `${q / 1000}k` : q}
                </button>
              ))}
            </div>
            <button
              onClick={() => setAmount(String(ngnBalance))}
              disabled={ngnBalance < 500}
              className="w-full rounded-xl py-2 text-xs font-bold border border-dashed border-gold/40 text-gold bg-gold/5 active:scale-95 transition disabled:opacity-40"
            >
              Withdraw All · ₦{ngnBalance.toLocaleString()}
            </button>

            {/* Bank account card */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-bold text-muted-foreground uppercase tracking-wide">Sending To</p>
                <button onClick={onNavigatePayout} className="text-xs text-gold font-semibold">Change →</button>
              </div>
              <div className="bg-card border border-border rounded-2xl p-4 flex items-center gap-3">
                <div className="size-11 rounded-xl bg-cyan/15 grid place-items-center">
                  <Wallet className="size-5 text-cyan" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold truncate">{defaultAccount.account_name}</p>
                  <p className="text-xs text-muted-foreground">{defaultAccount.bank_name} · {defaultAccount.account_number}</p>
                </div>
                <CheckCircle2 className="size-5 text-cyan shrink-0" />
              </div>
            </div>

            {/* Error state */}
            {step === "error" && error && (
              <div className="bg-pink/10 border border-pink/30 rounded-2xl p-4 flex items-start gap-3">
                <AlertCircle className="size-5 text-pink shrink-0 mt-0.5" />
                <p className="text-sm text-pink font-semibold">{error}</p>
              </div>
            )}

            {/* Confirm button */}
            <button
              onClick={handleWithdraw}
              disabled={!canWithdraw || step === "loading"}
              className="w-full bg-gradient-gold text-jungle-deep font-extrabold py-4 rounded-2xl shadow-glow-gold flex items-center justify-center gap-2 disabled:opacity-50 active:scale-[0.98] transition text-base"
            >
              {step === "loading" ? (
                <><Loader2 className="size-5 animate-spin" /> Processing…</>
              ) : (
                <><Send className="size-5" /> Withdraw ₦{amountNum > 0 ? amountNum.toLocaleString() : "—"}</>
              )}
            </button>

            <p className="text-center text-[11px] text-muted-foreground">
              Powered by Squad · No withdrawal fee · Arrives within 5 mins
            </p>
          </>
        )}
      </div>
    </div>
  );
}

/* ─────────────────────────────── BOTTOM NAV ─────────────────────────────── */

function BottomNav({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }) {
  const items: { id: Tab; icon: React.ComponentType<{ className?: string }>; label: string }[] = [
    { id: "home",    icon: Home,   label: "Home" },
    { id: "league",  icon: Trophy, label: "League" },
    { id: "sell",    icon: Plus,   label: "Sell" },
    { id: "wallet",  icon: Wallet, label: "Wallet" },
    { id: "profile", icon: User,   label: "Profile" },
  ];

  return (
    <nav className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[480px] px-4 pb-safe-bottom pt-2 bg-gradient-to-t from-background via-background to-transparent z-50">
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
              <span className={`text-[10px] font-bold ${active ? "text-gold" : "text-muted-foreground"}`}>{it.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

/* ─────────────────────── CRYPTO COMING SOON MODAL ───────────────────────────── */

function ReceiveModal({ wallets: _w, onClose }: { wallets: WalletData[]; onClose: () => void }) {
  return <CryptoComingSoonModal onClose={onClose} />;
}
function SendModal({ wallets: _w2, onClose: _c2 }: { wallets: WalletData[]; onClose: () => void }) {
  return <CryptoComingSoonModal onClose={_c2} />;
}

function CryptoComingSoonModal({ onClose }: { onClose: () => void }) {
  const [email, setEmail] = React.useState("");
  const [submitted, setSubmitted] = React.useState(false);
  const [notifyLoading, setNotifyLoading] = React.useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setNotifyLoading(true);
    setTimeout(() => { setSubmitted(true); setNotifyLoading(false); }, 800);
  };

  const handlePushNotify = () => {
    if (typeof (window as unknown as { OneSignal?: { showNativePrompt: () => void } }).OneSignal !== "undefined") {
      (window as unknown as { OneSignal: { showNativePrompt: () => void } }).OneSignal.showNativePrompt();
    }
    setSubmitted(true);
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col max-w-[480px] mx-auto overflow-y-auto" style={{ background: "linear-gradient(160deg, #050e1a 0%, #071525 60%, #0a1e35 100%)" }}>
      {/* Close button */}
      <div className="px-5 pt-safe-modal flex justify-end">
        <button onClick={onClose} className="size-10 rounded-full bg-white/8 border border-white/10 grid place-items-center active:scale-95 transition">
          <XCircle className="size-5 text-white/60" />
        </button>
      </div>

      {/* Hero illustration */}
      <div className="flex flex-col items-center px-8 pt-4 pb-6 text-center relative">
        {/* Glow orbs */}
        <div className="absolute top-0 left-1/2 -translate-x-1/2 size-64 rounded-full bg-cyan/10 blur-3xl pointer-events-none" />
        <div className="absolute top-16 left-1/4 size-32 rounded-full bg-gold/8 blur-2xl pointer-events-none" />

        {/* Icon cluster */}
        <div className="relative mb-6">
          <div className="size-24 rounded-3xl bg-gradient-to-br from-cyan/20 to-blue-900/60 border border-cyan/25 grid place-items-center shadow-[0_0_40px_rgba(0,255,255,0.15)] relative">
            <Bitcoin className="size-12 text-cyan" />
          </div>
          {[
            { icon: "₿", color: "bg-orange-500", pos: "-top-3 -right-3" },
            { icon: "Ξ", color: "bg-indigo-500", pos: "-bottom-3 -right-4" },
            { icon: "₮", color: "bg-emerald-500", pos: "-bottom-3 -left-4" },
          ].map((b) => (
            <div key={b.icon} className={`absolute ${b.pos} size-9 rounded-2xl ${b.color} grid place-items-center font-extrabold text-white text-sm border-2 border-[#050e1a]`}>
              {b.icon}
            </div>
          ))}
        </div>

        <h1 className="text-2xl font-extrabold text-white leading-tight">
          Crypto Trading<br />
          <span className="text-cyan">Coming Soon</span>
        </h1>
        <p className="text-sm text-white/55 mt-3 leading-relaxed max-w-[300px]">
          We're building a secure, compliant digital asset experience tailored for Nigeria. Final testing and regulatory review in progress.
        </p>
      </div>

      {/* Progress */}
      <div className="px-8 mb-6">
        <div className="rounded-3xl bg-white/4 border border-white/8 p-4 space-y-3">
          {[
            { label: "Development Complete", detail: "Full feature build done", done: true },
            { label: "Security Audit", detail: "Infrastructure hardened & reviewed", done: true },
            { label: "Regulatory Review", detail: "Compliance & licensing in progress", done: true },
            { label: "Public Launch", detail: "Early access for waitlist first", done: false },
          ].map((step, i) => (
            <div key={step.label} className="flex items-center gap-3">
              <div className={`size-6 rounded-full border-2 grid place-items-center shrink-0 ${step.done ? "bg-gold border-gold" : "border-white/20 bg-white/5"}`}>
                {step.done ? (
                  <CheckCircle2 className="size-3.5 text-jungle-deep" />
                ) : (
                  <span className="text-[9px] font-bold text-white/40">{i + 1}</span>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className={`text-xs font-bold ${step.done ? "text-white" : "text-white/40"}`}>{step.label}</p>
                <p className="text-[10px] text-white/30">{step.detail}</p>
              </div>
            </div>
          ))}
          {/* Progress bar */}
          <div className="mt-1 h-1 rounded-full bg-white/10 overflow-hidden">
            <div className="h-full bg-gradient-to-r from-gold to-amber-400 rounded-full" style={{ width: "78%" }} />
          </div>
          <p className="text-[10px] text-white/40 text-center">78% complete · Targeting Q3 2026</p>
        </div>
      </div>

      {/* Waitlist */}
      <div className="px-8 pb-6">
        <div className="rounded-3xl bg-white/4 border border-white/8 p-5">
          <div className="flex items-center gap-2 mb-3">
            <Zap className="size-4 text-gold" />
            <p className="text-sm font-extrabold text-white">Get Early Access</p>
          </div>
          <p className="text-[11px] text-white/50 mb-4 leading-relaxed">
            Join the waitlist — first to access crypto trading, exclusive rates, and zero launch fees.
          </p>

          {submitted ? (
            <div className="flex flex-col items-center gap-3 py-4">
              <div className="size-14 rounded-full bg-cyan/15 border border-cyan/30 grid place-items-center">
                <CheckCircle2 className="size-7 text-cyan" />
              </div>
              <p className="text-sm font-extrabold text-white">You're on the list!</p>
              <p className="text-[11px] text-white/50 text-center">We'll notify you the moment crypto trading launches. You'll be among the first.</p>
            </div>
          ) : (
            <>
              <form onSubmit={handleSubmit} className="space-y-3 mb-3">
                <div className="bg-white/6 border border-white/12 rounded-2xl px-4 py-3 flex items-center gap-2">
                  <span className="text-white/30 text-sm">✉</span>
                  <input
                    type="email"
                    placeholder="your@email.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="flex-1 bg-transparent text-sm text-white placeholder-white/25 outline-none"
                  />
                </div>
                <button
                  type="submit"
                  disabled={notifyLoading || !email.trim()}
                  className="w-full py-3.5 rounded-2xl bg-gradient-to-r from-gold to-amber-400 text-jungle-deep font-extrabold text-sm flex items-center justify-center gap-2 disabled:opacity-50 active:scale-[0.98] transition"
                >
                  {notifyLoading ? <Loader2 className="size-4 animate-spin" /> : <><Bell className="size-4" /> Notify Me at Launch</>}
                </button>
              </form>

              <div className="relative flex items-center gap-3 mb-3">
                <div className="flex-1 h-px bg-white/10" />
                <span className="text-[10px] text-white/25 font-semibold">or</span>
                <div className="flex-1 h-px bg-white/10" />
              </div>

              <button
                onClick={handlePushNotify}
                className="w-full py-3 rounded-2xl bg-white/6 border border-white/12 text-white/70 font-semibold text-xs flex items-center justify-center gap-2 active:scale-[0.98] transition"
              >
                <Bell className="size-4 text-cyan" /> Enable Push Notifications
              </button>
            </>
          )}
        </div>
      </div>

      {/* Available Now */}
      <div className="px-8 pb-12">
        <div className="rounded-2xl bg-gold/10 border border-gold/20 p-4">
          <p className="text-xs font-extrabold text-gold mb-1.5">✅ Available Right Now</p>
          <p className="text-[11px] text-white/55 leading-relaxed">
            Sell gift cards → instant NGN payout to your bank. Fast rates, trusted vendors, zero delays.
          </p>
          <button onClick={onClose} className="mt-3 w-full py-2.5 rounded-xl bg-gold/20 border border-gold/30 text-gold font-extrabold text-xs active:scale-[0.98] transition">
            Sell Gift Cards Now →
          </button>
        </div>
      </div>
    </div>
  );
}
