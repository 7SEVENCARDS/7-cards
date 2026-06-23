// ─────────────────────────────────────────────────────────────────────────────
// Upload Security — Server-Side Validation           Phase 15
//
// Called AFTER the file reaches Supabase Storage to verify:
//  1. The stored path actually belongs to the requesting user (no path hijack)
//  2. The file exists and is within size limits
//  3. The user has not exceeded their upload rate limit
//
// Rate limit: 30 card-image uploads per user per hour (generous for normal use,
// stops bulk automated abuse).
// ─────────────────────────────────────────────────────────────────────────────

import { createServerFn } from "@tanstack/react-start";
import { getServerSupabase } from "../lib/supabase.server";
import { requireUser } from "../lib/auth-server";
import { assertNotRateLimited, rlKey } from "../lib/rate-limiter";

const MAX_FILE_BYTES = 10 * 1_024 * 1_024; // 10 MB — matches client constant

// ── Post-upload validation ────────────────────────────────────────────────────

export const validateUploadedCard = createServerFn({ method: "POST" })
  .validator((d: { storagePath: string }) => d)
  .handler(async ({ data }) => {
    const userId = await requireAuth();

    // 1. Rate limit — 30 uploads per hour per user
    assertNotRateLimited(rlKey("upload", userId), 30, 60 * 60 * 1_000);

    const { storagePath } = data;

    // 2. Path ownership — the path MUST start with the user's own ID segment
    //    Format enforced by client: `{userId}/{timestamp}_{index}_{safeName}`
    const ownerPrefix = `${userId}/`;
    if (!storagePath.startsWith(ownerPrefix)) {
      throw new Error("Upload path does not belong to the requesting user.");
    }

    // 3. Reject any path traversal attempts
    if (storagePath.includes("..") || storagePath.includes("//")) {
      throw new Error("Invalid storage path.");
    }

    // 4. Confirm the file exists in Storage and get its metadata
    const db = getServerSupabase();
    const folder = storagePath.substring(0, storagePath.lastIndexOf("/"));
    const filename = storagePath.substring(storagePath.lastIndexOf("/") + 1);

    const { data: files, error: listErr } = await db.storage
      .from("card-images")
      .list(folder, { search: filename, limit: 1 });

    if (listErr) {
      throw new Error(`Storage lookup failed: ${listErr.message}`);
    }

    const fileEntry = (files ?? []).find(f => f.name === filename);
    if (!fileEntry) {
      throw new Error("Uploaded file not found in storage. It may have been rejected.");
    }

    // 5. Server-side size check (defence-in-depth — bucket policy is primary)
    const fileSize = fileEntry.metadata?.size ?? 0;
    if (fileSize > MAX_FILE_BYTES) {
      // Delete the oversized file immediately
      await db.storage.from("card-images").remove([storagePath]).catch(() => {});
      const mb = (fileSize / 1_048_576).toFixed(1);
      throw new Error(`Uploaded file is too large (${mb} MB). Maximum allowed is 10 MB.`);
    }

    // 6. Log the validated upload in the audit trail
    try {
      await db.from("admin_audit_log").insert({
        admin_id:  userId,
        action:    "card_image_uploaded",
        target_id: storagePath,
        meta: {
          size:     fileSize,
          filename: filename,
          bucket:   "card-images",
        },
      });
    } catch {
      // Audit log failure is non-fatal
    }

    return {
      ok:   true,
      path: storagePath,
      size: fileSize,
    };
  });

// ── Admin: delete a suspicious upload ────────────────────────────────────────

export const adminDeleteUpload = createServerFn({ method: "POST" })
  .validator((d: { storagePath: string; reason: string }) => d)
  .handler(async ({ data }) => {
    const { requireAdmin, logAdminAction } = await import("../lib/auth-server");
    const adminId = await requireAdmin();
    const db = getServerSupabase();

    const { error } = await db.storage
      .from("card-images")
      .remove([data.storagePath]);

    if (error) throw new Error(`Failed to delete: ${error.message}`);

    await logAdminAction(adminId, "upload_deleted", data.storagePath, {
      reason: data.reason,
      path:   data.storagePath,
    });

    return { ok: true };
  });
