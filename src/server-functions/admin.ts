// ─────────────────────────────────────────────────────────────────────────────
// Admin Server Functions
// All functions call requireAdmin() which verifies the SESSION cookie.
// The caller never needs to (and must not) pass an adminId — the server
// derives the admin identity from the session.
//
// To make a user admin, run in Supabase SQL Editor:
//   UPDATE profiles SET role = 'admin' WHERE id = '<user-uuid>';
// ─────────────────────────────────────────────────────────────────────────────

import { createServerFn } from "@tanstack/react-start";
import { getServerSupabase } from "../lib/supabase.server";
import { requireAdmin, logAdminAction } from "../lib/auth-server";

// ─── Platform Stats ───────────────────────────────────────────────────────────
export const getAdminStats = createServerFn({ method: "GET" })
  .validator((d: Record<string, never>) => d)
  .handler(async () => {
    await requireAdmin();
    const db = getServerSupabase();

    const now = new Date();
    const dayStart   = new Date(now); dayStart.setHours(0, 0, 0, 0);
    const monthStart = new Date(now); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);

    const [
      { count: totalUsers },
      { count: totalTrades },
      { data: volumeRows },
      { count: pendingKyc },
      { count: manualReview },
      { count: todayTrades },
    ] = await Promise.all([
      db.from("profiles").select("*", { count: "exact", head: true }),
      db.from("trades").select("*", { count: "exact", head: true }).eq("status", "paid"),
      db.from("trades").select("amount_ngn").eq("status", "paid").gte("settled_at", monthStart.toISOString()),
      db.from("profiles").select("*", { count: "exact", head: true }).eq("kyc_status", "submitted"),
      db.from("trades").select("*", { count: "exact", head: true }).eq("status", "pending_review"),
      db.from("trades").select("*", { count: "exact", head: true }).gte("created_at", dayStart.toISOString()),
    ]);

    const monthlyVolumeNgn = (volumeRows ?? []).reduce((s, t) => s + Number(t.amount_ngn ?? 0), 0);

    return {
      totalUsers: totalUsers ?? 0,
      totalPaidTrades: totalTrades ?? 0,
      monthlyVolumeNgn: Math.round(monthlyVolumeNgn),
      pendingKycCount: pendingKyc ?? 0,
      manualReviewCount: manualReview ?? 0,
      todayTradeCount: todayTrades ?? 0,
    };
  });

// ─── Pending KYC Queue ────────────────────────────────────────────────────────
export const getKYCQueue = createServerFn({ method: "GET" })
  .validator((d: { limit?: number }) => d)
  .handler(async ({ data }) => {
    await requireAdmin();
    const db = getServerSupabase();
    const { data: profiles, error } = await db
      .from("profiles")
      .select("id, full_name, phone, kyc_status, kyc_bvn, kyc_nin, created_at")
      .eq("kyc_status", "submitted")
      .order("created_at", { ascending: true })
      .limit(data.limit ?? 50);

    if (error) throw error;
    return profiles ?? [];
  });

// ─── Approve KYC ─────────────────────────────────────────────────────────────
export const approveKYC = createServerFn({ method: "POST" })
  .validator((d: { userId: string; note?: string }) => d)
  .handler(async ({ data }) => {
    const adminId = await requireAdmin();
    const db = getServerSupabase();

    await db.from("profiles").update({ kyc_status: "verified" }).eq("id", data.userId);

    await db.from("notifications").insert({
      user_id: data.userId,
      title: "KYC Approved! ✅",
      message: data.note ?? "Your identity has been verified by our team. You can now trade without limits.",
      type: "success",
    });

    try {
      const { pushNotify } = await import("../lib/onesignal");
      pushNotify(data.userId, "KYC Approved! ✅", "Identity confirmed — start trading now.");
    } catch { /* non-critical */ }

    await logAdminAction(adminId, "kyc_approve", data.userId, { note: data.note });
    return { success: true };
  });

