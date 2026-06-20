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
      const apiKey = process.env.SQUADCO_API_KEY;
      const env    = process.env.SQUADCO_ENV || "sandbox";

      if (!apiKey || apiKey.includes("YOUR_")) {
        // Demo mode — return a mock checkout URL
        return {
          success: true,
          demo: true,
          checkoutUrl: null,
          transactionRef,
        };
      }

      const base = env === "production"
        ? "https://api-d.squadco.com"
        : "https://sandbox-api-d.squadco.com";

      const res = await fetch(`${base}/merchant/create-payment-link`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          amount: PREMIUM_PRICE_KOBO,
          currency: "NGN",
          transaction_ref: transactionRef,
          email: data.email,
          customer_name: data.name,
          payment_description: "7SEVEN Premium — Monthly",
          redirect_link: `${process.env.VITE_APP_URL || "https://7sevencards.app"}/premium/success`,
          pass_charge: false,
        }),
      });

      const json = await res.json() as { data?: { checkout_url?: string } };

      return {
        success: true,
        demo: false,
        checkoutUrl: json.data?.checkout_url ?? null,
        transactionRef,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
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
