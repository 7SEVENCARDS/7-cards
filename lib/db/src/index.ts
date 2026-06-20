// ─────────────────────────────────────────────────────────────────────────────
// Shared Supabase database client
// Uses the service-role key so it bypasses RLS — only use server-side.
// ─────────────────────────────────────────────────────────────────────────────

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl  = process.env.VITE_SUPABASE_URL        ?? process.env.SUPABASE_URL ?? "";
const supabaseKey  = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

if (!supabaseUrl) {
  throw new Error(
    "VITE_SUPABASE_URL (or SUPABASE_URL) must be set. " +
    "Add it to your environment secrets."
  );
}
if (!supabaseKey) {
  throw new Error(
    "SUPABASE_SERVICE_ROLE_KEY must be set. " +
    "Add it to your environment secrets."
  );
}

let _client: SupabaseClient | undefined;

export function getDb(): SupabaseClient {
  if (!_client) {
    _client = createClient(supabaseUrl, supabaseKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return _client;
}

export type { SupabaseClient };