// ─── Reject KYC ──────────────────────────────────────────────────────────────
export const rejectKYC = createServerFn({ method: "POST" })
  .validator((d: { userId: string; reason: string }) => d)
  .handler(async ({ data }) => {
    const adminId = await requireAdmin();
    const db = getServerSupabase();

    await db.from("profiles").update({ kyc_status: "rejected" }).eq("id", data.userId);

    await db.from("notifications").insert({
      user_id: data.userId,
      title: "KYC Needs Attention",
      message: `Your KYC submission was not approved: ${data.reason}. Please re-submit with correct details.`,
      type: "error",
    });

    try {
      const { pushNotify } = await import("../lib/onesignal");
      pushNotify(data.userId, "KYC Needs Attention", data.reason);
    } catch { /* non-critical */ }

    await logAdminAction(adminId, "kyc_reject", data.userId, { reason: data.reason });
    return { success: true };
  });

// ─── Manual Review Queue ──────────────────────────────────────────────────────
export const getManualReviewQueue = createServerFn({ method: "GET" })
  .validator((d: { limit?: number }) => d)
  .handler(async ({ data }) => {
    await requireAdmin();
    const db = getServerSupabase();

    const { data: trades, error } = await db
      .from("trades")
      .select(`
        id, brand, region, amount_usd, amount_ngn, card_code,
        reloadly_transaction_id, status, requires_manual_review, created_at,
        direct_vendor_id, batch_id, batch_position,
        profiles!inner(id, full_name, phone, kyc_status)
      `)
      .eq("status", "pending_review")
      .order("created_at", { ascending: true })
      .limit(data.limit ?? 50);

    if (error) throw error;
    return trades ?? [];
  });

// ─── Approve Manual Trade ─────────────────────────────────────────────────────
// P0-1 fix: race-safe conditional UPDATE — only transitions from 'pending_review'.
// On success, sets status='verified' + clears requires_manual_review, then
// fires deferred vendor dispatch so the card enters the normal payout flow.
export const approveManualTrade = createServerFn({ method: "POST" })
  .validator((d: { tradeId: string }) => d)
  .handler(async ({ data }) => {
    const adminId = await requireAdmin();
    const db = getServerSupabase();

    // Race-safe: only update if still in pending_review state
    const { data: updated } = await db
      .from("trades")
      .update({ status: "verified", requires_manual_review: false })
      .eq("id", data.tradeId)
      .eq("status", "pending_review")       // guard: another admin hasn't already handled it
      .select("id, user_id, amount_ngn, brand, amount_usd, direct_vendor_id, batch_position, batch_id")
      .maybeSingle();

    if (!updated) {
      // Already handled (approved/rejected) by another admin — return gracefully
      return { success: false, reason: "Already handled by another admin or not in pending_review state." };
    }

    // Notify user
    await db.from("notifications").insert({
      user_id: updated.user_id,
      title: "Card Verified ✅",
      message: "Your gift card has been manually verified. Your payout is now being processed.",
      type: "success",
    });

    try {
      const { pushNotify } = await import("../lib/onesignal");
      pushNotify(updated.user_id, "Card Verified ✅", "Your card is verified. Payout is being processed.");
    } catch { /* non-critical */ }

    // Deferred vendor dispatch — fire-and-forget after returning success
    if (updated.direct_vendor_id) {
      Promise.resolve().then(async () => {
        try {
          const { directDispatchToVendor } = await import("./vendor-broadcast");
          await directDispatchToVendor({
            tradeId:       updated.id,
            vendorId:      updated.direct_vendor_id!,
            brand:         updated.brand,
            amountUsd:     Number(updated.amount_usd),
            amountNgn:     Number(updated.amount_ngn),
            batchPosition: updated.batch_position ?? 1,
            batchTotal:    1,
          });
        } catch (e) {
          console.error("[approveManualTrade] Deferred dispatch failed:", e);
        }
      });
    }

    await logAdminAction(adminId, "manual_trade_approve", data.tradeId, {
      dispatched: !!updated.direct_vendor_id,
    });
    return { success: true };
  });

