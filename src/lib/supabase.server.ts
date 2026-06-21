// ─── Server-side Supabase client (service role, bypasses RLS) ────────────────
// Only import this in server functions — never in client code.
import { createClient } from "@supabase/supabase-js";

// ─── ConfigError — thrown when required env vars are missing ──────────────────
// Carries a 503 statusCode so TanStack Start surfaces it as "service
// temporarily unavailable" rather than a generic 500 crash.
// The error message is safe to log — it contains no secrets.
export class ConfigError extends Error {
  readonly statusCode = 503;
  constructor(msg: string) {
    super(msg);
    this.name = "ConfigError";
  }
}

// ─── Validate required env vars at call-time (not module load) ────────────────
// Calling at request time (not top-level) is intentional: Cloudflare Workers
// inject secrets into process.env at runtime, not at module evaluation time.
function assertConfigured(): { url: string; serviceRoleKey: string } {
  const url = process.env.VITE_SUPABASE_URL ?? "";
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

  const missing: string[] = [];
  if (!url || url.includes("YOUR_PROJECT")) missing.push("VITE_SUPABASE_URL");
  if (!serviceRoleKey || serviceRoleKey.includes("YOUR_")) missing.push("SUPABASE_SERVICE_ROLE_KEY");

  if (missing.length > 0) {
    throw new ConfigError(
      `[7SEVEN] Required environment variable(s) not configured: ${missing.join(", ")}. ` +
      "Check your Cloudflare Workers secrets or local .env file."
    );
  }

  return { url, serviceRoleKey };
}

function getServerSupabase() {
  const { url, serviceRoleKey } = assertConfigured();
  return createClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

export { getServerSupabase };
