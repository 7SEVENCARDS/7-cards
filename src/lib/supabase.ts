import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

if (!supabaseUrl || supabaseUrl.includes("YOUR_PROJECT")) {
  console.warn("[7SEVEN] Supabase not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env");
}

// ─── Client-side Supabase (uses anon key, respects RLS) ───────────────────────
export const supabase = createClient(
  supabaseUrl || "https://placeholder.supabase.co",
  supabaseAnonKey || "placeholder",
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
    },
  }
);

// ─── Types ────────────────────────────────────────────────────────────────────
export type Profile = {
  id: string;
  full_name: string;
  phone: string | null;
  avatar_url: string | null;
  kyc_status: "pending" | "submitted" | "verified" | "rejected";
  premium: boolean;
  referral_code: string;
  created_at: string;
};

export type Wallet = {
  id: string;
  user_id: string;
  currency: "NGN" | "BTC" | "USDT" | "ETH";
  balance: number;
  locked_balance: number;
  updated_at: string;
};

export type Trade = {
  id: string;
  user_id: string;
  type: "gift_card" | "crypto";
  brand: string | null;
  amount_usd: number | null;
  amount_ngn: number | null;
  exchange_rate: number | null;
  status: "pending" | "scanning" | "verified" | "invalid" | "processing" | "paid" | "failed";
  failure_reason: string | null;
  xp_earned: number;
  settled_at: string | null;
  created_at: string;
};

export type ExchangeRate = {
  brand: string;
  region: string;
  rate_per_dollar: number;
  trend: string;
  updated_at: string;
};

export type UserXP = {
  user_id: string;
  total_xp: number;
  level: number;
  streak_days: number;
  trade_count: number;
  weekly_xp: number;
};

export type LeaderboardEntry = {
  id: string;
  full_name: string;
  avatar_url: string | null;
  total_xp: number;
  weekly_xp: number;
  level: number;
  streak_days: number;
  trade_count: number;
  weekly_rank: number;
  all_time_rank: number;
};

export type Notification = {
  id: string;
  title: string;
  message: string;
  read: boolean;
  type: "info" | "success" | "warning" | "error";
  created_at: string;
};

export type PayoutAccount = {
  id: string;
  bank_name: string;
  bank_code: string;
  account_number: string;
  account_name: string;
  is_default: boolean;
};
