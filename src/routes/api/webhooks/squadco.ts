// ─────────────────────────────────────────────────────────────────────────────
// Squadco Webhook Handler — VAN Payment Notifications
// Endpoint: POST /api/webhooks/squadco
//
// When a vendor's virtual account (VAN) receives a payment, Squadco sends a
// webhook here. We verify the signature, find the VAN by reference, credit
// the vendor wallet, and create a transaction record.
//
// Register this URL in Squadco Dashboard → Webhooks → Add Webhook URL.
// Set SQUADCO_WEBHOOK_SECRET (the webhook hash secret from Squadco dashboard).
// ─────────────────────────────────────────────────────────────────────────────

import { createAPIFileRoute } from "@tanstack/start/api";
import { createClient } from "@supabase/supabase-js";
import { createHmac } from "crypto";

function getDb() {
  const url = process.env.VITE_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

function verifySquadcoSignature(body: string, signature: string): boolean {
  const secret = process.env.SQUADCO_WEBHOOK_SECRET ?? "";
  if (!secret) return true; // skip verification if secret not configured
  const expected = createHmac("sha512", secret).update(body).digest("hex");
  return expected === signature;
}

async function creditVendorWallet(
  db: ReturnType<typeof getDb>,
  vendorId: string,
  vanId: string,
  amountReceived: number,
  reference: string
) {
  // Fetch current wallet
  const { data: wallet } = await db
    .from("vendor_wallets")
    .select("id, balance, total_funded")
    .eq("vendor_id", vendorId)
    .single();

  if (!wallet) return { ok: false, error: "Wallet not found" };

  const newBalance = Number(wallet.balance) + amountReceived;
  const newTotalFunded = Number(wallet.total_funded) + amountReceived;

  // Update wallet
  await db
    .from("vendor_wallets")
    .update({
      balance: newBalance,
      total_funded: newTotalFunded,
      updated_at: new Date().toISOString(),
    })
    .eq("vendor_id", vendorId);

  // Log transaction
  await db.from("vendor_transactions").insert({
    vendor_id: vendorId,
    type: "credit",
    amount: amountReceived,
    balance_after: newBalance,
    description: `VAN deposit received`,
    reference,
    virtual_account_id: vanId,
  });

  // Mark VAN as funded
  await db
    .from("vendor_virtual_accounts")
    .update({
      status: "funded",
      funded_at: new Date().toISOString(),
      amount_received: amountReceived,
    })
    .eq("id", vanId);

  return { ok: true, newBalance };
}

export const APIRoute = createAPIFileRoute("/api/webhooks/squadco")({
  POST: async ({ request }) => {
    const rawBody = await request.text();
    const signature = request.headers.get("x-squad-encrypted-body") ?? "";

    // Verify signature
    if (!verifySquadcoSignature(rawBody, signature)) {
      console.warn("[Squadco Webhook] Invalid signature");
      return new Response(JSON.stringify({ ok: false, error: "Invalid signature" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return new Response(JSON.stringify({ ok: false, error: "Invalid JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Squadco sends event type in payload.Event or payload.event
    const event = (payload.Event ?? payload.event ?? "") as string;
    console.log("[Squadco Webhook] Event:", event, "| Ref:", payload.transaction_ref ?? payload.TransactionRef);

    // Only handle virtual account payment events
    const isVanPayment =
      event === "virtual_account.transaction.successful" ||
      event === "payment.successful" ||
      event === "charge.success";

    if (!isVanPayment) {
      return new Response(JSON.stringify({ ok: true, skipped: true, event }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Extract key fields — Squadco payload shape varies slightly by product
    const data = (payload.data ?? payload) as Record<string, unknown>;
    const amountReceived = Number(
      data.transaction_amount ?? data.amount ?? data.Amount ?? 0
    ) / 100; // Squadco amounts are in kobo

    const squadcoRef = String(
      data.transaction_ref ?? data.TransactionRef ?? data.unique_id ?? ""
    );

    const customerIdentifier = String(
      data.customer_identifier ?? data.CustomerIdentifier ?? ""
    );

    if (!amountReceived || amountReceived <= 0) {
      return new Response(JSON.stringify({ ok: false, error: "Zero amount" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const db = getDb();

    // Look up VAN by Squadco ref or customer identifier (which is our internal reference)
    const { data: van } = await db
      .from("vendor_virtual_accounts")
      .select("id, vendor_id, status, amount_expected, reference")
      .or(`squadco_ref.eq.${squadcoRef},reference.eq.${customerIdentifier}`)
      .eq("status", "pending")
      .single();

    if (!van) {
      console.warn("[Squadco Webhook] VAN not found:", { squadcoRef, customerIdentifier });
      // Return 200 to prevent Squadco retry storms on unknown events
      return new Response(JSON.stringify({ ok: false, error: "VAN not found or already funded" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Idempotency: check if already processed
    const { data: existingTxn } = await db
      .from("vendor_transactions")
      .select("id")
      .eq("reference", squadcoRef)
      .single();

    if (existingTxn) {
      console.log("[Squadco Webhook] Already processed:", squadcoRef);
      return new Response(JSON.stringify({ ok: true, duplicate: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const result = await creditVendorWallet(
      db,
      van.vendor_id,
      van.id,
      amountReceived,
      squadcoRef
    );

    if (!result.ok) {
      console.error("[Squadco Webhook] Credit failed:", result.error);
      return new Response(JSON.stringify(result), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    console.log(
      `[Squadco Webhook] ✅ Credited vendor ${van.vendor_id} ₦${amountReceived.toLocaleString()} | new balance: ${result.newBalance}`
    );

    return new Response(
      JSON.stringify({ ok: true, vendorId: van.vendor_id, amountNgn: amountReceived }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  },

  // Allow Squadco to do GET ping checks
  GET: async () => {
    return new Response(JSON.stringify({ ok: true, service: "7SEVEN VAN Webhook" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  },
});
