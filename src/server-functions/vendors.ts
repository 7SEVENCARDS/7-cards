// ─────────────────────────────────────────────────────────────────────────────
// Vendor Server Functions
// Vendors are registered Supabase auth users with a row in the `vendors` table.
// Admin functions are co-located in admin.ts (use requireAdmin).
// ─────────────────────────────────────────────────────────────────────────────

import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { getServerSupabase } from "../lib/supabase.server";
import { requireUser, requireAdmin, requireVendorAuth } from "../lib/auth-server";
import { clientIp, assertNotRateLimited, rlKey } from "../lib/rate-limiter";
import {
  assertEmail, assertPassword, sanitizeStr, assertPhone,
} from "../lib/validate";

// ─── Types ────────────────────────────────────────────────────────────────────
type VendorProfile = {
  id: string;
  user_id: string;
  business_name: string;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  telegram_username: string | null;
  telegram_chat_id: number | null;
  bank_name: string | null;
  bank_code: string | null;
  account_number: string | null;
  account_name: string | null;
  status: "pending" | "active" | "suspended";
  tier: "standard" | "premium";
  total_redeemed: number;
  total_volume_ngn: number;
  last_active_at: string | null;
  created_at: string;
  // Security deposit & strike fields (migration 013)
  security_deposit_required: number;
  security_deposit_held: number;
  failed_assignments: number;
  consecutive_failures: number;
  last_failure_at: string | null;
  suspension_reason: string | null;
};

type CardAssignment = {
  id: string;
  vendor_id: string;
  trade_id: string | null;
  brand: string;
  region: string | null;
  amount_usd: number;
  amount_ngn: number | null;
  card_code: string;
  card_pin: string | null;
  status: "assigned" | "viewed" | "redeemed" | "failed" | "cancelled";
  telegram_sent: boolean;
  claimed_via_telegram: boolean;
  viewed_at: string | null;
  redeemed_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  van_account_number: string | null;
  van_bank_name: string | null;
  van_amount_ngn: number | null;
  van_paid: boolean;
  van_paid_at: string | null;
  van_squad_ref: string | null;
  notes: string | null;
  created_at: string;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function getVendorId(db: ReturnType<typeof getServerSupabase>, userId: string) {
  const { data } = await db.from("vendors").select("id, status").eq("user_id", userId).single();
  return data;
}

// Non-fatal Telegram notification sent to a vendor when an assignment fails.
async function notifyVendorFailure(
  db: ReturnType<typeof getServerSupabase>,
  vendorId: string,
  assignment: { brand: string; amount_usd: number },
  forfeitedNgn: number,
  consecutive: number,
  threshold: number,
  autoSuspended: boolean,
): Promise<void> {
  try {
    const { data: v } = await db
      .from("vendors")
      .select("telegram_chat_id, telegram_username, contact_name, business_name")
      .eq("id", vendorId)
      .single() as {
        data: {
          telegram_chat_id: number | null;
          telegram_username: string | null;
          contact_name: string | null;
          business_name: string;
        } | null;
      };
    const chatId = v?.telegram_chat_id ?? v?.telegram_username;
    if (!chatId) return;

    const name = v?.contact_name ?? v?.business_name ?? "Vendor";
    const lines: string[] = [
      autoSuspended ? `⛔ <b>Account Suspended</b>` : `⚠️ <b>Assignment Failed</b>`,
      ``,
      `Hi ${name},`,
      ``,
      `Your <b>${assignment.brand} $${assignment.amount_usd}</b> assignment has been marked as <b>failed</b>.`,
    ];

    if (forfeitedNgn > 0) {
      lines.push(``, `💸 <b>₦${forfeitedNgn.toLocaleString("en-NG")}</b> has been deducted from your security deposit.`);
    }

    if (autoSuspended) {
      lines.push(
        ``,
        `Your account is now <b>suspended</b> after ${consecutive} consecutive failed assignments.`,
        ``,
        `To appeal or reactivate, contact 7SEVEN support.`,
      );
    } else {
      lines.push(
        ``,
        `⚡ Strike <b>${consecutive}/${threshold}</b> — you will be auto-suspended at ${threshold} consecutive failures.`,
        ``,
        `Complete your next assignment successfully to reset your strike count.`,
      );
    }

    const { sendTelegramMessage } = await import("../lib/telegram");
    await sendTelegramMessage(chatId, lines.join("\n"), "HTML");
  } catch { /* non-fatal */ }
}

// ─── Admin: Register Vendor ───────────────────────────────────────────────────
// Vendor self-registration has been removed. Only admins can create vendor
// accounts. This prevents spam applications and ensures every vendor is
// manually vetted before receiving card assignments.
export const adminRegisterVendor = createServerFn({ method: "POST" })
  .validator(
    (d: {
      email: string;
      password: string;
      businessName: string;
      contactName: string;
      phone: string;
      referralCode?: string;
      securityDepositRequired?: number;
    }) => d
  )
  .handler(async ({ data }) => {
    await requireAdmin();

    // Sanitize and validate all fields before touching the DB
    const email        = assertEmail(data.email);
    const password     = assertPassword(data.password);
    const businessName = sanitizeStr(data.businessName, 200, "business name");
    const contactName  = sanitizeStr(data.contactName, 100, "contact name");
    const phone        = assertPhone(data.phone);

    const db = getServerSupabase();

    // Create Supabase auth user
    const { data: authData, error: authError } = await db.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });

    if (authError || !authData.user) {
      return { success: false, error: authError?.message ?? "Registration failed" };
    }

    const userId = authData.user.id;

    // Check if vendor already exists
    const { data: existing } = await db.from("vendors").select("id").eq("user_id", userId).single();
    if (existing) {
      return { success: false, error: "Account already exists" };
    }

    // Create vendor profile
    const { data: vendor, error: vendorError } = await db
      .from("vendors")
      .insert({
        user_id: userId,
        business_name: businessName,
        contact_name: contactName,
        phone,
        email,
        status: "pending",
      })
      .select("id")
      .single();

    if (vendorError || !vendor) {
      return { success: false, error: "Failed to create vendor profile" };
    }

    // Create vendor wallet
    await db.from("vendor_wallets").insert({ vendor_id: vendor.id });

    // Set admin-specified deposit requirement (default 0)
    if (data.securityDepositRequired && data.securityDepositRequired > 0) {
      await db
        .from("vendors")
        .update({ security_deposit_required: data.securityDepositRequired })
        .eq("id", vendor.id);
    }

    // Hook up referral if a referral code was provided
    if (data.referralCode) {
      try {
        const { data: referrer } = await db
          .from("vendors")
          .select("id")
          .eq("referral_code", data.referralCode.toUpperCase().trim())
          .single() as { data: { id: string } | null };
        if (referrer && referrer.id !== vendor.id) {
          await db.from("vendors").update({ referred_by: referrer.id }).eq("id", vendor.id);
          await db.from("vendor_referrals").insert({
            referrer_id: referrer.id,
            referred_id: vendor.id,
            bonus_amount_ngn: 2500,
          });
        }
      } catch { /* non-fatal — registration still succeeds */ }
    }

    return { success: true, vendorId: vendor.id };
  });

// ─── Vendor Login ─────────────────────────────────────────────────────────────
export const vendorLogin = createServerFn({ method: "POST" })
  .validator((d: { email: string; password: string }) => d)
  .handler(async ({ data }) => {
    // Validate before touching auth or the rate limiter
    const email = assertEmail(data.email);
    assertPassword(data.password);

    // 5 attempts per IP per minute — stops credential-stuffing
    const req = getRequest();
    const ip = req ? clientIp(req) : "unknown";
    assertNotRateLimited(rlKey("vendorLogin", ip), 5, 60_000);

    const db = getServerSupabase();

    const { data: authData, error } = await db.auth.signInWithPassword({
      email,
      password: data.password,
    });

    if (error || !authData.user) {
      return { success: false, error: error?.message ?? "Login failed" };
    }

    const userId = authData.user.id;
    const vendor = await getVendorId(db, userId);

    if (!vendor) {
      return { success: false, error: "No vendor account found for this email" };
    }

    return { success: true, status: vendor.status };
  });

