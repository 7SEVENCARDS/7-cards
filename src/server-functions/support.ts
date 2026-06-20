import { createServerFn } from "@tanstack/react-start";
import { getServerSupabase } from "../lib/supabase.server";
import { requireUser } from "../lib/auth-server";

type Message = {
  id: string;
  user_id: string;
  sender: "user" | "agent";
  body: string;
  read: boolean;
  created_at: string;
};

// ─── Get own conversation history ─────────────────────────────────────────────
export const getSupportMessages = createServerFn({ method: "GET" })
  .validator((d: { userId?: string; limit?: number }) => d)
  .handler(async ({ data }) => {
    try {
      const userId = await requireUser();
      const db = getServerSupabase();
      const { data: messages, error } = await db
        .from("support_messages")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: true })
        .limit(data.limit ?? 50);

      if (error) throw error;

      await db
        .from("support_messages")
        .update({ read: true })
        .eq("user_id", userId)
        .eq("sender", "agent")
        .eq("read", false);

      return (messages ?? []) as Message[];
    } catch {
      return [] as Message[];
    }
  });

// ─── Send a user message + auto-reply ─────────────────────────────────────────
// isPremium is derived server-side from the profile — never trusted from client.
export const sendSupportMessage = createServerFn({ method: "POST" })
  .validator((d: { body: string }) => d)
  .handler(async ({ data }) => {
    try {
      const userId = await requireUser();
      const db = getServerSupabase();

      // Derive premium status from profile — not from client
      const { data: profile } = await db
        .from("profiles")
        .select("premium")
        .eq("id", userId)
        .single();
      const isPremium = profile?.premium ?? false;

      await db.from("support_messages").insert({
        user_id: userId,
        sender: "user",
        body: data.body,
      });

      const lower = data.body.toLowerCase();
      let reply = "";

      if (lower.includes("payout") || lower.includes("payment") || lower.includes("paid")) {
        reply = "Your payout is processed via Squadco and typically arrives within 5–10 minutes. If it's been longer than 30 minutes, please share your trade ID and we'll investigate immediately.";
      } else if (lower.includes("card") && (lower.includes("reject") || lower.includes("invalid") || lower.includes("fail"))) {
        reply = "Sorry to hear your card was rejected. This usually means the card has already been redeemed or the details were entered incorrectly. Double-check the code and PIN, then try again. If the issue persists, contact us with the card brand and amount.";
      } else if (lower.includes("kyc") || lower.includes("verify") || lower.includes("bvn") || lower.includes("nin")) {
        reply = "KYC verification is handled by Dojah and usually completes within a few seconds. If yours is stuck, please make sure your BVN/NIN matches your registered name exactly.";
      } else if (lower.includes("rate") || lower.includes("exchange")) {
        reply = "Our rates are updated in real time from the market. Premium members get an additional +2% on all rates. You can check the current rates on the Home screen.";
      } else if (lower.includes("account") || lower.includes("bank")) {
        reply = "You can add and manage your bank accounts under Profile → Payout Accounts. We support all Nigerian banks via Squadco.";
      } else if (lower.includes("premium") || lower.includes("subscription") || lower.includes("upgrade")) {
        reply = "7SEVEN Premium costs ₦2,000/month and gives you higher limits, +2% better rates, priority payouts, and 24/7 dedicated support. Upgrade from Profile → Get Premium.";
      } else if (lower.includes("referral") || lower.includes("friend") || lower.includes("bonus")) {
        reply = "You earn 5% commission on every trade your referrals complete. Check Profile → Referral Program for your unique code and earnings.";
      } else if (lower.includes("hello") || lower.includes("hi") || lower.includes("hey")) {
        reply = isPremium
          ? "Hello! 👋 Welcome back, PRO member. You have priority support — what can we help you with today?"
          : "Hello! 👋 Welcome to 7SEVEN support. How can we help you today?";
      } else {
        reply = isPremium
          ? "Thanks for reaching out. As a PRO member, your case is flagged as priority and a human agent will respond within 1 hour. Your message has been received."
          : "Thanks for reaching out! Our support team will review your message and respond within 24 hours. For faster resolution, PRO members get responses within 1 hour — upgrade under Profile → Get Premium.";
      }

      await db.from("support_messages").insert({
        user_id: userId,
        sender: "agent",
        body: reply,
      });

      return { success: true };
    } catch {
      return { success: false };
    }
  });

// ─── Get unread agent message count ───────────────────────────────────────────
export const getUnreadSupportCount = createServerFn({ method: "GET" })
  .validator((d: { userId?: string }) => d)
  .handler(async () => {
    try {
      const userId = await requireUser();
      const db = getServerSupabase();
      const { count } = await db
        .from("support_messages")
        .select("*", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("sender", "agent")
        .eq("read", false);
      return { count: count ?? 0 };
    } catch {
      return { count: 0 };
    }
  });
