import { createServerFn } from "@tanstack/react-start";
import { getServerSupabase } from "../lib/supabase.server";
import { requireUser } from "../lib/auth-server";
import { assertNotRateLimited, rlKey } from "../lib/rate-limiter";
import { assertBvn, assertNin } from "../lib/validate";
import { getEnv } from "../lib/worker-env";

// ─── Name-match helper ────────────────────────────────────────────────────────
function namesMatch(registered: string | null, dojahFirst: string, dojahLast: string): boolean {
  if (!registered) return true;
  const norm = (s: string) =>
    s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z\s]/g, "").trim();

  const regTokens = new Set(norm(registered).split(/\s+/).filter(Boolean));
  const dojahFull = norm(`${dojahFirst} ${dojahLast}`);
  const dojahTokens = dojahFull.split(/\s+/).filter(Boolean);

  const shared = dojahTokens.filter((t) => regTokens.has(t)).length;
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
      const { lookupBVN, maskBVN } = await import("../lib/dojah");
      const result = await lookupBVN(data.bvn);

      const db = getServerSupabase();

      const { data: profile } = await db
        .from("profiles")
        .select("full_name, kyc_nin")
        .eq("id", userId)
        .single();

      if (!namesMatch(profile?.full_name ?? null, result.first_name ?? "", result.last_name ?? "")) {
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

      // Admin email notification — fire-and-forget
      const displayName = profile?.full_name ?? `${result.first_name ?? ""} ${result.last_name ?? ""}`.trim();
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
        identity: {
          firstName: result.first_name,
          lastName: result.last_name,
        },
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const isConfig = msg.includes("not configured");

      if (isConfig) {
        if (getEnv("IS_DEMO_MODE") !== "true") {
          return { success: false, error: "Verification service not available." };
        }

        const db = getServerSupabase();
        const { data: profile } = await db
          .from("profiles")
          .select("kyc_nin")
          .eq("id", userId)
          .single();

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
  .validator((d: { nin: string }) => d)
  .handler(async ({ data }) => {
    assertNin(data.nin);

    const userId = await requireUser();
    assertNotRateLimited(rlKey("verifyNIN", userId), 10, 10 * 60_000);

    try {
      const { lookupNIN, maskNIN } = await import("../lib/dojah");
      const result = await lookupNIN(data.nin);

      const db = getServerSupabase();

      const { data: profile } = await db
        .from("profiles")
        .select("full_name, kyc_bvn")
        .eq("id", userId)
        .single();

      if (!namesMatch(profile?.full_name ?? null, result.first_name ?? "", result.last_name ?? "")) {
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

      // Admin email notification — fire-and-forget
      const displayName = profile?.full_name ?? `${result.first_name ?? ""} ${result.last_name ?? ""}`.trim();
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
        identity: {
          firstName: result.first_name,
          lastName: result.last_name,
        },
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const isConfig = msg.includes("not configured");

      if (isConfig) {
        if (getEnv("IS_DEMO_MODE") !== "true") {
          return { success: false, error: "Verification service not available." };
        }

        const db = getServerSupabase();
        const { data: profile } = await db
          .from("profiles")
          .select("kyc_bvn")
          .eq("id", userId)
          .single();

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

      return {
        success: false,
        error: "NIN verification failed. Check the number and try again.",
      };
    }
  });

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

    // Admin email — fire-and-forget
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

    if (error) throw error;
    return {
      status: profile?.kyc_status ?? "pending",
      hasBVN: !!profile?.kyc_bvn,
      hasNIN: !!profile?.kyc_nin,
    };
  });
