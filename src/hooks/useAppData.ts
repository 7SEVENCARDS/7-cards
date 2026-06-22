import { useQuery } from "@tanstack/react-query";
import { getUserWallets, getTotalPortfolioNgn, getNotifications } from "../server-functions/wallet";
import { getUserTrades } from "../server-functions/trades";
import { getExchangeRates } from "../server-functions/rates";
import { getUserXP, getLeaderboard, getUserBadges } from "../server-functions/leaderboard";

// ─── Exchange Rates ────────────────────────────────────────────────────────────
export function useExchangeRates() {
  return useQuery({
    queryKey: ["exchange-rates"],
    queryFn: () => getExchangeRates(),
    staleTime: 5 * 60 * 1000, // 5 min
    refetchInterval: 5 * 60 * 1000,
    enabled: typeof window !== "undefined",
  });
}

// ─── Wallet ───────────────────────────────────────────────────────────────────
export function useWallets(userId: string | undefined) {
  return useQuery({
    queryKey: ["wallets", userId],
    queryFn: () => getUserWallets({ data: { userId: userId! } }),
    enabled: !!userId,
    staleTime: 30_000,
  });
}

export function usePortfolioValue(userId: string | undefined) {
  return useQuery({
    queryKey: ["portfolio", userId],
    queryFn: () => getTotalPortfolioNgn({ data: { userId: userId! } }),
    enabled: !!userId,
    staleTime: 60_000,
  });
}

// ─── Trades ───────────────────────────────────────────────────────────────────
export function useRecentTrades(userId: string | undefined, limit = 5) {
  return useQuery({
    queryKey: ["trades", userId, limit],
    queryFn: () => getUserTrades({ data: { userId: userId!, limit } }),
    enabled: !!userId,
    staleTime: 30_000,
  });
}

// ─── XP & Leaderboard ─────────────────────────────────────────────────────────
export function useUserXP(userId: string | undefined) {
  return useQuery({
    queryKey: ["xp", userId],
    queryFn: () => getUserXP({ data: { userId: userId! } }),
    enabled: !!userId,
    staleTime: 60_000,
  });
}

export function useLeaderboard(limit = 20) {
  return useQuery({
    queryKey: ["leaderboard", limit],
    queryFn: () => getLeaderboard({ data: { limit } }),
    staleTime: 2 * 60 * 1000,
    enabled: typeof window !== "undefined",
  });
}

export function useUserBadges(userId: string | undefined) {
  return useQuery({
    queryKey: ["badges", userId],
    queryFn: () => getUserBadges({ data: { userId: userId! } }),
    enabled: !!userId,
    staleTime: 5 * 60 * 1000,
  });
}

// ─── Notifications ────────────────────────────────────────────────────────────
export function useNotifications(userId: string | undefined) {
  return useQuery({
    queryKey: ["notifications", userId],
    queryFn: () => getNotifications({ data: { userId: userId! } }),
    enabled: !!userId,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}