// ─── Reject Manual Trade ──────────────────────────────────────────────────────
export const rejectManualTrade = createServerFn({ method: "POST" })
  .validator((d: { tradeId: string; reason: string }) => d)
  .handler(async ({ data }) => {
    const adminId = await requireAdmin();
    const db = getServerSupabase();

    const { data: trade } = await db
      .from("trades")
      .select("user_id")
      .eq("id", data.tradeId)
      .single();

    if (!trade) throw new Error("Trade not found");

    await db.from("trades").update({
      status: "invalid",
      failure_reason: data.reason,
      requires_manual_review: false,
    }).eq("id", data.tradeId);

    await db.from("notifications").insert({
      user_id: trade.user_id,
      title: "Card Rejected",
      message: `Your gift card was not accepted: ${data.reason}`,
      type: "error",
    });

    try {
      const { pushNotify } = await import("../lib/onesignal");
      pushNotify(trade.user_id, "Card Rejected", data.reason);
    } catch { /* non-critical */ }

    await logAdminAction(adminId, "manual_trade_reject", data.tradeId, { reason: data.reason });
    return { success: true };
  });

// ─── All Trades (paginated) ───────────────────────────────────────────────────
export const getAdminTrades = createServerFn({ method: "GET" })
  .validator((d: { page?: number; pageSize?: number; status?: string }) => d)
  .handler(async ({ data }) => {
    await requireAdmin();
    const db = getServerSupabase();

    const page = data.page ?? 0;
    const size = data.pageSize ?? 25;
    const from = page * size;
    const to = from + size - 1;

    let query = db
      .from("trades")
      .select(`
        id, type, brand, amount_usd, amount_ngn, status, failure_reason,
        requires_manual_review, squadco_transaction_ref, settled_at, created_at,
        profiles!inner(id, full_name, phone)
      `, { count: "exact" })
      .order("created_at", { ascending: false })
      .range(from, to);

    if (data.status && data.status !== "all") query = query.eq("status", data.status);

    const { data: trades, error, count } = await query;
    if (error) throw error;
    return { trades: trades ?? [], total: count ?? 0, page, pageSize: size };
  });

// ─── Manual NGN Credit (emergency / dispute resolution) ──────────────────────
export const adminCreditWallet = createServerFn({ method: "POST" })
  .validator((d: { userId: string; amountNgn: number; reason: string }) => d)
  .handler(async ({ data }) => {
    const adminId = await requireAdmin();
    const db = getServerSupabase();

    if (data.amountNgn <= 0 || data.amountNgn > 5_000_000) {
      return { success: false, error: "Amount must be between ₦1 and ₦5,000,000" };
    }

    await db.rpc("increment_wallet_balance", {
      p_user_id: data.userId,
      p_currency: "NGN",
      p_amount: data.amountNgn,
    });

    await db.from("notifications").insert({
      user_id: data.userId,
      title: "Wallet Credited",
      message: `₦${data.amountNgn.toLocaleString()} has been credited to your wallet. Reason: ${data.reason}`,
      type: "success",
    });

    await logAdminAction(adminId, "credit_wallet", data.userId, {
      amount_ngn: data.amountNgn,
      reason: data.reason,
    });
    return { success: true };
  });

// ─── Get all exchange rates ───────────────────────────────────────────────────
export const getAdminRates = createServerFn({ method: "GET" })
  .validator((d: Record<string, never>) => d)
  .handler(async () => {
    await requireAdmin();
    const db = getServerSupabase();

    const { data: rates, error } = await db
      .from("exchange_rates")
      .select("*")
      .eq("region", "USA")
      .order("brand");

    if (error) throw error;
    return rates ?? [];
  });

// ─── Update a single exchange rate ────────────────────────────────────────────
export const updateExchangeRate = createServerFn({ method: "POST" })
  .validator((d: { brand: string; region: string; ratePerDollar: number }) => d)
  .handler(async ({ data }) => {
    const adminId = await requireAdmin();
    const db = getServerSupabase();

    if (data.ratePerDollar < 100 || data.ratePerDollar > 10_000) {
      return { success: false, error: "Rate must be between ₦100 and ₦10,000 per dollar." };
    }

    const { data: prev } = await db
      .from("exchange_rates")
      .select("rate_per_dollar")
      .eq("brand", data.brand)
      .eq("region", data.region)
      .single();

    const prevRate = prev?.rate_per_dollar ? Number(prev.rate_per_dollar) : data.ratePerDollar;
    const changePct = prevRate > 0 ? ((data.ratePerDollar - prevRate) / prevRate) * 100 : 0;
    const trend = (changePct >= 0 ? "+" : "") + changePct.toFixed(1) + "%";

    const { error } = await db.from("exchange_rates").upsert(
      {
        brand: data.brand,
        region: data.region,
        rate_per_dollar: data.ratePerDollar,
        source: "admin",
        trend,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "brand,region" }
    );

    if (error) throw error;

    await logAdminAction(adminId, "rate_update", null, {
      brand: data.brand,
      region: data.region,
      from: prevRate,
      to: data.ratePerDollar,
      trend,
    });
    return { success: true, trend };
  });

