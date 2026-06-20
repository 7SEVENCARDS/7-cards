import { createServerFn } from "@tanstack/react-start";
import { getServerSupabase } from "../lib/supabase.server";

const PREMIUM_PRICE_NGN = 2000;
const PREMIUM_PRICE_KOBO = PREMIUM_PRICE_NGN * 100;

// ─── Get subscription status ───────────────────────────────────────────────────
export const getPremiumStatus = createServerFn({ method: "GET" })
  .validator((d: { userId: string }) => d)
  .handler(async ({ data }) => {
    const db = getServerSupabase();

    const { data: profile } = await db
      .from("profiles")
      .select("premium")
      .eq("id", data.userId)
      .single();

    const { data: sub } = await db
      .from("subscriptions")
      .select("*")
      .eq("user_id", data.userId)
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
export const createPremiumCheckout = createServerFn({ method: "POST" })
  .validator((d: { userId: string; email: string; name: string }) => d)
  .handler(async ({ data }) => {
    const transactionRef = `7SC-PREM-${data.userId.slice(0, 8)}-${Date.now()}`;

    try {
      const { createPaymentLink } = await import("../lib/squadco");

      // Pre-create a pending subscription row so the webhook can find it
      const db = getServerSupabase();
      const expiresAt = new Date();
      expiresAt.setMonth(expiresAt.getMonth() + 1);

      await db.from("subscriptions").insert({
        user_id: data.userId,
        plan: "premium",
        status: "pending",
        amount_ngn: PREMIUM_PRICE_NGN,
        transaction_ref: transactionRef,
        expires_at: expiresAt.toISOString(),
      }).onConflict("transaction_ref").ignore();

      const result = await createPaymentLink({
        amountKobo: PREMIUM_PRICE_KOBO,
        transactionRef,
        email: data.email,
        name: data.name,
        description: "7SEVEN Premium — Monthly",
        redirectUrl: `${process.env.VITE_APP_URL ?? "https://7sevencards.app"}/premium/success`,
      });

      return {
        success: true,
        demo: false,
        checkoutUrl: result.checkoutUrl,
        transactionRef,
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const isConfig = msg.includes("not configured");

      if (isConfig) {
        return { success: true, demo: true, checkoutUrl: null, transactionRef };
      }

      return { success: false, error: msg };
    }
  });

// ─── Activate premium (demo mode / webhook) ───────────────────────────────────
export const activatePremium = createServerFn({ method: "POST" })
  .validator((d: { userId: string; transactionRef?: string; paymentRef?: string }) => d)
  .handler(async ({ data }) => {
    const db = getServerSupabase();

    const expiresAt = new Date();
    expiresAt.setMonth(expiresAt.getMonth() + 1);

    // Upsert subscription row
    const { error } = await db.from("subscriptions").insert({
      user_id: data.userId,
      plan: "premium",
      status: "active",
      amount_ngn: PREMIUM_PRICE_NGN,
      transaction_ref: data.transactionRef ?? `7SC-DEMO-${data.userId.slice(0, 8)}-${Date.now()}`,
      payment_ref: data.paymentRef ?? null,
      started_at: new Date().toISOString(),
      expires_at: expiresAt.toISOString(),
    });

    if (error) return { success: false, error: error.message };

    // profiles.premium is set by the DB trigger (sync_premium_flag)
    // but set directly too in case trigger isn't installed yet
    await db.from("profiles").update({ premium: true }).eq("id", data.userId);

    await db.from("notifications").insert({
      user_id: data.userId,
      title: "Welcome to 7SEVEN Premium! 🚀",
      message: "You now have access to higher payout limits, +2% better rates, and priority support. Your subscription renews monthly.",
      type: "success",
    });

    return { success: true };
  });

// ─── Cancel premium ────────────────────────────────────────────────────────────
export const cancelPremium = createServerFn({ method: "POST" })
  .validator((d: { userId: string }) => d)
  .handler(async ({ data }) => {
    const db = getServerSupabase();

    await db
      .from("subscriptions")
      .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
      .eq("user_id", data.userId)
      .eq("status", "active");

    await db.from("profiles").update({ premium: false }).eq("id", data.userId);

    await db.from("notifications").insert({
      user_id: data.userId,
      title: "Premium Cancelled",
      message: "Your Premium subscription has been cancelled. You'll keep access until the end of your billing period.",
      type: "info",
    });

    return { success: true };
  });
