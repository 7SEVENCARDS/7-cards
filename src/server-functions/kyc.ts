import { createServerFn } from "@tanstack/react-start";
import { getServerSupabase } from "../lib/supabase.server";
import { requireUser } from "../lib/auth-server";
import { assertNotRateLimited, rlKey } from "../lib/rate-limiter";
import { assertBvn, assertNin } from "../lib/validate";
import { getEnv } from "../lib/worker-env";
import { IdentityGateway } from "../lib/gateways/identity/gateway";
import { maskBVN, maskNIN } from "../lib/dojah";

// ─── Name-match helper ────────────────────────────────────────────────────────
function namesMatch(registered: string | null, first: string, last: string): boolean {
  if (!registered) return true;
  const norm = (s: string) =>
    s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z\s]/g, "").trim();

  const regTokens = new Set(norm(registered).split(/\s+/).filter(Boolean));
  const fullName  = norm(`${first} ${last}`);
  const tokens    = fullName.split(/\s+/).filter(Boolean);

  const shared = tokens.filter((t) => regTokens.has(t)).length;
  return shared >= 1;
}

// ─── BVN Verification ─────────────────────────────────────────────────────────
export const verifyBVN = createServerFn({ method: "POST" })
  .validator((d: { bvn: string }) => d)
  .handler(async ({ data }) => {
    assertBvn(data.bvn);

    const userId = await requireUser();
    assertNotRateLimited(rlKey("verifyBVN", userId), 10, 10 * 60_000);

    try {
      const result = await IdentityGateway.verifyBVN(data.bvn, userId);

      if (!result.ok) {
        const isConfig = result.error.includes("not configured");
        if (isConfig) {
          // All providers unconfigured — demo mode fallback
          return await demoBVN(userId);
        }
        const isInvalid = result.error.toLowerCase().includes("invalid") ||
          result.error.toLowerCase().includes("not found") ||
          result.error.toLowerCase().includes("does not exist");
        return {
          success: false,
          error: isInvalid
            ? "BVN not found. Double-check and try again."
            : "Verification service temporarily unavailable. Try again shortly.",
        };
      }

      const identity = result.data;
      const db = getServerSupabase();

      const { data: profile } = await db
        .from("profiles")
        .select("full_name, kyc_nin")
        .eq("id", userId)
        .single();

      if (!namesMatch(profile?.full_name ?? null, identity.firstName, identity.lastName)) {
        return {
          success: false,
          error: "The name on your BVN does not match your registered name. Please use a BVN linked to the same name you signed up with.",
        };
      }

      await db.from("profiles").update({
        kyc_bvn: maskBVN(data.bvn),
        kyc_status: "submitted",
      }).eq("id", userId);

      let autoApproved = false;
      if (profile?.kyc_nin) {
        await db.from("profiles").update({ kyc_status: "verified" }).eq("id", userId);
        autoApproved = true;

        await db.from("notifications").insert({
          user_id: userId,
          title: "KYC Verified! ✅",
          message: "Your identity has been verified. You can now trade without limits.",
          type: "success",
        });

        try {
          const { pushNotify } = await import("../lib/onesignal");
          pushNotify(userId, "KYC Verified! ✅", "Identity confirmed — start trading now.");
        } catch { /* non-critical */ }
      }

      const displayName = profile?.full_name ??
        `${identity.firstName ?? ""} ${identity.lastName ?? ""}`.trim();

      import("../lib/email").then(async ({ sendAdminEmail, buildKYCSubmissionEmailHtml }) => {
        await sendAdminEmail({
          subject: autoApproved
            ? `[7SEVEN CARDS] KYC Auto-Approved — ${displayName}`
            : `[7SEVEN CARDS] KYC Submitted (BVN) — ${displayName}`,
          html: buildKYCSubmissionEmailHtml({
            userId,
            fullName: displayName,
            kycType: autoApproved ? "both" : "bvn",
            autoApproved,
          }),
        });
      }).catch(() => {});

      return {
        success: true,
        autoApproved,
        provider: result.provider,
        failover: result.failover,
        identity: {
          firstName: identity.firstName,
          lastName: identity.lastName,
        },
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        success: false,
        error: msg.toLowerCase().includes("invalid") || msg.toLowerCase().includes("not found")
          ? "BVN not found. Double-check and try again."
          : "Verification service temporarily unavailable. Try again shortly.",
      };
    }
  });

async function demoBVN(userId: string) {
  if (getEnv("IS_DEMO_MODE") !== "true") {
    return { success: false, error: "Verification service not available." };
  }
  const db = getServerSupabase();
  const { data: profile } = await db.from("profiles").select("kyc_nin").eq("id", userId).single();
  const autoApproved = !!profile?.kyc_nin;
  await db.from("profiles").update({
    kyc_bvn: "22*****123",
    kyc_status: autoApproved ? "verified" : "submitted",
  }).eq("id", userId);
  if (autoApproved) {
    await db.from("notifications").insert({
      user_id: userId,
      title: "KYC Verified! ✅",
      message: "Your identity has been verified. You can now trade without limits.",
      type: "success",
    });
  }
  return { success: true, demo: true, autoApproved, identity: { firstName: "Demo", lastName: "User" } };
}

