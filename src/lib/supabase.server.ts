// ─── Server-side Supabase client (service role, bypasses RLS) ────────────────
// Only import this in server functions — never in client code.
import { createClient } from "@supabase/supabase-js";

function getServerSupabase() {
  const url = process.env.VITE_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey || url.includes("YOUR_PROJECT")) {
    throw new Error(
      "[7SEVEN] Supabase server not configured. Set VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables."
    );
  }

  return createClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

export { getServerSupabase };