// ─── Get Vendor Session ────────────────────────────────────────────────────────
export const getVendorSession = createServerFn({ method: "GET" })
  .validator((d: Record<string, never>) => d)
  .handler(async () => {
    try {
      const userId = await requireUser();
      const db = getServerSupabase();
      const { data: vendor } = await db
        .from("vendors")
        .select("*")
        .eq("user_id", userId)
        .single();
      if (!vendor) return { authenticated: false };
      return { authenticated: true, vendor: vendor as VendorProfile };
    } catch {
      return { authenticated: false };
    }
  });

// ─── Vendor Logout ────────────────────────────────────────────────────────────
export const vendorLogout = createServerFn({ method: "POST" })
  .validator((d: Record<string, never>) => d)
  .handler(async () => {
    const db = getServerSupabase();
    await db.auth.signOut();
    return { success: true };
  });

// ─── Get Vendor Profile ────────────────────────────────────────────────────────
export const getVendorProfile = createServerFn({ method: "GET" })
  .validator((d: Record<string, never>) => d)
  .handler(async () => {
    const userId = await requireUser();
    const db = getServerSupabase();

    const { data, error } = await db.from("vendors").select("*").eq("user_id", userId).single();
    if (error) throw error;
    return data as VendorProfile;
  });

// ─── Update Vendor Profile ─────────────────────────────────────────────────────
export const updateVendorProfile = createServerFn({ method: "POST" })
  .validator(
    (d: {
      businessName?: string;
      contactName?: string;
      phone?: string;
      telegramUsername?: string;
      bankName?: string;
      bankCode?: string;
      accountNumber?: string;
      accountName?: string;
    }) => d
  )
  .handler(async ({ data }) => {
    const userId = await requireUser();
    const db = getServerSupabase();

    const { error } = await db
      .from("vendors")
      .update({
        ...(data.businessName !== undefined && { business_name: data.businessName }),
        ...(data.contactName !== undefined && { contact_name: data.contactName }),
        ...(data.phone !== undefined && { phone: data.phone }),
        ...(data.telegramUsername !== undefined && {
          telegram_username: data.telegramUsername.replace(/^@/, ""),
        }),
        ...(data.bankName !== undefined && { bank_name: data.bankName }),
        ...(data.bankCode !== undefined && { bank_code: data.bankCode }),
        ...(data.accountNumber !== undefined && { account_number: data.accountNumber }),
        ...(data.accountName !== undefined && { account_name: data.accountName }),
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId);

    if (error) throw error;
    return { success: true };
  });

// ─── Get My Assignments ────────────────────────────────────────────────────────
export const getMyAssignments = createServerFn({ method: "GET" })
  .validator((d: { status?: string; limit?: number }) => d)
  .handler(async ({ data }) => {
    const userId = await requireVendorAuth(); // P0-3: throws 403 if suspended
    const db = getServerSupabase();

    const vendor = await getVendorId(db, userId);
    if (!vendor) throw new Error("Not a vendor");

    let query = db
      .from("vendor_card_assignments")
      .select("*")
      .eq("vendor_id", vendor.id)
      .order("created_at", { ascending: false })
      .limit(data.limit ?? 50);

    if (data.status) query = query.eq("status", data.status);

    const { data: rows, error } = await query;
    if (error) throw error;

    // Mark unviewed assigned cards as viewed
    const unviewed = (rows ?? []).filter((r) => r.status === "assigned");
    if (unviewed.length > 0) {
      await db
        .from("vendor_card_assignments")
        .update({ status: "viewed", viewed_at: new Date().toISOString() })
        .in(
          "id",
          unviewed.map((r) => r.id)
        );
    }

    // Update vendor last_active
    await db.from("vendors").update({ last_active_at: new Date().toISOString() }).eq("user_id", userId);

    return (rows ?? []) as CardAssignment[];
  });

// ─── Mark Assignment Complete ──────────────────────────────────────────────────
export const markAssignmentRedeemed = createServerFn({ method: "POST" })
  .validator((d: { assignmentId: string; notes?: string }) => d)
  .handler(async ({ data }) => {
    const userId = await requireVendorAuth(); // P0-3: throws 403 if suspended
    const db = getServerSupabase();

    const vendor = await getVendorId(db, userId);
    if (!vendor) throw new Error("Not a vendor");

    const { data: assignment, error: fetchErr } = await db
      .from("vendor_card_assignments")
      .select("*")
      .eq("id", data.assignmentId)
      .eq("vendor_id", vendor.id)
      .single();

    if (fetchErr || !assignment) throw new Error("Assignment not found");
    if (assignment.status === "redeemed") return { success: true };

    // Mark redeemed
    await db
      .from("vendor_card_assignments")
      .update({
        status: "redeemed",
        redeemed_at: new Date().toISOString(),
        notes: data.notes ?? assignment.notes,
        updated_at: new Date().toISOString(),
      })
      .eq("id", data.assignmentId);

    // Credit vendor wallet — atomic RPC prevents lost-update race
    const amountNgn = assignment.amount_ngn ?? 0;
    if (amountNgn > 0) {
      await db.rpc("increment_vendor_wallet_balance", {
        p_vendor_id: vendor.id,
        p_amount: amountNgn,
      });
      const { data: updWallet } = await db
        .from("vendor_wallets").select("balance").eq("vendor_id", vendor.id).single();
      await db.from("vendor_transactions").insert({
        vendor_id: vendor.id,
        type: "assignment_credit",
        amount: amountNgn,
        balance_after: updWallet?.balance ?? null,
        description: `Card redeemed: ${assignment.brand} ${assignment.amount_usd}`,
        assignment_id: data.assignmentId,
      });
    }

    // Update vendor stats
    const newTotalRedeemed = Number(assignment.total_redeemed ?? 0) + 1;
    await db
      .from("vendors")
      .update({
        total_redeemed: newTotalRedeemed,
        total_volume_ngn: (assignment.total_volume_ngn ?? 0) + Number(amountNgn),
        last_active_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId);

    // Reset consecutive-failure counter — clean redemption streak is good standing
    db.rpc("record_vendor_success", { p_vendor_id: vendor.id }).catch(() => {});

    // Check and pay referral bonus (non-fatal, fire-and-forget)
    checkReferralBonus(db, vendor.id, newTotalRedeemed).catch(() => {});

    return { success: true };
  });

// ─── Mark Assignment Failed ────────────────────────────────────────────────────
// Auto-suspends the vendor at 3 consecutive failures.
// Forfeits security deposit proportional to the assignment value.
// Notifies the vendor via DB notification + Telegram (non-fatal).
export const markAssignmentFailed = createServerFn({ method: "POST" })
  .validator((d: { assignmentId: string; reason: string }) => d)
  .handler(async ({ data }) => {
    const userId = await requireVendorAuth(); // P0-3: throws 403 if suspended
    const db = getServerSupabase();

    const vendor = await getVendorId(db, userId);
    if (!vendor) throw new Error("Not a vendor");

    // Fetch assignment to verify ownership and get value for forfeit calculation
    const { data: assignment, error: fetchErr } = await db
      .from("vendor_card_assignments")
      .select("id, brand, amount_usd, amount_ngn, status")
      .eq("id", data.assignmentId)
      .eq("vendor_id", vendor.id)
      .single();

    if (fetchErr || !assignment) throw new Error("Assignment not found");
    if (assignment.status === "failed") return { success: true, alreadyFailed: true };

    // Mark assignment failed
    await db
      .from("vendor_card_assignments")
      .update({
        status: "failed",
        failed_at: new Date().toISOString(),
        failure_reason: data.reason,
        updated_at: new Date().toISOString(),
      })
      .eq("id", data.assignmentId);

    // Record failure — auto-suspends at 3 consecutive failures
    const { data: failureResult } = await db.rpc("record_vendor_failure", {
      p_vendor_id: vendor.id,
    });
    const strike = failureResult as {
      consecutive_failures: number;
      threshold: number;
      auto_suspended: boolean;
      suspension_reason: string | null;
      deposit_held: number;
    } | null;

    const autoSuspended    = strike?.auto_suspended ?? false;
    const consecutive      = strike?.consecutive_failures ?? 1;
    const threshold        = strike?.threshold ?? 3;
    const depositHeld      = Number(strike?.deposit_held ?? 0);

    // ── Forfeit security deposit ────────────────────────────────────────────
    // Amount forfeited = assignment value, capped at actual deposit held.
    // The forfeited funds are retained by 7SEVEN to compensate the user/trade.
    const assignmentNgn = Number(assignment.amount_ngn ?? 0);
    let forfeitedAmount = 0;

    if (depositHeld > 0 && assignmentNgn > 0) {
      const { data: forfeited } = await db.rpc("forfeit_vendor_security_deposit", {
        p_vendor_id: vendor.id,
        p_amount: assignmentNgn,
      });
      forfeitedAmount = Number(forfeited ?? 0);

      if (forfeitedAmount > 0) {
        const { data: updWallet } = await db
          .from("vendor_wallets")
          .select("balance")
          .eq("vendor_id", vendor.id)
          .single();
        await db.from("vendor_transactions").insert({
          vendor_id: vendor.id,
          type: "security_deposit_forfeit",
          amount: forfeitedAmount,
          balance_after: updWallet?.balance ?? null,
          description: `Deposit forfeited: failed ${assignment.brand} $${assignment.amount_usd} (${data.reason})`,
          assignment_id: data.assignmentId,
        });
      }
    }

    // ── Build user-facing messages ──────────────────────────────────────────
    const remainingStr = autoSuspended
      ? "Your account has been suspended due to repeated failures. Contact support to appeal."
      : `You have ${threshold - consecutive} attempt(s) remaining before auto-suspension.`;

    const forfeitStr = forfeitedAmount > 0
      ? ` ₦${forfeitedAmount.toLocaleString("en-NG")} has been deducted from your security deposit.`
      : "";

    // DB notification for vendor (non-fatal)
    db.from("notifications").insert({
      user_id: userId,
      title: autoSuspended ? "Account Suspended ⛔" : "Assignment Failed ⚠️",
      message: `Your ${assignment.brand} $${assignment.amount_usd} assignment was marked failed: "${data.reason}".${forfeitStr} ${remainingStr}`,
      type: autoSuspended ? "error" : "warning",
    }).catch(() => {});

    // Telegram notification to vendor (non-fatal, fire-and-forget)
    notifyVendorFailure(db, vendor.id, assignment, forfeitedAmount, consecutive, threshold, autoSuspended).catch(() => {});

    // ── PILLAR 1: Log 'vendor_marked_failed' to the immutable ledger ─────────
    try {
      const { logTradeEvent } = await import("../lib/audit-log");
      await logTradeEvent(db, {
        tradeId:      null,
        assignmentId: data.assignmentId,
        event:        "vendor_marked_failed",
        actorType:    "vendor",
        actorId:      vendor.id,
        payload: {
          brand:              assignment.brand,
          amount_usd:         assignment.amount_usd,
          amount_ngn:         assignment.amount_ngn,
          failure_reason:     data.reason,
          forfeited_ngn:      forfeitedAmount,
          consecutive_strikes: consecutive,
          auto_suspended:     autoSuspended,
        },
      });
    } catch (e) {
      console.warn("[AuditLog] vendor_marked_failed log failed (non-fatal):", e instanceof Error ? e.message : e);
    }

    // ── PILLARS 2 & 3: Forensic fraud audit (fire-and-forget, non-fatal) ─────
    // Queries Reloadly right now with the same card code to determine whether
    // the card was redeemed AFTER T_Exposure (fraud) or was already dead
    // before delivery (system error). Verdict is written to vendor_disputes and
    // trade_audit_log. FRAUD_CONFIRMED auto-forfeits deposit + suspends account.
    try {
      const { runFraudAudit } = await import("../lib/fraud-detection");
      runFraudAudit(db, data.assignmentId, vendor.id, data.reason).catch(e =>
        console.error("[FraudAudit] Audit run failed:", e instanceof Error ? e.message : e)
      );
    } catch (e) {
      console.warn("[FraudAudit] Import failed (non-fatal):", e instanceof Error ? e.message : e);
    }

    return {
      success: true,
      autoSuspended,
      forfeitedAmount,
      consecutiveFailures: consecutive,
      remainingBeforeSuspension: Math.max(0, threshold - consecutive),
    };
  });

// ─── Get Vendor Wallet ─────────────────────────────────────────────────────────
export const getVendorWallet = createServerFn({ method: "GET" })
  .validator((d: Record<string, never>) => d)
  .handler(async () => {
    const userId = await requireVendorAuth(); // P0-3: throws 403 if suspended
    const db = getServerSupabase();

    const vendor = await getVendorId(db, userId);
    if (!vendor) throw new Error("Not a vendor");

    const [{ data: wallet }, { data: transactions }] = await Promise.all([
      db.from("vendor_wallets").select("*").eq("vendor_id", vendor.id).single(),
      db
        .from("vendor_transactions")
        .select("*")
        .eq("vendor_id", vendor.id)
        .order("created_at", { ascending: false })
        .limit(20),
    ]);

    return { wallet, transactions: transactions ?? [] };
  });

// ─── Get Active Virtual Accounts ──────────────────────────────────────────────
export const getActiveVirtualAccounts = createServerFn({ method: "GET" })
  .validator((d: Record<string, never>) => d)
  .handler(async () => {
    const userId = await requireVendorAuth(); // P0-3: throws 403 if suspended
    const db = getServerSupabase();

    const vendor = await getVendorId(db, userId);
    if (!vendor) throw new Error("Not a vendor");

    const { data } = await db
      .from("vendor_virtual_accounts")
      .select("*")
      .eq("vendor_id", vendor.id)
      .eq("status", "pending")
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false })
      .limit(5);

    return data ?? [];
  });

