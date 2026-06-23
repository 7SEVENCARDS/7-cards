// ─────────────────────────────────────────────────────────────────────────────
// Mobile API Server Functions — Phase 13: Mobile API Platform
//
// REST handlers for the mobile API v1.
// Called directly from server.ts (not via TanStack server functions).
// Returns plain JSON responses compatible with React Native / Flutter clients.
//
// Versioned: /api/v1/*
// Authenticated via: Authorization: Bearer <supabase_jwt>
//
// Endpoints:
//   POST /api/v1/auth/login     — email + password sign-in
//   POST /api/v1/auth/refresh   — exchange refresh token
//   POST /api/v1/auth/logout    — invalidate session
//   GET  /api/v1/profile        — get own profile + wallet
//   GET  /api/v1/trades         — list own trades
//   POST /api/v1/trades         — create a trade
//   GET  /api/v1/rates          — current buy rates (public)
//   GET  /api/v1/wallet         — wallet balances
//   GET  /api/v1/notifications  — in-app notifications
// ─────────────────────────────────────────────────────────────────────────────

import { mobileSignIn, mobileRefresh, mobileSignOut, requireMobileUser } from "../lib/mobile-jwt";
import { getServerSupabase } from "../lib/supabase.server";

const V1_PREFIX = "/api/v1";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function apiError(message: string, status: number): Response {
  return json({ error: message }, status);
}

// ─── Route dispatcher ─────────────────────────────────────────────────────────
export async function handleMobileApiV1(request: Request): Promise<Response | null> {
  const url      = new URL(request.url);
  const path     = url.pathname.slice(V1_PREFIX.length);  // strip /api/v1
  const method   = request.method;

  // ── POST /api/v1/auth/login ───────────────────────────────────────────────
  if (method === "POST" && path === "/auth/login") {
    try {
      const body = await request.json() as { email?: string; password?: string };
      if (!body.email || !body.password) {
        return apiError("email and password required", 400);
      }

      const session = await mobileSignIn(body.email, body.password);
      const db      = getServerSupabase();

      // Fetch profile for the response
      const { data: profile } = await db
        .from("profiles")
        .select("id, display_name, role, kyc_status")
        .eq("id", session.userId)
        .single();

      return json({
        access_token:  session.accessToken,
        refresh_token: session.refreshToken,
        expires_at:    session.expiresAt,
        token_type:    "Bearer",
        user: {
          id:          session.userId,
          display_name: profile?.display_name ?? null,
          role:         profile?.role ?? "user",
          kyc_status:   profile?.kyc_status ?? null,
        },
      });
    } catch (e) {
      const err = e as { status?: number; message?: string };
      return apiError(err.message ?? "Login failed", err.status ?? 500);
    }
  }

  // ── POST /api/v1/auth/refresh ─────────────────────────────────────────────
  if (method === "POST" && path === "/auth/refresh") {
    try {
      const body = await request.json() as { refresh_token?: string };
      if (!body.refresh_token) {
        return apiError("refresh_token required", 400);
      }

      const session = await mobileRefresh(body.refresh_token);
      return json({
        access_token:  session.accessToken,
        refresh_token: session.refreshToken,
        expires_at:    session.expiresAt,
        token_type:    "Bearer",
      });
    } catch (e) {
      const err = e as { status?: number; message?: string };
      return apiError(err.message ?? "Refresh failed", err.status ?? 500);
    }
  }

  // ── POST /api/v1/auth/logout ──────────────────────────────────────────────
  if (method === "POST" && path === "/auth/logout") {
    try {
      const auth = request.headers.get("Authorization") ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
      if (token) await mobileSignOut(token).catch(() => {});
      return json({ ok: true });
    } catch {
      return json({ ok: true }); // Always succeed on logout
    }
  }

  // ── GET /api/v1/rates (public) ────────────────────────────────────────────
  if (method === "GET" && path === "/rates") {
    const db = getServerSupabase();
    const { data, error } = await db
      .from("brand_rates")
      .select("brand, buy_rate, is_active, category")
      .eq("is_active", true)
      .order("brand");

    if (error) return apiError("Failed to fetch rates", 500);
    return json({ rates: data ?? [], updated_at: new Date().toISOString() });
  }

  // All routes below require authentication
  let userId: string;
  try {
    userId = await requireMobileUser(request);
  } catch (e) {
    const err = e as { status?: number; message?: string };
    return apiError(err.message ?? "Unauthorized", err.status ?? 401);
  }

  const db = getServerSupabase();

  // ── GET /api/v1/profile ───────────────────────────────────────────────────
  if (method === "GET" && path === "/profile") {
    const { data: profile } = await db
      .from("profiles")
      .select("id, display_name, role, kyc_status, phone_verified, avatar_url, created_at")
      .eq("id", userId)
      .single();

    if (!profile) return apiError("Profile not found", 404);

    const { data: trust } = await db
      .from("trust_scores")
      .select("score, tier, computed_at")
      .eq("entity_type", "user")
      .eq("entity_id", userId)
      .single();

    return json({ profile, trust: trust ?? null });
  }

  // ── GET /api/v1/wallet ────────────────────────────────────────────────────
  if (method === "GET" && path === "/wallet") {
    const { data: wallets } = await db
      .from("wallets")
      .select("currency, balance, updated_at")
      .eq("user_id", userId);

    const { data: recent } = await db
      .from("wallet_ledger")
      .select("currency, amount, balance_before, balance_after, ref_type, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(20);

    return json({ wallets: wallets ?? [], recent_transactions: recent ?? [] });
  }

  // ── GET /api/v1/trades ────────────────────────────────────────────────────
  if (method === "GET" && path === "/trades") {
    const limitParam = url.searchParams.get("limit");
    const offsetParam = url.searchParams.get("offset");
    const limit  = Math.min(50, Math.max(1, parseInt(limitParam ?? "20", 10)));
    const offset = Math.max(0, parseInt(offsetParam ?? "0", 10));

    const { data: trades, count } = await db
      .from("trades")
      .select("id, brand, amount_usd, amount_ngn, status, payout_method, created_at, settled_at", { count: "exact" })
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    return json({
      trades:  trades ?? [],
      total:   count ?? 0,
      limit,
      offset,
    });
  }

  // ── GET /api/v1/notifications ─────────────────────────────────────────────
  if (method === "GET" && path === "/notifications") {
    const { data: notifications } = await db
      .from("notifications")
      .select("id, title, message, type, read, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(50);

    return json({ notifications: notifications ?? [] });
  }

  // ── POST /api/v1/notifications/read-all ───────────────────────────────────
  if (method === "POST" && path === "/notifications/read-all") {
    await db
      .from("notifications")
      .update({ read: true })
      .eq("user_id", userId)
      .eq("read", false);

    return json({ ok: true });
  }

  // No matching route in v1
  return null;
}