// ─── Bulk update rates (CSV import) ──────────────────────────────────────────
export const bulkUpdateRates = createServerFn({ method: "POST" })
  .validator((d: { rows: Array<{ brand: string; region: string; ratePerDollar: number }> }) => d)
  .handler(async ({ data }) => {
    const adminId = await requireAdmin();
    const db = getServerSupabase();

    const results: Array<{ brand: string; ok: boolean; error?: string }> = [];
    const now = new Date().toISOString();

    for (const row of data.rows) {
      if (!row.brand.trim()) continue;
      if (row.ratePerDollar < 100 || row.ratePerDollar > 10_000) {
        results.push({ brand: row.brand, ok: false, error: "Rate out of range (₦100–₦10,000)" });
        continue;
      }
      const { error } = await db.from("exchange_rates").upsert(
        {
          brand: row.brand.trim(),
          region: row.region.trim() || "USA",
          rate_per_dollar: row.ratePerDollar,
          source: "admin",
          trend: "+0.0%",
          updated_at: now,
        },
        { onConflict: "brand,region" }
      );
      results.push(
        error
          ? { brand: row.brand, ok: false, error: error.message }
          : { brand: row.brand, ok: true }
      );
    }

    await logAdminAction(adminId, "bulk_rate_update", null, {
      total: data.rows.length,
      imported: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
    });

    return {
      success: true,
      imported: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    };
  });

// ─── Escrow Queue — all verified trades waiting for admin to process ──────────
export const getEscrowQueue = createServerFn({ method: "GET" })
  .validator((d: { limit?: number }) => d)
  .handler(async ({ data }) => {
    await requireAdmin();
    const db = getServerSupabase();
    const { data: trades, error } = await db
      .from("trades")
      .select(`
        id, brand, region, amount_usd, amount_ngn, card_code,
        status, requires_manual_review, created_at,
        profiles!inner(id, full_name, phone)
      `)
      .eq("status", "verified")
      .order("created_at", { ascending: true })
      .limit(data.limit ?? 100);
    if (error) throw error;
    return trades ?? [];
  });

// ─── Process Escrow Trade — admin confirms card redeemed, credits user ────────
export const processEscrowTrade = createServerFn({ method: "POST" })
  .validator((d: { tradeId: string }) => d)
  .handler(async ({ data }) => {
    const adminId = await requireAdmin();
    const db = getServerSupabase();

    const { data: trade } = await db
      .from("trades")
      .select("user_id, amount_ngn, brand, amount_usd")
      .eq("id", data.tradeId)
      .eq("status", "verified")
      .single();

    if (!trade) throw new Error("Trade not found or already processed");

    // Mark as processing so user's EscrowScreen detects it
    await db.from("trades")
      .update({ status: "processing" })
      .eq("id", data.tradeId);

    // Credit user's NGN wallet
    await db.rpc("increment_wallet_balance", {
      p_user_id: trade.user_id,
      p_currency: "NGN",
      p_amount: Number(trade.amount_ngn),
    });

    // Mark as paid with settlement timestamp
    await db.from("trades")
      .update({ status: "paid", settled_at: new Date().toISOString(), requires_manual_review: false })
      .eq("id", data.tradeId);

    // Notify user
    await db.from("notifications").insert({
      user_id: trade.user_id,
      title: "Card Redeemed! 💚",
      message: `Your ${trade.brand ?? "gift card"} ($${trade.amount_usd}) has been processed. ₦${Number(trade.amount_ngn).toLocaleString()} credited to your wallet.`,
      type: "success",
    });

    try {
      const { pushNotify } = await import("../lib/onesignal");
      pushNotify(
        trade.user_id,
        "Card Redeemed! 💚",
        `₦${Number(trade.amount_ngn).toLocaleString()} has been credited to your wallet.`
      );
    } catch { /* non-critical */ }

    await logAdminAction(adminId, "escrow_process", data.tradeId, {
      amount_ngn: trade.amount_ngn,
    });
    return { success: true };
  });