// ─── Provision Virtual Account ─────────────────────────────────────────────────
export const provisionVirtualAccount = createServerFn({ method: "POST" })
  .validator((d: { amountNgn: number }) => d)
  .handler(async ({ data }) => {
    const userId = await requireVendorAuth(); // P0-3: throws 403 if suspended
    const db = getServerSupabase();

    const { data: vendor } = await db
      .from("vendors")
      .select("id, business_name, email, phone, bank_code")
      .eq("user_id", userId)
      .single();

    if (!vendor) throw new Error("Not a vendor");

    const reference = `VAN-${vendor.id.slice(0, 8)}-${Date.now()}`;
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    // Try Squadco virtual account creation
    let accountNumber = "";
    let bankName = "Wema Bank";
    let bankCode = "035";
    let squadcoRef: string | null = null;

    const squadcoKey = process.env.SQUADCO_SECRET_KEY ?? process.env.SQUADCO_API_KEY;
    const squadcoBase =
      (process.env.SQUADCO_ENV || "sandbox") === "production"
        ? "https://api-d.squadco.com"
        : "https://sandbox-api-d.squadco.com";

    if (squadcoKey && !squadcoKey.includes("YOUR_")) {
      try {
        const res = await fetch(`${squadcoBase}/virtual-account`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${squadcoKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            customer_identifier: reference,
            bvn: "",
            first_name: vendor.business_name.split(" ")[0] ?? vendor.business_name,
            last_name: vendor.business_name.split(" ").slice(1).join(" ") || "Vendor",
            mobile_num: vendor.phone ?? "",
            email: vendor.email ?? `${vendor.id}@vendor.7evencards.xyz`,
          }),
        });
        const json = (await res.json()) as {
          success?: boolean;
          data?: {
            virtual_account_number?: string;
            bank_name?: string;
            bank_code?: string;
            unique_id?: string;
          };
        };
        if (json.success && json.data?.virtual_account_number) {
          accountNumber = json.data.virtual_account_number;
          bankName = json.data.bank_name ?? "Wema Bank";
          bankCode = json.data.bank_code ?? "035";
          squadcoRef = json.data.unique_id ?? null;
        }
      } catch { /* fall through to mock */ }
    }

    // Never return a fake account in production — fail loudly so ops is alerted.
    // Set SQUADCO_DEMO=true for local dev/sandbox testing only.
    if (!accountNumber) {
      const isDemoMode =
        process.env.SQUADCO_DEMO === "true" && process.env.NODE_ENV !== "production";
      if (!isDemoMode) {
        throw new Error(
          "Virtual account creation failed — Squad API unavailable. Check SQUADCO_SECRET_KEY and Squad dashboard."
        );
      }
      // Demo mode only — clearly labelled so the frontend can warn the user
      const seed = Date.now();
      accountNumber = String(9000000000 + (seed % 1000000000)).slice(0, 10);
      bankName = "DEMO — DO NOT USE";
      bankCode = "035";
      console.warn("[VAN] DEMO MODE: Returning fake virtual account. Do NOT use in production.");
    }

    const { data: van, error } = await db
      .from("vendor_virtual_accounts")
      .insert({
        vendor_id: vendor.id,
        account_number: accountNumber,
        bank_name: bankName,
        bank_code: bankCode,
        account_name: vendor.business_name + " / 7SEVEN",
        reference,
        squadco_ref: squadcoRef,
        amount_expected: data.amountNgn > 0 ? data.amountNgn : null,
        expires_at: expiresAt,
      })
      .select()
      .single();

    if (error) throw error;
    return van;
  });

