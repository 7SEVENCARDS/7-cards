import { createClient } from "@supabase/supabase-js";

let _db: ReturnType<typeof createClient> | null = null;

export function getDb() {
  if (!_db) {
    const url =
      process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
    if (!url || !key) {
      throw new Error(
        "[7Seven API] Supabase not configured. Set VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
      );
    }
    _db = createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return _db;
}

export function getGatewayUserId(): string {
  const id = process.env.API_GATEWAY_USER_ID;
  if (!id) {
    throw new Error(
      "[7Seven API] API_GATEWAY_USER_ID not set. Create a dedicated Supabase auth user for API trades and set this env var to their UUID.",
    );
  }
  return id;
}