// ─── Spread revenue aggregation (admin only) ──────────────────────────────────
// ─── Audit Log Query ──────────────────────────────────────────────────────────
export const queryAuditLog = createServerFn({ method: "GET" })
  .validator((d: {
    tradeId?:   string;
    actorId?:   string;
    eventType?: string;
    limit?:     number;
    offset?:    number;
  }) => d)
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("../lib/auth-server");
    await requireAdmin();
    const db = getServerSupabase();

    let q = db
      .from("trade_audit_log")
      .select("id, trade_id, assignment_id, event, actor_type, actor_id, server_ts_ms, payload_hash, payload");

    if (data.tradeId)   q = (q as ReturnType<typeof q.eq>).eq("trade_id", data.tradeId);
    if (data.actorId)   q = (q as ReturnType<typeof q.eq>).eq("actor_id", data.actorId);
    if (data.eventType) q = (q as ReturnType<typeof q.eq>).eq("event", data.eventType);

    const limit  = Math.min(data.limit ?? 50, 200);
    const offset = data.offset ?? 0;
    q = (q as ReturnType<typeof q.order>)
      .order("server_ts_ms", { ascending: false })
      .range(offset, offset + limit - 1);

    const { data: entries, error } = await q;
    if (error) throw new Error(error.message);
    return { entries: entries ?? [] };
  });

// ─── Disputes Query ───────────────────────────────────────────────────────────
export const queryDisputes = createServerFn({ method: "GET" })
  .validator((d: {
    verdict?:  string;
    vendorId?: string;
    limit?:    number;
  }) => d)
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("../lib/auth-server");
    await requireAdmin();
    const db = getServerSupabase();

    let q = db.from("vendor_disputes").select(`
      id, vendor_id, trade_id, failure_reason,
      t_exposure_ms, t_redeemed_ms, t_audit_ms,
      verdict, verdict_at, auto_actioned,
      deposit_forfeited_ngn, auto_suspended,
      created_at,
      vendors(business_name, contact_name)
    `);

    if (data.verdict)  q = (q as ReturnType<typeof q.eq>).eq("verdict", data.verdict);
    if (data.vendorId) q = (q as ReturnType<typeof q.eq>).eq("vendor_id", data.vendorId);
    q = (q as ReturnType<typeof q.order>)
      .order("created_at", { ascending: false })
      .limit(Math.min(data.limit ?? 50, 100));

    const { data: disputes, error } = await q;
    if (error) throw new Error(error.message);
    return { disputes: disputes ?? [] };
  });

