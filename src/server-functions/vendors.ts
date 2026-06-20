// ─────────────────────────────────────────────────────────────────────────────
// Vendor Server Functions
// Vendors are registered Supabase auth users with a row in the `vendors` table.
// Admin functions are co-located in admin.ts (use requireAdmin).
// ─────────────────────────────────────────────────────────────────────────────

import { createServerFn } from "@tanstack/react-start";
import { getServerSupabase } from "../lib/supabase.server";

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
};

type CardAssignment = {
  id: string;
  vendor_id: string;
  brand: string;
  region: string | null;
  amount_usd: number;
  amount_ngn: number | null;
  card_code: string;
  card_pin: string | null;
  status: "assigned" | "viewed" | "redeemed" | "failed" | "cancelled";
  telegram_sent: boolean;
  viewed_at: string | null;
  redeemed_at: string | null;
  notes: string | null;
  created_at: string;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function getVendorId(db: ReturnType<typeof getServerSupabase>, userId: string) {
  const { data } = await db.from("vendors").select("id, status").eq("user_id", userId).single();
  return data;
}

// ─── Register as Vendor ───────────────────────────────────────────────────────
export const registerVendor = createServerFn({ method: "POST" })
  .validator(
    (d: {
      email: string;
      password: string;
      businessName: string;
      contactName: string;
      phone: string;
    }) => d
  )
  .handler(async ({ data }) => {
    const db = getServerSupabase();

    // Create Supabase auth user
    const { data: authData, error: authError } = await db.auth.admin.createUser({
      email: data.email,
      password: data.password,
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
        business_name: data.businessName,
        contact_name: data.contactName,
        phone: data.phone,
        email: data.email,
        status: "pending",
      })
      .select("id")
      .single();

    if (vendorError || !vendor) {
      return { success: false, error: "Failed to create vendor profile" };
    }

    // Create vendor wallet
    await db.from("vendor_wallets").insert({ vendor_id: vendor.id });

    return { success: true, vendorId: vendor.id };
  });

// ─── Vendor Login ─────────────────────────────────────────────────────────────
export const vendorLogin = createServerFn({ method: "POST" })
  .validator((d: { email: string; password: string }) => d)
  .handler(async ({ data }) => {
    const db = getServerSupabase();

    const { data: authData, error } = await db.auth.signInWithPassword({
      email: data.email,
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
    const db = getServerSupabase();
    try {
      const { data: sessionData } = await db.auth.getSession();
      const userId = sessionData?.session?.user?.id;
      if (!userId) return { authenticated: false };

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
    const db = getServerSupabase();
    const { data: sessionData } = await db.auth.getSession();
    const userId = sessionData?.session?.user?.id;
    if (!userId) throw new Error("Unauthenticated");

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
    const db = getServerSupabase();
    const { data: sessionData } = await db.auth.getSession();
    const userId = sessionData?.session?.user?.id;
    if (!userId) throw new Error("Unauthenticated");

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
    const db = getServerSupabase();
    const { data: sessionData } = await db.auth.getSession();
    const userId = sessionData?.session?.user?.id;
    if (!userId) throw new Error("Unauthenticated");

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
    const db = getServerSupabase();
    const { data: sessionData } = await db.auth.getSession();
    const userId = sessionData?.session?.user?.id;
    if (!userId) throw new Error("Unauthenticated");

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

    // Credit vendor wallet
    const amountNgn = assignment.amount_ngn ?? 0;
    if (amountNgn > 0) {
      const { data: wallet } = await db
        .from("vendor_wallets")
        .select("balance, total_funded")
        .eq("vendor_id", vendor.id)
        .single();

      const newBalance = Number(wallet?.balance ?? 0) + Number(amountNgn);
      await db
        .from("vendor_wallets")
        .update({
          balance: newBalance,
          total_funded: Number(wallet?.total_funded ?? 0) + Number(amountNgn),
          updated_at: new Date().toISOString(),
        })
        .eq("vendor_id", vendor.id);

      await db.from("vendor_transactions").insert({
        vendor_id: vendor.id,
        type: "assignment_credit",
        amount: amountNgn,
        balance_after: newBalance,
        description: `Card redeemed: ${assignment.brand} $${assignment.amount_usd}`,
        assignment_id: data.assignmentId,
      });
    }

    // Update vendor stats
    await db
      .from("vendors")
      .update({
        total_redeemed: Number(assignment.total_redeemed ?? 0) + 1,
        total_volume_ngn: (assignment.total_volume_ngn ?? 0) + Number(amountNgn),
        last_active_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId);

    return { success: true };
  });

// ─── Mark Assignment Failed ────────────────────────────────────────────────────
export const markAssignmentFailed = createServerFn({ method: "POST" })
  .validator((d: { assignmentId: string; reason: string }) => d)
  .handler(async ({ data }) => {
    const db = getServerSupabase();
    const { data: sessionData } = await db.auth.getSession();
    const userId = sessionData?.session?.user?.id;
    if (!userId) throw new Error("Unauthenticated");

    const vendor = await getVendorId(db, userId);
    if (!vendor) throw new Error("Not a vendor");

    await db
      .from("vendor_card_assignments")
      .update({
        status: "failed",
        failed_at: new Date().toISOString(),
        failure_reason: data.reason,
        updated_at: new Date().toISOString(),
      })
      .eq("id", data.assignmentId)
      .eq("vendor_id", vendor.id);

    return { success: true };
  });

// ─── Get Vendor Wallet ─────────────────────────────────────────────────────────
export const getVendorWallet = createServerFn({ method: "GET" })
  .validator((d: Record<string, never>) => d)
  .handler(async () => {
    const db = getServerSupabase();
    const { data: sessionData } = await db.auth.getSession();
    const userId = sessionData?.session?.user?.id;
    if (!userId) throw new Error("Unauthenticated");

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
    const db = getServerSupabase();
    const { data: sessionData } = await db.auth.getSession();
    const userId = sessionData?.session?.user?.id;
    if (!userId) throw new Error("Unauthenticated");

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
    const db = getServerSupabase();
    const { data: sessionData } = await db.auth.getSession();
    const userId = sessionData?.session?.user?.id;
    if (!userId) throw new Error("Unauthenticated");

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
            email: vendor.email ?? `${vendor.id}@vendor.7sevencards.com`,
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

    // Mock VAN if Squadco is unavailable
    if (!accountNumber) {
      const seed = Date.now();
      accountNumber = String(9000000000 + (seed % 1000000000)).slice(0, 10);
      bankName = "7SEVEN Wema Collection";
      bankCode = "035";
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
    const db = getServerSupabase();
    // Verify admin (re-use same pattern)
    const { data: session } = await db.auth.getSession();
    const userId = session?.session?.user?.id;
    if (!userId) throw new Error("Unauthenticated");

    const { data: profile } = await db.from("profiles").select("role").eq("id", userId).single();
    if (profile?.role !== "admin") throw new Error("Forbidden");

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
    const db = getServerSupabase();
    const { data: session } = await db.auth.getSession();
    const userId = session?.session?.user?.id;
    if (!userId) throw new Error("Unauthenticated");

    const { data: profile } = await db.from("profiles").select("role").eq("id", userId).single();
    if (profile?.role !== "admin") throw new Error("Forbidden");

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
    const db = getServerSupabase();
    const { data: session } = await db.auth.getSession();
    const userId = session?.session?.user?.id;
    if (!userId) throw new Error("Unauthenticated");

    const { data: profile } = await db.from("profiles").select("role").eq("id", userId).single();
    if (profile?.role !== "admin") throw new Error("Forbidden");

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
    const db = getServerSupabase();
    const { data: session } = await db.auth.getSession();
    const userId = session?.session?.user?.id;
    if (!userId) throw new Error("Unauthenticated");

    const { data: profile } = await db.from("profiles").select("role").eq("id", userId).single();
    if (profile?.role !== "admin") throw new Error("Forbidden");

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