// ─── Admin: List All Vendors ───────────────────────────────────────────────────
export const adminGetVendors = createServerFn({ method: "GET" })
  .validator((d: { status?: string }) => d)
  .handler(async ({ data }) => {
    const userId = await requireAdmin();
    const db = getServerSupabase();

    let query = db
      .from("vendors")
      .select("*, vendor_wallets(balance, total_funded)")
      .order("last_active_at", { ascending: false, nullsFirst: false });

    if (data.status) query = query.eq("status", data.status);

    const { data: vendors, error } = await query.limit(100);
    if (error) throw error;
    return vendors ?? [];
  });

// ─── Admin: Update Vendor Status ───────────────────────────────────────────────
export const adminUpdateVendorStatus = createServerFn({ method: "POST" })
  .validator((d: { vendorId: string; status: "active" | "pending" | "suspended"; notes?: string }) => d)
  .handler(async ({ data }) => {
    const userId = await requireAdmin();
    const db = getServerSupabase();

    await db
      .from("vendors")
      .update({
        status: data.status,
        ...(data.notes !== undefined && { notes: data.notes }),
        updated_at: new Date().toISOString(),
      })
      .eq("id", data.vendorId);

    return { success: true };
  });

// ─── Admin: Assign Card to Vendor ──────────────────────────────────────────────
export const adminAssignCard = createServerFn({ method: "POST" })
  .validator(
    (d: {
      vendorId: string;
      tradeId?: string;
      brand: string;
      amountUsd: number;
      amountNgn: number;
      cardCode: string;
      cardPin?: string;
      notifyTelegram?: boolean;
    }) => d
  )
  .handler(async ({ data }) => {
    const userId = await requireAdmin();
    const db = getServerSupabase();

    // Create assignment
    const { data: assignment, error } = await db
      .from("vendor_card_assignments")
      .insert({
        vendor_id: data.vendorId,
        trade_id: data.tradeId ?? null,
        brand: data.brand,
        amount_usd: data.amountUsd,
        amount_ngn: data.amountNgn,
        card_code: data.cardCode,
        card_pin: data.cardPin ?? null,
        assigned_by: userId,
        status: "assigned",
      })
      .select("id")
      .single();

    if (error || !assignment) throw error ?? new Error("Assignment failed");

    let telegramResult: { ok: boolean; error?: string } = { ok: false, error: "Not requested" };

    if (data.notifyTelegram) {
      const { data: vendor } = await db
        .from("vendors")
        .select("telegram_chat_id, telegram_username, contact_name, business_name")
        .eq("id", data.vendorId)
        .single();

      const chatId = vendor?.telegram_chat_id ?? vendor?.telegram_username;
      if (chatId) {
        const { sendVendorCardNotification } = await import("../lib/telegram");
        const vendorName = vendor.contact_name ?? vendor.business_name ?? "Vendor";
        telegramResult = await sendVendorCardNotification({
          telegramChatId: chatId,
          vendorName,
          brand: data.brand,
          amountUsd: data.amountUsd,
          amountNgn: data.amountNgn,
          cardCode: data.cardCode,
          cardPin: data.cardPin,
          assignmentId: assignment.id,
        });

        if (telegramResult.ok) {
          await db
            .from("vendor_card_assignments")
            .update({ telegram_sent: true })
            .eq("id", assignment.id);
        }
      } else {
        telegramResult = { ok: false, error: "No Telegram chat ID set for vendor" };
      }
    }

    // Admin audit log
    await db.from("admin_audit_log").insert({
      admin_id: userId,
      action: "assign_card_to_vendor",
      target_id: assignment.id,
      details: { vendorId: data.vendorId, brand: data.brand, amountUsd: data.amountUsd },
    });

    return { success: true, assignmentId: assignment.id, telegramResult };
  });

// ─── Admin: Send Telegram Notification ────────────────────────────────────────
export const adminSendTelegramNotification = createServerFn({ method: "POST" })
  .validator((d: { assignmentId: string }) => d)
  .handler(async ({ data }) => {
    const userId = await requireAdmin();
    const db = getServerSupabase();

    const { data: assignment } = await db
      .from("vendor_card_assignments")
      .select("*, vendors(telegram_chat_id, telegram_username, contact_name, business_name)")
      .eq("id", data.assignmentId)
      .single();

    if (!assignment) throw new Error("Assignment not found");

    const vendor = assignment.vendors as {
      telegram_chat_id?: number | null;
      telegram_username?: string | null;
      contact_name?: string | null;
      business_name?: string | null;
    };
    const chatId = vendor?.telegram_chat_id ?? vendor?.telegram_username;
    if (!chatId) return { ok: false, error: "Vendor has no Telegram set up" };

    const { sendVendorCardNotification } = await import("../lib/telegram");
    const result = await sendVendorCardNotification({
      telegramChatId: chatId,
      vendorName: vendor.contact_name ?? vendor.business_name ?? "Vendor",
      brand: assignment.brand,
      amountUsd: assignment.amount_usd,
      amountNgn: assignment.amount_ngn ?? 0,
      cardCode: assignment.card_code,
      cardPin: assignment.card_pin,
      assignmentId: assignment.id,
    });

    if (result.ok) {
      await db
        .from("vendor_card_assignments")
        .update({ telegram_sent: true, updated_at: new Date().toISOString() })
        .eq("id", data.assignmentId);
    }

    return result;
  });