// ─── Vendor Rate Comparison Dashboard ────────────────────────────────────────
// Returns all active vendors with their current approved rate, any pending rate
// submission, and the last 10 rate history entries per vendor.
export const adminGetVendorRates = createServerFn({ method: "GET" })
  .validator((d: Record<string, never>) => d)
  .handler(async () => {
    const { requireAdmin } = await import("../lib/auth-server");
    await requireAdmin();
    const db = getServerSupabase();

    const { data: vendors, error } = await db
      .from("vendors")
      .select(`
        id, business_name, contact_name, tier, status,
        preferred_rate_ngn_per_usd,
        pending_rate_ngn_per_usd,
        pending_rate_submitted_at,
        pending_rate_history_id,
        rate_last_updated_at,
        last_rate_check_sent_at
      `)
      .eq("status", "active")
      .order("preferred_rate_ngn_per_usd", { ascending: false, nullsLast: true }) as {
        data: Array<{
          id: string; business_name: string; contact_name: string | null;
          tier: string; status: string;
          preferred_rate_ngn_per_usd: number | null;
          pending_rate_ngn_per_usd: number | null;
          pending_rate_submitted_at: string | null;
          pending_rate_history_id: string | null;
          rate_last_updated_at: string | null;
          last_rate_check_sent_at: string | null;
        }> | null;
        error: unknown;
      };

    if (error) throw new Error((error as Error).message);
    if (!vendors?.length) return { vendors: [] };

    // Fetch last 10 history entries for each vendor in one query
    const vendorIds = vendors.map(v => v.id);
    const { data: allHistory } = await db
      .from("vendor_rate_history")
      .select("id, vendor_id, old_rate, new_rate, changed_via, status, admin_notes, actioned_at, created_at")
      .in("vendor_id", vendorIds)
      .order("created_at", { ascending: false }) as {
        data: Array<{
          id: string; vendor_id: string; old_rate: number | null; new_rate: number;
          changed_via: string; status: string; admin_notes: string | null;
          actioned_at: string | null; created_at: string;
        }> | null;
      };

    // Group history by vendor (keep last 10 per vendor)
    const historyByVendor: Record<string, typeof allHistory> = {};
    for (const h of (allHistory ?? [])) {
      if (!historyByVendor[h.vendor_id]) historyByVendor[h.vendor_id] = [];
      if ((historyByVendor[h.vendor_id]?.length ?? 0) < 10) {
        historyByVendor[h.vendor_id]!.push(h);
      }
    }

    return {
      vendors: vendors.map(v => ({
        ...v,
        history: (historyByVendor[v.id] ?? []) as Array<{
          id: string; old_rate: number | null; new_rate: number;
          changed_via: string; status: string; admin_notes: string | null;
          actioned_at: string | null; created_at: string;
        }>,
      })),
    };
  });

// ─── Approve a pending vendor rate ───────────────────────────────────────────
export const adminApproveVendorRate = createServerFn({ method: "POST" })
  .validator((d: { vendorId: string; notes?: string }) => d)
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("../lib/auth-server");
    const adminId = await requireAdmin();
    const db = getServerSupabase();

    const { error } = await db.rpc("approve_vendor_rate", {
      p_vendor_id: data.vendorId,
      p_admin_id:  adminId,
      p_notes:     data.notes ?? null,
    });
    if (error) throw new Error(error.message);
    return { success: true };
  });

// ─── Reject a pending vendor rate ────────────────────────────────────────────
export const adminRejectVendorRate = createServerFn({ method: "POST" })
  .validator((d: { vendorId: string; notes?: string }) => d)
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("../lib/auth-server");
    const adminId = await requireAdmin();
    const db = getServerSupabase();

    const { error } = await db.rpc("reject_vendor_rate", {
      p_vendor_id: data.vendorId,
      p_admin_id:  adminId,
      p_notes:     data.notes ?? null,
    });
    if (error) throw new Error(error.message);
    return { success: true };
  });

// ─── Admin override: force-set a vendor's rate ───────────────────────────────
// Bypasses the pending queue — the rate is applied immediately.
// Creates a new vendor_rate_history row with changed_via='admin' and status='overridden'.
export const adminOverrideVendorRate = createServerFn({ method: "POST" })
  .validator((d: { vendorId: string; newRate: number; notes?: string }) => d)
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("../lib/auth-server");
    const adminId = await requireAdmin();
    const db = getServerSupabase();

    // Fetch current rate for the history delta
    const { data: vendor } = await db
      .from("vendors")
      .select("preferred_rate_ngn_per_usd, pending_rate_ngn_per_usd, pending_rate_history_id")
      .eq("id", data.vendorId)
      .single() as {
        data: {
          preferred_rate_ngn_per_usd: number | null;
          pending_rate_ngn_per_usd: number | null;
          pending_rate_history_id: string | null;
        } | null;
      };

    const oldRate = vendor?.preferred_rate_ngn_per_usd ?? null;

    // Mark any pending history row as overridden
    if (vendor?.pending_rate_history_id) {
      await db
        .from("vendor_rate_history")
        .update({ status: "overridden", approved_by: adminId, actioned_at: new Date().toISOString(), admin_notes: "(superseded by admin override)" })
        .eq("id", vendor.pending_rate_history_id);
    }

    // Apply rate and clear any pending submission
    await db.from("vendors").update({
      preferred_rate_ngn_per_usd: data.newRate,
      rate_last_updated_at:       new Date().toISOString(),
      pending_rate_ngn_per_usd:   null,
      pending_rate_submitted_at:  null,
      pending_rate_history_id:    null,
    }).eq("id", data.vendorId);

    // Write approved override to history
    await db.from("vendor_rate_history").insert({
      vendor_id:   data.vendorId,
      old_rate:    oldRate,
      new_rate:    data.newRate,
      changed_via: "admin",
      status:      "approved",
      approved_by: adminId,
      actioned_at: new Date().toISOString(),
      admin_notes: data.notes ?? null,
    });

    return { success: true, newRate: data.newRate };
  });

