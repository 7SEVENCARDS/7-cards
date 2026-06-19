import { createServerFn } from "@tanstack/react-start";
import { getServerSupabase } from "../lib/supabase.server";

// ─── BVN Verification ─────────────────────────────────────────────────────────
export const verifyBVN = createServerFn({ method: "POST" })
  .validator((d: { userId: string; bvn: string }) => d)
  .handler(async ({ data }) => {
    // Validate BVN format (11 digits)
    if (!/^\d{11}$/.test(data.bvn)) {
      return { success: false, error: "BVN must be exactly 11 digits" };
    }

    try {
      const { lookupBVN, maskBVN } = await import("../lib/dojah");
      const result = await lookupBVN(data.bvn);

      const db = getServerSupabase();

      // Store MASKED BVN only — raw BVN must never be stored unencrypted
      await db.from("profiles").update({
        kyc_bvn: maskBVN(data.bvn),
        kyc_status: "submitted",
      }).eq("id", data.userId);

      // Return identity details for user to confirm (no raw BVN echoed back)
      return {
        success: true,
        identity: {
          firstName: result.first_name,
          middleName: result.middle_name ?? "",
          lastName: result.last_name,
          dateOfBirth: result.date_of_birth,
          phoneNumber: result.phone_number,
          gender: result.gender,
          photo: result.image ?? null,
        },
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const isConfig = msg.includes("not configured");

      if (isConfig) {
        // Demo mode — return mock identity when Dojah isn't configured yet
        const db = getServerSupabase();
        await db.from("profiles").update({
          kyc_bvn: "22*****123",
          kyc_status: "submitted",
        }).eq("id", data.userId);

        return {
          success: true,
          demo: true,
          identity: {
            firstName: "Demo",
            middleName: "",
            lastName: "User",
            dateOfBirth: "01-01-1990",
            phoneNumber: "080*****567",
            gender: "Male",
            photo: null,
          },
        };
      }

      const isInvalid =
        msg.toLowerCase().includes("invalid") ||
        msg.toLowerCase().includes("not found") ||
        msg.toLowerCase().includes("does not exist");

      return {
        success: false,
        error: isInvalid
          ? "BVN not found. Double-check and try again."
          : "Verification service temporarily unavailable. Try again shortly.",
      };
    }
  });

// ─── NIN Verification ─────────────────────────────────────────────────────────
export const verifyNIN = createServerFn({ method: "POST" })
  .validator((d: { userId: string; nin: string }) => d)
  .handler(async ({ data }) => {
    if (!/^\d{11}$/.test(data.nin)) {
      return { success: false, error: "NIN must be exactly 11 digits" };
    }

    try {
      const { lookupNIN, maskNIN } = await import("../lib/dojah");
      const result = await lookupNIN(data.nin);

      const db = getServerSupabase();
      await db.from("profiles").update({
        kyc_nin: maskNIN(data.nin),
      }).eq("id", data.userId);

      return {
        success: true,
        identity: {
          firstName: result.first_name,
          middleName: result.middle_name ?? "",
          lastName: result.last_name,
          dateOfBirth: result.date_of_birth,
          phoneNumber: result.phone,
          gender: result.gender,
          photo: result.photo ?? null,
        },
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const isConfig = msg.includes("not configured");

      if (isConfig) {
        return { success: true, demo: true };
      }

      return {
        success: false,
        error: "NIN verification failed. Check the number and try again.",
      };
    }
  });

// ─── Submit KYC (finalize) ────────────────────────────────────────────────────
// In production this would trigger a compliance review workflow.
// For now it sets status to "submitted" and notifies the user.
export const submitKYC = createServerFn({ method: "POST" })
  .validator((d: { userId: string }) => d)
  .handler(async ({ data }) => {
    const db = getServerSupabase();

    await db.from("profiles").update({
      kyc_status: "submitted",
    }).eq("id", data.userId);

    await db.from("notifications").insert({
      user_id: data.userId,
      title: "KYC Submitted ✅",
      message: "Your identity documents are under review. You'll be notified within 24 hours.",
      type: "info",
    });

    return { success: true };
  });

// ─── Get KYC status ───────────────────────────────────────────────────────────
export const getKYCStatus = createServerFn({ method: "GET" })
  .validator((d: { userId: string }) => d)
  .handler(async ({ data }) => {
    const db = getServerSupabase();
    const { data: profile, error } = await db
      .from("profiles")
      .select("kyc_status, kyc_bvn, kyc_nin")
      .eq("id", data.userId)
      .single();

    if (error) throw error;
    return {
      status: profile?.kyc_status ?? "pending",
      hasBVN: !!profile?.kyc_bvn,
      hasNIN: !!profile?.kyc_nin,
    };
  });