// ─── Request Withdrawal ────────────────────────────────────────────────────────
export const requestWithdrawal = createServerFn({ method: "POST" })
  .validator((d: unknown) => {
    const raw = d as Record<string, unknown>;
    return {
      amount:        Number(raw.amount),
      bankName:      sanitizeStr(raw.bankName,      100, "bankName"),
      bankCode:      sanitizeStr(raw.bankCode,       10, "bankCode"),
      accountNumber: sanitizeStr(raw.accountNumber,  20, "accountNumber"),
      accountName:   sanitizeStr(raw.accountName,   150, "accountName"),
    };
  })
  .handler(async ({ data }) => {
    const userId = await requireVendorAuth();
    const db = getServerSupabase();
    const vendor = await getVendorId(db, userId);
    if (!vendor) throw new Error("Not a vendor");

    // Check available balance
    const { data: wallet } = await db
      .from("vendor_wallets")
      .select("balance")
      .eq("vendor_id", vendor.id)
      .single();
    const balance = Number(wallet?.balance ?? 0);
    if (data.amount <= 0) throw new Error("Amount must be greater than zero");
    if (data.amount > balance) throw new Error(`Insufficient balance. Available: ₦${balance.toLocaleString()}`);
    if (data.amount < 1000) throw new Error("Minimum withdrawal is ₦1,000");

    // Create withdrawal request & lock the funds
    const { data: req, error } = await db
      .from("vendor_withdrawal_requests")
      .insert({
        vendor_id: vendor.id,
        amount: data.amount,
        bank_name: data.bankName,
        bank_code: data.bankCode,
        account_number: data.accountNumber,
        account_name: data.accountName,
        status: "pending",
      })
      .select()
      .single();
    if (error) throw new Error(error.message);

    // Atomically deduct — prevents race between concurrent withdrawal requests
    await db.rpc("deduct_vendor_wallet_balance", {
      p_vendor_id: vendor.id,
      p_amount: data.amount,
    });
    const { data: postWallet } = await db
      .from("vendor_wallets").select("balance").eq("vendor_id", vendor.id).single();
    await db.from("vendor_transactions").insert({
      vendor_id: vendor.id,
      type: "withdrawal",
      amount: -data.amount,
      balance_after: postWallet?.balance ?? null,
      description: `Withdrawal request — ${data.bankName} ${data.accountNumber}`,
      reference: req.id,
    });

    return { ok: true, requestId: req.id };
  });

// ─── Get My Withdrawals ────────────────────────────────────────────────────────
export const getMyWithdrawals = createServerFn({ method: "GET" })
  .handler(async () => {
    const userId = await requireVendorAuth();
    const db = getServerSupabase();
    const vendor = await getVendorId(db, userId);
    if (!vendor) throw new Error("Not a vendor");

    const { data } = await db
      .from("vendor_withdrawal_requests")
      .select("id,amount,bank_name,account_number,account_name,status,admin_note,created_at,processed_at")
      .eq("vendor_id", vendor.id)
      .order("created_at", { ascending: false })
      .limit(20);

    return data ?? [];
  });

// ─── Admin: Get All Withdrawal Requests ────────────────────────────────────────
export const adminGetWithdrawalRequests = createServerFn({ method: "GET" })
  .validator((d: unknown) => {
    const raw = d as Record<string, unknown>;
    const ALLOWED_STATUSES = ["pending","paid","failed","rejected","all"] as const;
    const status = raw.status == null ? undefined : sanitizeStr(raw.status, 20, "status", { required: false }) || undefined;
    if (status && !ALLOWED_STATUSES.includes(status as typeof ALLOWED_STATUSES[number])) {
      throw new Error(`status must be one of: ${ALLOWED_STATUSES.join(", ")}`);
    }
    return { status };
  })
  .handler(async ({ data }) => {
    const userId = await requireAdmin();
    const db = getServerSupabase();
    const { data: profile } = await db
      .from("profiles")
      .select("role")
      .eq("id", userId)
      .single();
    if (profile?.role !== "admin") throw new Error("Forbidden");

    let q = db
      .from("vendor_withdrawal_requests")
      .select(`
        id, amount, bank_name, bank_code, account_number, account_name,
        status, admin_note, squadco_ref, created_at, processed_at,
        vendors!vendor_id (id, business_name, contact_name, telegram_username)
      `)
      .order("created_at", { ascending: false })
      .limit(50);

    if (data.status) q = q.eq("status", data.status);

    const { data: rows } = await q;
    return rows ?? [];
  });