// ─── Spread Revenue ───────────────────────────────────────────────────────────
export const getSpreadRevenue = createServerFn({ method: "GET" })
  .validator((d: { days?: number }) => d)
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("../lib/auth-server");
    await requireAdmin();
    const db = getServerSupabase();
    const days = data.days ?? 7;
    const since = new Date(Date.now() - days * 86_400_000).toISOString();

    const { data: rows, error } = await db
      .from("crypto_transactions")
      .select("created_at, meta, from_currency, to_currency, from_amount, to_amount")
      .eq("type", "swap")
      .eq("status", "completed")
      .gte("created_at", since)
      .order("created_at", { ascending: false });

    if (error) throw error;

    let totalFee = 0;
    const dailyMap: Record<string, number> = {};
    for (const row of rows ?? []) {
      const fee = Number((row.meta as Record<string, unknown>)?.company_fee ?? 0);
      totalFee += fee;
      const day = row.created_at.slice(0, 10);
      dailyMap[day] = (dailyMap[day] ?? 0) + fee;
    }

    const daily = Object.entries(dailyMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, fee]) => ({ date, fee }));

    return {
      totalFee,
      daily,
      recentSwaps: (rows ?? []).slice(0, 20).map((r) => ({
        date: r.created_at,
        from: r.from_currency,
        to: r.to_currency,
        fromAmount: r.from_amount,
        toAmount: r.to_amount,
        fee: Number((r.meta as Record<string, unknown>)?.company_fee ?? 0),
      })),
    };
  });

// ─── Role Management (super_admin only for writes) ────────────────────────────

export const adminListUsers = createServerFn({ method: "GET" })
  .validator((d: { search?: string; role?: string; page?: number }) => d)
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("../lib/auth-server");
    await requireAdmin();
    const db = getServerSupabase();

    const page   = Math.max(1, data.page ?? 1);
    const limit  = 40;
    const offset = (page - 1) * limit;

    let q = db
      .from("profiles")
      .select("id, full_name, phone, avatar_url, role, kyc_status, premium, created_at", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (data.role && data.role !== "all") {
      q = q.eq("role", data.role);
    }
    if (data.search) {
      const term = data.search.trim();
      q = q.or(`full_name.ilike.%${term}%,phone.ilike.%${term}%`);
    }

    const { data: rows, error, count } = await q;
    if (error) throw error;

    return { users: rows ?? [], total: count ?? 0, page, limit };
  });