// ─── NIN Verification ─────────────────────────────────────────────────────────
export const verifyNIN = createServerFn({ method: "POST" })
  .validator((d: { nin: string }) => d)
  .handler(async ({ data }) => {
    assertNin(data.nin);

    const userId = await requireUser();
    assertNotRateLimited(rlKey("verifyNIN", userId), 10, 10 * 60_000);

    try {
      const result = await IdentityGateway.verifyNIN(data.nin, userId);

      if (!result.ok) {
        const isConfig = result.error.includes("not configured");
        if (isConfig) return await demoNIN(userId);
        return {
          success: false,
          error: "NIN verification failed. Check the number and try again.",
        };
      }

      const identity = result.data;
      const db = getServerSupabase();

      const { data: profile } = await db
        .from("profiles")
        .select("full_name, kyc_bvn")
        .eq("id", userId)
        .single();

      if (!namesMatch(profile?.full_name ?? null, identity.firstName, identity.lastName)) {
        return {
          success: false,
          error: "The name on your NIN does not match your registered name. Please use a NIN linked to the same name you signed up with.",
        };
      }

      await db.from("profiles").update({
        kyc_nin: maskNIN(data.nin),
      }).eq("id", userId);

      let autoApproved = false;
      if (profile?.kyc_bvn) {
        await db.from("profiles").update({ kyc_status: "verified" }).eq("id", userId);
        autoApproved = true;

        await db.from("notifications").insert({
          user_id: userId,
          title: "KYC Verified! ✅",
          message: "Your identity has been verified. You can now trade without limits.",
          type: "success",
        });

        try {
          const { pushNotify } = await import("../lib/onesignal");
          pushNotify(userId, "KYC Verified! ✅", "Identity confirmed — start trading now.");
        } catch { /* non-critical */ }
      }

      const displayName = profile?.full_name ??
        `${identity.firstName ?? ""} ${identity.lastName ?? ""}`.trim();

      import("../lib/email").then(async ({ sendAdminEmail, buildKYCSubmissionEmailHtml }) => {
        await sendAdminEmail({
          subject: autoApproved
            ? `[7SEVEN CARDS] KYC Auto-Approved — ${displayName}`
            : `[7SEVEN CARDS] KYC Submitted (NIN) — ${displayName}`,
          html: buildKYCSubmissionEmailHtml({
            userId,
            fullName: displayName,
            kycType: autoApproved ? "both" : "nin",
            autoApproved,
          }),
        });
      }).catch(() => {});

      return {
        success: true,
        autoApproved,
        provider: result.provider,
        failover: result.failover,
        identity: {
          firstName: identity.firstName,
          lastName: identity.lastName,
        },
      };
    } catch (e: unknown) {
      return {
        success: false,
        error: "NIN verification failed. Check the number and try again.",
      };
    }
  });

async function demoNIN(userId: string) {
  if (getEnv("IS_DEMO_MODE") !== "true") {
    return { success: false, error: "Verification service not available." };
  }
  const db = getServerSupabase();
  const { data: profile } = await db.from("profiles").select("kyc_bvn").eq("id", userId).single();
  const autoApproved = !!profile?.kyc_bvn;
  await db.from("profiles").update({
    kyc_nin: "122*****456",
    ...(autoApproved ? { kyc_status: "verified" } : {}),
  }).eq("id", userId);
  if (autoApproved) {
    await db.from("notifications").insert({
      user_id: userId,
      title: "KYC Verified! ✅",
      message: "Your identity has been verified. You can now trade without limits.",
      type: "success",
    });
  }
  return { success: true, demo: true, autoApproved };
}

// ─── Submit KYC (finalize) ────────────────────────────────────────────────────
export const submitKYC = createServerFn({ method: "POST" })
  .validator((d: Record<string, never>) => d)
  .handler(async () => {
    const userId = await requireUser();
    const db = getServerSupabase();

    await db.from("profiles").update({ kyc_status: "submitted" }).eq("id", userId);

    await db.from("notifications").insert({
      user_id: userId,
      title: "KYC Submitted ✅",
      message: "Your identity documents are under review. You'll be notified within 24 hours.",
      type: "info",
    });

    import("../lib/email").then(async ({ sendAdminEmail, buildKYCSubmissionEmailHtml }) => {
      await sendAdminEmail({
        subject: `[7SEVEN CARDS] KYC Submitted — Manual Review Required`,
        html: buildKYCSubmissionEmailHtml({
          userId,
          fullName: "User",
          kycType: "submitted",
          autoApproved: false,
        }),
      });
    }).catch(() => {});

    return { success: true };
  });

// ─── Get KYC status ───────────────────────────────────────────────────────────
export const getKYCStatus = createServerFn({ method: "GET" })
  .validator((d: { userId?: string }) => d)
  .handler(async () => {
    const userId = await requireUser();
    const db = getServerSupabase();
    const { data: profile, error } = await db
      .from("profiles")
      .select("kyc_status, kyc_bvn, kyc_nin")
      .eq("id", userId)
      .single();

    if (error) { console.error("[kyc] profile fetch error", error.message); throw error; }
    return {
      status: profile?.kyc_status ?? "pending",
      hasBVN: !!profile?.kyc_bvn,
      hasNIN: !!profile?.kyc_nin,
    };
  });

// ─── Identity Gateway Status (for admin dashboard) ────────────────────────────
export const getIdentityProviderStatus = createServerFn({ method: "GET" })
  .validator((d: Record<string, never>) => d)
  .handler(async () => {
    await requireUser();
    return {
      providers: IdentityGateway.getProviderStatus(),
    };
  });