// ─── Admin: Approve & Pay Withdrawal ──────────────────────────────────────────
// ─── Plain impl — callable without a session cookie (e.g. Telegram webhook) ────
// §4.2 fix: the original createServerFn called requireAdmin() → requireUser() →
// getWebRequest() which reads a Supabase auth cookie. The Telegram webhook handler
// has no session cookie, so the call crashed. Extracting the logic here lets both
// the HTTP handler (which derives adminId from the cookie) and the Telegram handler
// (which derives adminId from the linked-chat lookup) share one implementation.
export async function approveWithdrawalImpl(
  db: ReturnType<typeof getServerSupabase>,
  adminId: string,
  withdrawalId: string,
): Promise<{ ok: boolean; squadcoRef?: string; error?: string }> {
  const { data: req } = await db
    .from("vendor_withdrawal_requests")
    .select("*")
    .eq("id", withdrawalId)
    .eq("status", "pending")
    .single();
  if (!req) throw new Error("Request not found or already processed");

  const squadcoKey = process.env.SQUADCO_SECRET_KEY ?? "";
  const env = process.env.SQUADCO_ENV === "production" ? "api" : "sandbox";
  const uniqueId = `7S-WD-${req.id.slice(0, 8)}-${Date.now()}`;

  const { fetchWithTimeout } = await import("../lib/fetch-with-timeout");
  const payoutRes = await fetchWithTimeout(`https://${env}.squadco.com/payout/initiate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${squadcoKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      currency_id: "NGN",
      transactions: [{
        amount: Math.round(Number(req.amount) * 100), // Squadco expects kobo
        bank_code: req.bank_code,
        account_number: req.account_number,
        account_name: req.account_name,
        narration: `7SEVEN Vendor Withdrawal`,
        unique_id: uniqueId,
      }],
    }),
  });

  const payoutData = await payoutRes.json() as {
    success?: boolean;
    message?: string;
    data?: { transaction_reference?: string };
  };

  const squadcoRef = payoutData?.data?.transaction_reference ?? uniqueId;
  const paidSuccessfully = payoutData?.success === true || payoutRes.status === 200;

  await db
    .from("vendor_withdrawal_requests")
    .update({
      status: paidSuccessfully ? "paid" : "failed",
      squadco_ref: squadcoRef,
      processed_by: adminId,
      processed_at: new Date().toISOString(),
      admin_note: paidSuccessfully ? null : `Payout failed: ${payoutData?.message ?? "unknown"}`,
      updated_at: new Date().toISOString(),
    })
    .eq("id", withdrawalId);

  if (!paidSuccessfully) {
    await db.rpc("increment_vendor_wallet_balance", {
      p_vendor_id: req.vendor_id,
      p_amount: Number(req.amount),
    });
    throw new Error(payoutData?.message ?? "Payout failed — balance restored");
  }

  try {
    const { data: vendor } = await db
      .from("vendors")
      .select("contact_name, business_name, telegram_chat_id, telegram_username")
      .eq("id", req.vendor_id)
      .single() as { data: { contact_name?: string | null; business_name?: string | null; telegram_chat_id?: number | null; telegram_username?: string | null } | null };
    const chatId = vendor?.telegram_chat_id ?? vendor?.telegram_username;
    if (chatId) {
      const { sendWithdrawalApprovedNotification } = await import("../lib/telegram");
      await sendWithdrawalApprovedNotification({
        telegramChatId: chatId,
        vendorName: vendor?.contact_name ?? vendor?.business_name ?? "Vendor",
        amountNgn: Number(req.amount),
        bankName: req.bank_name,
        accountNumber: req.account_number,
        squadcoRef,
      });
    }
  } catch { /* non-fatal */ }

  return { ok: true, squadcoRef };
}

// ─── Admin: Approve Withdrawal (HTTP handler) ─────────────────────────────────
export const adminApproveWithdrawal = createServerFn({ method: "POST" })
  .validator((d: unknown) => {
    const raw = d as Record<string, unknown>;
    return { requestId: sanitizeStr(raw.requestId, 36, "requestId") };
  })
  .handler(async ({ data }) => {
    const userId = await requireAdmin();
    const db = getServerSupabase();
    return approveWithdrawalImpl(db, userId, data.requestId);
  });

// ─── Plain impl — callable without a session cookie (e.g. Telegram webhook) ────
// §4.2 fix: same pattern as approveWithdrawalImpl
export async function rejectWithdrawalImpl(
  db: ReturnType<typeof getServerSupabase>,
  adminId: string,
  withdrawalId: string,
  reason?: string,
): Promise<{ ok: boolean }> {
  const { data: req } = await db
    .from("vendor_withdrawal_requests")
    .select("*")
    .eq("id", withdrawalId)
    .eq("status", "pending")
    .single();
  if (!req) throw new Error("Request not found or already processed");

  await db.rpc("increment_vendor_wallet_balance", {
    p_vendor_id: req.vendor_id,
    p_amount: Number(req.amount),
  });
  const { data: rstWallet } = await db
    .from("vendor_wallets").select("balance").eq("vendor_id", req.vendor_id).single();
  await db.from("vendor_transactions").insert({
    vendor_id: req.vendor_id,
    type: "credit",
    amount: Number(req.amount),
    balance_after: rstWallet?.balance ?? null,
    description: `Withdrawal rejected — balance restored: ${reason ?? "Admin decision"}`,
    reference: withdrawalId,
  });

  await db
    .from("vendor_withdrawal_requests")
    .update({
      status: "rejected",
      admin_note: reason ?? "Rejected by admin",
      processed_by: adminId,
      processed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", withdrawalId);

  try {
    const { data: vendor } = await db
      .from("vendors")
      .select("contact_name, business_name, telegram_chat_id, telegram_username")
      .eq("id", req.vendor_id)
      .single() as { data: { contact_name?: string | null; business_name?: string | null; telegram_chat_id?: number | null; telegram_username?: string | null } | null };
    const chatId = vendor?.telegram_chat_id ?? vendor?.telegram_username;
    if (chatId) {
      const { sendWithdrawalRejectedNotification } = await import("../lib/telegram");
      await sendWithdrawalRejectedNotification({
        telegramChatId: chatId,
        vendorName: vendor?.contact_name ?? vendor?.business_name ?? "Vendor",
        amountNgn: Number(req.amount),
        reason,
      });
    }
  } catch { /* non-fatal */ }

  return { ok: true };
}

// ─── Admin: Reject Withdrawal (HTTP handler) ───────────────────────────────────
export const adminRejectWithdrawal = createServerFn({ method: "POST" })
  .validator((d: unknown) => {
    const raw = d as Record<string, unknown>;
    return {
      requestId: sanitizeStr(raw.requestId, 36, "requestId"),
      reason:    raw.reason != null ? sanitizeStr(raw.reason, 500, "reason", { required: false }) : undefined,
    };
  })
  .handler(async ({ data }) => {
    const userId = await requireAdmin();
    const db = getServerSupabase();
    return rejectWithdrawalImpl(db, userId, data.requestId, data.reason);
  });

// ─── Admin: Vendor Leaderboard ─────────────────────────────────────────────────
export const adminGetVendorLeaderboard = createServerFn({ method: "GET" })
  .handler(async () => {
    const userId = await requireAdmin();
    const db = getServerSupabase();
    const { data: profile } = await db
      .from("profiles")
      .select("role")
      .eq("id", userId)
      .single();
    if (profile?.role !== "admin") throw new Error("Forbidden");

    const { data } = await db
      .from("vendors")
      .select(`
        id, business_name, contact_name, telegram_username,
        status, tier, total_redeemed, last_active_at,
        vendor_wallets (total_funded, balance)
      `)
      .eq("status", "active")
      .order("total_redeemed", { ascending: false })
      .limit(20);

    return (data ?? []).map((v, i) => ({
      rank: i + 1,
      id: v.id,
      businessName: v.business_name,
      contactName: v.contact_name,
      telegramUsername: v.telegram_username,
      tier: v.tier,
      totalRedeemed: v.total_redeemed ?? 0,
      lastActiveAt: v.last_active_at,
      totalFunded: (v.vendor_wallets as Array<{ total_funded: number; balance: number }> | null)?.[0]?.total_funded ?? 0,
      balance: (v.vendor_wallets as Array<{ total_funded: number; balance: number }> | null)?.[0]?.balance ?? 0,
    }));
  });

// ─── Admin: Promote Vendor Tier ────────────────────────────────────────────────
export const adminPromoteVendorTier = createServerFn({ method: "POST" })
  .validator((d: unknown) => {
    const raw = d as Record<string, unknown>;
    const tier = sanitizeStr(raw.tier, 20, "tier");
    if (tier !== "standard" && tier !== "premium") {
      throw new Error('tier must be "standard" or "premium"');
    }
    return {
      vendorId: sanitizeStr(raw.vendorId, 36, "vendorId"),
      tier: tier as "standard" | "premium",
    };
  })
  .handler(async ({ data }) => {
    const userId = await requireAdmin();
    const db = getServerSupabase();
    const { data: profile } = await db
      .from("profiles")
      .select("role")
      .eq("id", userId)
      .single();
    if (profile?.role !== "admin") throw new Error("Forbidden");

    const { data: vendor, error } = await db
      .from("vendors")
      .update({ tier: data.tier, updated_at: new Date().toISOString() })
      .eq("id", data.vendorId)
      .select("id, business_name, contact_name, telegram_chat_id, telegram_username, tier, total_redeemed")
      .single() as {
        data: {
          id: string; business_name: string; contact_name: string | null;
          telegram_chat_id: number | null; telegram_username: string | null;
          tier: string; total_redeemed: number;
        } | null;
        error: unknown;
      };
    if (error || !vendor) throw new Error("Vendor not found");

    // Send Telegram congratulations if promoting to premium
    if (data.tier === "premium") {
      try {
        const chatId = vendor.telegram_chat_id ?? vendor.telegram_username;
        if (chatId) {
          const { sendTierPromotionNotification } = await import("../lib/telegram");
          await sendTierPromotionNotification({
            telegramChatId: chatId,
            vendorName: vendor.contact_name ?? vendor.business_name,
            totalRedeemed: vendor.total_redeemed,
          });
        }
      } catch { /* non-fatal */ }
    }

    return { ok: true, vendor };
  });

// ─── Get My Badges ─────────────────────────────────────────────────────────────
// Computed entirely from existing data — no separate badges table needed.
export const getMyBadges = createServerFn({ method: "GET" })
  .handler(async () => {
    const userId = await requireVendorAuth();
    const db = getServerSupabase();
    const vendor = await getVendorId(db, userId);
    if (!vendor) throw new Error("Not a vendor");

    const [{ data: v }, { data: assignments }] = await Promise.all([
      db.from("vendors").select("total_redeemed, tier, created_at").eq("id", vendor.id).single(),
      db.from("vendor_card_assignments")
        .select("status, created_at, completed_at, failed_at")
        .eq("vendor_id", vendor.id)
        .limit(500),
    ]);

    const totalRedeemed  = (v?.total_redeemed as number) ?? 0;
    const tier           = (v?.tier as string) ?? "standard";
    const createdAt      = v?.created_at ? new Date(v.created_at as string) : new Date();
    const ageMs          = Date.now() - createdAt.getTime();
    const ageDays        = ageMs / 86_400_000;

    const completed = (assignments ?? []).filter(a => a.status === "redeemed" && a.completed_at);
    const failed    = (assignments ?? []).filter(a => a.status === "failed");

    // Speed Demon — redeemed within 60 min of assignment
    const speedRedemptions = completed.filter(a => {
      const ms = new Date(a.completed_at!).getTime() - new Date(a.created_at).getTime();
      return ms <= 60 * 60 * 1000;
    });

    // Night Owl — completed between midnight and 5am local
    const nightCompletions = completed.filter(a => {
      const hour = new Date(a.completed_at!).getUTCHours();
      return hour >= 0 && hour < 5;
    });

    const badges: Array<{
      id: string; emoji: string; name: string; description: string; earned: boolean; earnedAt?: string
    }> = [
      {
        id: "rising_star",
        emoji: "🌟", name: "Rising Star",
        description: "Redeemed 10+ cards",
        earned: totalRedeemed >= 10,
      },
      {
        id: "half_century",
        emoji: "🎯", name: "Half Century",
        description: "Redeemed 50+ cards",
        earned: totalRedeemed >= 50,
      },
      {
        id: "century_club",
        emoji: "💯", name: "Century Club",
        description: "Redeemed 100+ cards",
        earned: totalRedeemed >= 100,
      },
      {
        id: "speed_demon",
        emoji: "⚡", name: "Speed Demon",
        description: "Redeemed 5+ cards within 1 hour of assignment",
        earned: speedRedemptions.length >= 5,
      },
      {
        id: "reliable",
        emoji: "🛡️", name: "Reliable",
        description: "Zero failed card redemptions",
        earned: totalRedeemed >= 5 && failed.length === 0,
      },
      {
        id: "night_owl",
        emoji: "🦉", name: "Night Owl",
        description: "Completed 3+ cards between midnight and 5am",
        earned: nightCompletions.length >= 3,
      },
      {
        id: "veteran",
        emoji: "🏅", name: "Veteran",
        description: "Active vendor for 90+ days",
        earned: ageDays >= 90,
      },
      {
        id: "top_tier",
        emoji: "👑", name: "Top Tier",
        description: "Promoted to Premium vendor",
        earned: tier === "premium",
      },
    ];

    return {
      earned: badges.filter(b => b.earned),
      locked: badges.filter(b => !b.earned),
      totalRedeemed,
      tier,
    };
  });

// ─── Internal: Check & Pay Referral Bonus ──────────────────────────────────────
// Called after each redemption. Pays ₦2,500 to referrer when referred vendor
// hits their 10th redemption. Fire-and-forget (non-fatal).
export async function checkReferralBonus(db: ReturnType<typeof getServerSupabase>, vendorId: string, newTotalRedeemed: number) {
  if (newTotalRedeemed !== 10) return; // only triggers at exactly the 10th
  try {
    const { data: referral } = await db
      .from("vendor_referrals")
      .select("id, referrer_id, bonus_amount_ngn, bonus_paid")
      .eq("referred_id", vendorId)
      .eq("bonus_paid", false)
      .single() as { data: { id: string; referrer_id: string; bonus_amount_ngn: number; bonus_paid: boolean } | null };
    if (!referral) return;

    const bonusNgn = Number(referral.bonus_amount_ngn) || 2500;

    // Credit referrer's wallet — atomic RPC prevents concurrent-credit races
    await db.rpc("increment_vendor_wallet_balance", {
      p_vendor_id: referral.referrer_id,
      p_amount: bonusNgn,
    });
    const { data: bonusWallet } = await db
      .from("vendor_wallets").select("balance").eq("vendor_id", referral.referrer_id)
      .single() as { data: { balance: number } | null };
    await db.from("vendor_transactions").insert({
      vendor_id: referral.referrer_id,
      type: "referral_bonus",
      amount: bonusNgn,
      balance_after: bonusWallet?.balance ?? null,
      description: `Referral bonus: your recruit completed 10 redemptions`,
    });

    // Mark bonus paid
    await db.from("vendor_referrals").update({
      bonus_paid: true,
      bonus_paid_at: new Date().toISOString(),
    }).eq("id", referral.id);

    // Notify referrer via Telegram (fire-and-forget)
    try {
      const { data: referrer } = await db
        .from("vendors")
        .select("contact_name, business_name, telegram_chat_id, telegram_username")
        .eq("id", referral.referrer_id)
        .single() as { data: { contact_name: string | null; business_name: string; telegram_chat_id: number | null; telegram_username: string | null } | null };
      const chatId = referrer?.telegram_chat_id ?? referrer?.telegram_username;
      if (chatId) {
        const { sendTelegramMessage } = await import("../lib/telegram");
        await sendTelegramMessage(chatId, [
          `🎉 <b>Referral Bonus Paid!</b>`,
          ``,
          `Hi ${referrer?.contact_name ?? referrer?.business_name}!`,
          ``,
          `Your recruit just completed their <b>10th card redemption</b>.`,
          ``,
          `<b>+₦${bonusNgn.toLocaleString()}</b> has been credited to your vendor wallet! 💰`,
          ``,
          `Keep referring vendors to earn more bonuses.`,
          `🔗 https://7evencards.xyz/vendor`,
        ].join("\n"), "HTML");
      }
    } catch { /* non-fatal */ }
  } catch { /* non-fatal */ }
}