export const adminSetRole = createServerFn({ method: "POST" })
  .validator((d: { targetUserId: string; newRole: string }) => d)
  .handler(async ({ data }) => {
    const { requireSuperAdmin, logAdminAction } = await import("../lib/auth-server");
    const adminId = await requireSuperAdmin();

    const VALID_ROLES = ["user", "admin", "support", "vendor", "super_admin"];
    if (!VALID_ROLES.includes(data.newRole)) {
      throw new Error("Invalid role value");
    }
    if (data.targetUserId === adminId) {
      throw new Error("You cannot change your own role");
    }

    const db = getServerSupabase();

    const { data: existing } = await db
      .from("profiles")
      .select("role, full_name")
      .eq("id", data.targetUserId)
      .single();

    if (!existing) throw new Error("User not found");

    const { error } = await db
      .from("profiles")
      .update({ role: data.newRole })
      .eq("id", data.targetUserId);

    if (error) throw error;

    await logAdminAction(adminId, "set_role", data.targetUserId, {
      prev_role: existing.role,
      new_role:  data.newRole,
      full_name: existing.full_name,
    });

    // Notify all Telegram-linked admins when a role is elevated to admin/super_admin.
    // Fire-and-forget — never block the response on notification delivery.
    if (["admin", "super_admin"].includes(data.newRole)) {
      const ROLE_EMOJI: Record<string, string> = {
        admin:       "🛡️",
        super_admin: "👑",
        vendor:      "🏪",
        support:     "💬",
        user:        "👤",
      };
      const emoji = ROLE_EMOJI[data.newRole] ?? "🔄";
      const name  = existing.full_name ?? data.targetUserId.slice(0, 8);
      void import("./admin-telegram").then(({ sendAdminNotification }) =>
        sendAdminNotification({
          itemType: "role_change",
          itemId:   data.targetUserId,
          text: [
            `${emoji} *Role Elevated*`,
            ``,
            `User: *${name}*`,
            `${existing.role} → *${data.newRole}*`,
            ``,
            `By admin: \`${adminId.slice(0, 8)}…\``,
            `At: ${new Date().toUTCString()}`,
          ].join("\n"),
        })
      ).catch(() => {/* swallow — notification is best-effort */});
    }

    return { success: true, prevRole: existing.role, newRole: data.newRole };
  });

// ─── Reconciliation Report ────────────────────────────────────────────────────
// Detects financial inconsistencies: stale assignments, missing settlements,
// and recent wallet ledger activity. Called from the admin Audit tab.

export const adminGetReconciliationReport = createServerFn({ method: "GET" })
  .validator((d: Record<string, never>) => d)
  .handler(async () => {
    await requireAdmin();
    const db = getServerSupabase();

    const since24h = new Date(Date.now() - 86_400_000).toISOString();

    const [unreconciledRes, staleRes, ledgerRes, statusRes] = await Promise.all([
      db.from("v_unreconciled_trades" as "trades").select("*", { count: "exact" }).limit(50),
      db.from("v_stale_assignments"   as "vendor_card_assignments").select("*", { count: "exact" }).limit(50),
      db.from("wallet_ledger" as "profiles").select("id", { count: "exact" }).gte("created_at", since24h),
      db.from("trades").select("status").in("status", ["verified","processing","paid","scanning","pending_review"]),
    ]);

    const tradeCounts: Record<string, number> = {};
    for (const t of statusRes.data ?? []) {
      tradeCounts[t.status] = (tradeCounts[t.status] ?? 0) + 1;
    }

    const unreconciledCount = unreconciledRes.count ?? 0;
    const staleCount        = staleRes.count ?? 0;

    return {
      ts:                   new Date().toISOString(),
      healthy:              unreconciledCount === 0 && staleCount === 0,
      unreconciledTrades:   { count: unreconciledCount, rows: unreconciledRes.data ?? [] },
      staleAssignments:     { count: staleCount,        rows: staleRes.data ?? [] },
      walletLedger24hCount: ledgerRes.count ?? 0,
      tradeStatusBreakdown: tradeCounts,
    };
  });

// ─── Admin Audit Log Query ────────────────────────────────────────────────────
// Queries admin_audit_log (admin write actions). Distinct from trade_audit_log
// (vendor/trade events). Supports filter by action type, admin, target, date.

export const queryAdminAuditLog = createServerFn({ method: "GET" })
  .validator((d: {
    action?:   string;
    adminId?:  string;
    targetId?: string;
    since?:    string;
    limit?:    number;
    offset?:   number;
  }) => d)
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("../lib/auth-server");
    await requireAdmin();
    const db = getServerSupabase();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q: any = db
      .from("admin_audit_log")
      .select("id, admin_id, action, target_id, meta, created_at", { count: "exact" });

    if (data.action   && data.action   !== "all") q = q.eq("action",    data.action);
    if (data.adminId  && data.adminId  !== "")    q = q.eq("admin_id",  data.adminId);
    if (data.targetId && data.targetId !== "")    q = q.eq("target_id", data.targetId);
    if (data.since)                               q = q.gte("created_at", data.since);

    const limit  = Math.min(data.limit ?? 50, 200);
    const offset = data.offset ?? 0;

    const { data: rows, error, count } = await q
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw new Error(error.message);
    return { entries: rows ?? [], total: count ?? 0 };
  });
