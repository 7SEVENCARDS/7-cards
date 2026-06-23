import { createServerFn } from "@tanstack/react-start";
import { getServerSupabase } from "../lib/supabase.server";
import { requireUser } from "../lib/auth-server";
import { getAppUrl } from "../lib/constants";
import { getEnv } from "../lib/worker-env";

const PREMIUM_PRICE_NGN  = 2000;
const PREMIUM_PRICE_KOBO = PREMIUM_PRICE_NGN * 100;

// ─── Get own subscription status ──────────────────────────────────────────────
export const getPremiumStatus = createServerFn({ method: "GET" })
  .validator((d: { userId?: string }) => d)
  .handler(async () => {
    const userId = await requireUser();
    const db = getServerSupabase();

    const { data: profile } = await db
      .from("profiles")
      .select("premium")
      .eq("id", userId)
      .single();

    const { data: sub } = await db
      .from("subscriptions")
      .select("*")
      .eq("user_id", userId)
      .eq("status", "active")
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    return {
      isPremium: profile?.premium ?? false,
      subscription: sub ?? null,
    };
  });

// ─── Create Squadco checkout link for premium subscription ────────────────────
// Email and name are read server-side from the authenticated profile —
// never accepted from the client to prevent account hijacking.
export const createPremiumCheckout = createServerFn({ method: "POST" })
  .validator((d: Record<string, never>) => d)
  .handler(async () => {
    const userId = await requireUser();
    const db = getServerSupabase();

    // Read email and name from server-side profile
    const { data: profile } = await db
      .from("profiles")
      .select("full_name, email")
      .eq("id", userId)
      .single();

    const email = profile?.email ?? `${userId}@7evencards.xyz`; // fallback for accounts without email
    const name  = profile?.full_name ?? "7SEVEN User";

    const transactionRef = `7SC-PREM-${userId.slice(0, 8)}-${Date.now()}`;

    try {
      const { createPaymentLink } = await import("../lib/squadco");

      const expiresAt = new Date();
      expiresAt.setMonth(expiresAt.getMonth() + 1);

      await db.from("subscriptions").upsert({
        user_id: userId,
        plan: "premium",
        status: "pending",
        amount_ngn: PREMIUM_PRICE_NGN,
        transaction_ref: transactionRef,
        expires_at: expiresAt.toISOString(),
      }, { onConflict: "transaction_ref", ignoreDuplicates: true });

      const result = await createPaymentLink({
        amountKobo: PREMIUM_PRICE_KOBO,
        transactionRef,
        email,
        name,
        description: "7SEVEN Premium — Monthly",
        redirectUrl: `${getAppUrl()}/premium/success`,
      });

      return { success: true, demo: false, checkoutUrl: result.checkoutUrl, transactionRef };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const isConfig = msg.includes("not configured");

      if (isConfig) {
        if (getEnv("IS_DEMO_MODE") !== "true") {
          return { success: false, error: "Payment service not configured." };
        }
        return { success: true, demo: true, checkoutUrl: null, transactionRef };
      }

      return { success: false, error: msg };
    }
  });

// ─── Activate premium ─────────────────────────────────────────────────────────
// Production: ONLY callable from the HMAC-verified webhook (webhooks.ts).
// Development: callable by the authenticated user for demo testing.
export const activatePremium = createServerFn({ method: "POST" })
  .validator((d: { transactionRef?: string; paymentRef?: string }) => d)
  .handler(async ({ data }) => {
    if (getEnv("IS_DEMO_MODE") !== "true") {
      return { success: false, error: "Premium activation must be triggered by the payment webhook." };
    }

    const userId = await requireUser();
    const db = getServerSupabase();

    const expiresAt = new Date();
    expiresAt.setMonth(expiresAt.getMonth() + 1);

    const { error } = await db.from("subscriptions").insert({
      user_id: userId,
      plan: "premium",
      status: "active",
      amount_ngn: PREMIUM_PRICE_NGN,
      transaction_ref: data.transactionRef ?? `7SC-DEMO-${userId.slice(0, 8)}-${Date.now()}`,
      payment_ref: data.paymentRef ?? null,
      started_at: new Date().toISOString(),
      expires_at: expiresAt.toISOString(),
    });

    if (error) return { success: false, error: error.message };

    await db.from("profiles").update({ premium: true }).eq("id", userId);

    await db.from("notifications").insert({
      user_id: userId,
      title: "Welcome to 7SEVEN Premium! 🚀",
      message: "You now have access to higher payout limits, +2% better rates, and priority support. Your subscription renews monthly.",
      type: "success",
    });

    return { success: true };
  });

// ─── Cancel premium ────────────────────────────────────────────────────────────
export const cancelPremium = createServerFn({ method: "POST" })
  .validator((d: Record<string, never>) => d)
  .handler(async () => {
    const userId = await requireUser();
    const db = getServerSupabase();

    await db
      .from("subscriptions")
      .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
      .eq("user_id", userId)
      .eq("status", "active");

    await db.from("profiles").update({ premium: false }).eq("id", userId);

    await db.from("notifications").insert({
      user_id: userId,
      title: "Premium Cancelled",
      message: "Your Premium subscription has been cancelled. You'll keep access until the end of your billing period.",
      type: "info",
    });

    return { success: true };
  });