// ─── Get My Referral Info ──────────────────────────────────────────────────────
export const getMyReferralInfo = createServerFn({ method: "GET" })
  .handler(async () => {
    const userId = await requireVendorAuth();
    const db = getServerSupabase();
    const vendor = await getVendorId(db, userId);
    if (!vendor) throw new Error("Not a vendor");

    const { data: v } = await db
      .from("vendors")
      .select("referral_code")
      .eq("id", vendor.id)
      .single() as { data: { referral_code: string | null } | null };

    const { data: referrals } = await db
      .from("vendor_referrals")
      .select("id, bonus_paid, bonus_amount_ngn, created_at")
      .eq("referrer_id", vendor.id) as {
        data: Array<{ id: string; bonus_paid: boolean; bonus_amount_ngn: number; created_at: string }> | null
      };

    const rows = referrals ?? [];
    const totalReferred   = rows.length;
    const bonusesPaid     = rows.filter(r => r.bonus_paid).length;
    const totalEarnedNgn  = rows.filter(r => r.bonus_paid).reduce((s, r) => s + Number(r.bonus_amount_ngn), 0);

    return {
      referralCode: v?.referral_code ?? null,
      referralLink: `https://7evencards.xyz/vendor?ref=${v?.referral_code ?? ""}`,
      totalReferred,
      bonusesPaid,
      totalEarnedNgn,
    };
  });

