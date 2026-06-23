// ─────────────────────────────────────────────────────────────────────────────
// Admin Portal Auth — Server Functions
//
// Lightweight server functions used exclusively by the admin portal route
// (src/routes/admin.tsx).  They are NOT called from the consumer or vendor
// portals.
//
// Security model:
//   - requireAdmin() validates the Supabase session cookie AND checks that the
//     caller has profiles.role = 'admin' | 'super_admin' (or app_metadata
//     fallback).  All functions here delegate to that guard.
//   - The admin portal receives no data and returns no PII from these functions;
//     sensitive data access is gated in the individual admin server functions
//     (src/server-functions/admin.ts) which also call requireAdmin().
// ─────────────────────────────────────────────────────────────────────────────

import { createServerFn } from "@tanstack/react-start";
import { requireAdmin, requireSuperAdmin, getCallerRole } from "../lib/auth-server";

// ─── Check Admin Access ────────────────────────────────────────────────────────
// Called on every mount of the admin portal to verify the session is valid and
// the caller is an admin/super_admin.
//
// Returns:
//   { isAdmin: true,  adminId: string, role: string } — authenticated admin
//   { isAdmin: false, adminId: null,   role: null   } — not authenticated / not admin

export const checkAdminAccess = createServerFn({ method: "GET" })
  .validator((d: Record<string, never>) => d)
  .handler(async () => {
    try {
      const adminId = await requireAdmin();
      const role = await getCallerRole(adminId);
      return { isAdmin: true as const, adminId, role };
    } catch {
      return { isAdmin: false as const, adminId: null, role: null };
    }
  });

// ─── Check Super Admin Access ──────────────────────────────────────────────────
// Same as above but strictly requires super_admin role.
// Used to gate super-admin-only UI sections inside the admin portal.

export const checkSuperAdminAccess = createServerFn({ method: "GET" })
  .validator((d: Record<string, never>) => d)
  .handler(async () => {
    try {
      const adminId = await requireSuperAdmin();
      return { isSuperAdmin: true as const, adminId };
    } catch {
      return { isSuperAdmin: false as const, adminId: null };
    }
  });