// ─── Security Deposit: Lock Funds ────────────────────────────────────────────
// Vendor self-service: moves wallet balance into locked security deposit.
// Satisfies the admin-set deposit requirement so the vendor can receive
// assignments (or stay eligible for them).
export const lockSecurityDeposit = createServerFn({ method: "POST" })
  .validator((d: { amount: number }) => d)
  .handler(async ({ data }) => {
    if (data.amount <= 0) throw new Error("Amount must be positive");

    const userId = await requireVendorAuth();
    const db = getServerSupabase();
    const vendor = await getVendorId(db, userId);
    if (!vendor) throw new Error("Not a vendor");
    if (vendor.status === "suspended") throw new Error("Suspended vendors cannot post deposits");

    // Atomic RPC: moves balance → locked and updates security_deposit_held
    await db.rpc("lock_vendor_security_deposit", {
      p_vendor_id: vendor.id,
      p_amount: data.amount,
    });

    const { data: updWallet } = await db
      .from("vendor_wallets").select("balance, locked").eq("vendor_id", vendor.id).single();

    await db.from("vendor_transactions").insert({
      vendor_id: vendor.id,
      type: "security_deposit",
      amount: data.amount,
      balance_after: updWallet?.balance ?? null,
      description: `Security deposit posted: ₦${data.amount.toLocaleString("en-NG")}`,
    });

    return {
      success: true,
      depositedAmount: data.amount,
      newBalance: updWallet?.balance ?? null,
      newLocked: updWallet?.locked ?? null,
    };
  });

// ─── Security Deposit: Status ─────────────────────────────────────────────────
// Vendor view of their deposit health, strike count, and suspension risk.
export const getSecurityDepositStatus = createServerFn({ method: "GET" })
  .handler(async () => {
    const userId = await requireVendorAuth();
    const db = getServerSupabase();
    const vendor = await getVendorId(db, userId);
    if (!vendor) throw new Error("Not a vendor");

    const { data: v } = await db
      .from("vendors")
      .select(
        "status, security_deposit_required, security_deposit_held, " +
        "failed_assignments, consecutive_failures, last_failure_at, suspension_reason",
      )
      .eq("id", vendor.id)
      .single() as {
        data: {
          status: string;
          security_deposit_required: number;
          security_deposit_held: number;
          failed_assignments: number;
          consecutive_failures: number;
          last_failure_at: string | null;
          suspension_reason: string | null;
        } | null;
      };

    if (!v) throw new Error("Vendor record not found");

    const THRESHOLD = 3;
    const depositGap = Math.max(0, Number(v.security_deposit_required) - Number(v.security_deposit_held));

    return {
      status: v.status,
      depositRequired: Number(v.security_deposit_required),
      depositHeld: Number(v.security_deposit_held),
      depositGap,
      depositMet: depositGap === 0,
      failedAssignments: v.failed_assignments,
      consecutiveFailures: v.consecutive_failures,
      strikesRemaining: Math.max(0, THRESHOLD - v.consecutive_failures),
      suspensionThreshold: THRESHOLD,
      atRisk: v.consecutive_failures >= THRESHOLD - 1,
      lastFailureAt: v.last_failure_at,
      suspensionReason: v.suspension_reason,
    };
  });

// ─── Admin: Set Deposit Requirement ──────────────────────────────────────────
// Admin sets how much a vendor must hold as security deposit before they can
// receive (or continue to receive) card assignments.
export const adminSetDepositRequirement = createServerFn({ method: "POST" })
  .validator((d: { vendorId: string; requiredAmount: number; notes?: string }) => d)
  .handler(async ({ data }) => {
    if (data.requiredAmount < 0) throw new Error("Required amount must be ≥ 0");

    await requireAdmin();
    const db = getServerSupabase();

    await db
      .from("vendors")
      .update({
        security_deposit_required: data.requiredAmount,
        ...(data.notes !== undefined && { notes: data.notes }),
        updated_at: new Date().toISOString(),
      })
      .eq("id", data.vendorId);

    return { success: true };
  });

// ─── Admin: Forfeit Deposit ───────────────────────────────────────────────────
// Admin manually forfeits part of a vendor's security deposit (e.g. to
// compensate a user whose trade was not fulfilled by the vendor).
export const adminForfeitDeposit = createServerFn({ method: "POST" })
  .validator((d: {
    vendorId: string;
    amount: number;
    reason: string;
    assignmentId?: string;
  }) => d)
  .handler(async ({ data }) => {
    if (data.amount <= 0) throw new Error("Amount must be positive");

    await requireAdmin();
    const db = getServerSupabase();

    const { data: forfeited } = await db.rpc("forfeit_vendor_security_deposit", {
      p_vendor_id: data.vendorId,
      p_amount: data.amount,
    });
    const actualForfeited = Number(forfeited ?? 0);

    if (actualForfeited > 0) {
      const { data: updWallet } = await db
        .from("vendor_wallets").select("balance").eq("vendor_id", data.vendorId).single();
      await db.from("vendor_transactions").insert({
        vendor_id: data.vendorId,
        type: "security_deposit_forfeit",
        amount: actualForfeited,
        balance_after: updWallet?.balance ?? null,
        description: `Admin forfeit: ${data.reason}`,
        ...(data.assignmentId && { assignment_id: data.assignmentId }),
      });
    }

    return { success: true, actualForfeited };
  });

// ─── Admin: Refund Deposit ────────────────────────────────────────────────────
// Admin returns locked deposit funds to the vendor's spendable balance.
// Use when the vendor is in good standing, retiring, or was incorrectly charged.
export const adminRefundDeposit = createServerFn({ method: "POST" })
  .validator((d: { vendorId: string; amount: number; reason: string }) => d)
  .handler(async ({ data }) => {
    if (data.amount <= 0) throw new Error("Amount must be positive");

    await requireAdmin();
    const db = getServerSupabase();

    const { data: released } = await db.rpc("release_vendor_security_deposit", {
      p_vendor_id: data.vendorId,
      p_amount: data.amount,
    });
    const actualReleased = Number(released ?? 0);

    if (actualReleased > 0) {
      const { data: updWallet } = await db
        .from("vendor_wallets").select("balance").eq("vendor_id", data.vendorId).single();
      await db.from("vendor_transactions").insert({
        vendor_id: data.vendorId,
        type: "security_deposit_refund",
        amount: actualReleased,
        balance_after: updWallet?.balance ?? null,
        description: `Deposit refunded by admin: ${data.reason}`,
      });
    }

    return { success: true, actualReleased };
  });

// ─── Admin: Reactivate Vendor ─────────────────────────────────────────────────
// Reactivates a suspended vendor.  Resets the consecutive-failure counter so
// the vendor starts fresh.  Checks that the deposit requirement is met (or
// waives it if forceActivate = true).
export const adminReactivateVendor = createServerFn({ method: "POST" })
  .validator((d: {
    vendorId: string;
    forceActivate?: boolean;
    newDepositRequired?: number;
    notes?: string;
  }) => d)
  .handler(async ({ data }) => {
    await requireAdmin();
    const db = getServerSupabase();

    const { data: v } = await db
      .from("vendors")
      .select("status, security_deposit_required, security_deposit_held")
      .eq("id", data.vendorId)
      .single() as {
        data: {
          status: string;
          security_deposit_required: number;
          security_deposit_held: number;
        } | null;
      };

    if (!v) throw new Error("Vendor not found");

    const required = data.newDepositRequired !== undefined
      ? data.newDepositRequired
      : Number(v.security_deposit_required);

    const depositMet = Number(v.security_deposit_held) >= required;

    if (!depositMet && !data.forceActivate) {
      throw new Error(
        `Vendor's deposit (₦${Number(v.security_deposit_held).toLocaleString("en-NG")}) ` +
        `is below the required ₦${required.toLocaleString("en-NG")}. ` +
        `Pass forceActivate=true to override.`,
      );
    }

    await db
      .from("vendors")
      .update({
        status: "active",
        consecutive_failures: 0,
        suspension_reason: null,
        ...(data.newDepositRequired !== undefined && {
          security_deposit_required: data.newDepositRequired,
        }),
        ...(data.notes !== undefined && { notes: data.notes }),
        updated_at: new Date().toISOString(),
      })
      .eq("id", data.vendorId);

    return { success: true, depositWaived: !depositMet && !!data.forceActivate };
  });
