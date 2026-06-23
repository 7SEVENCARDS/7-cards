#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Seed Admin User
//
// 1. Creates (or updates) the admin Supabase auth account
// 2. Sets app_metadata.role = 'admin' (works immediately, no migrations needed)
// 3. Upserts profiles.role = 'admin' via direct SQL if SUPABASE_DB_URL is set
//
// Required env vars (stored as GitHub Secrets):
//   VITE_SUPABASE_URL        — Supabase project URL
//   SUPABASE_SERVICE_ROLE_KEY — Service-role key (bypasses RLS)
//   ADMIN_EMAIL              — Email the admin will log in with
//   ADMIN_PASSWORD           — Password the admin will log in with
//
// Optional (enables direct-SQL profiles upsert):
//   SUPABASE_DB_URL          — postgres:// connection string
// ─────────────────────────────────────────────────────────────────────────────

import { execSync } from "node:child_process";

const SUPABASE_URL    = process.env.VITE_SUPABASE_URL?.replace(/\/$/, "");
const SERVICE_KEY     = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_EMAIL     = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD  = process.env.ADMIN_PASSWORD;
const DB_URL          = process.env.SUPABASE_DB_URL;

const missing = ["VITE_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "ADMIN_EMAIL", "ADMIN_PASSWORD"]
  .filter((k) => !process.env[k]);
if (missing.length) {
  console.error("✗ Missing required env vars:", missing.join(", "));
  process.exit(1);
}

const authHeaders = {
  Authorization: `Bearer ${SERVICE_KEY}`,
  apikey: SERVICE_KEY,
  "Content-Type": "application/json",
};

// ── 1. Create or find the auth user ──────────────────────────────────────────
console.log(`\n[1/4] Creating auth user: ${ADMIN_EMAIL}`);

let userId = null;

const createRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
    email_confirm: true,
  }),
});
const createData = await createRes.json();

if (createRes.ok) {
  userId = createData.id;
  console.log("✓ Created new auth user:", userId);
} else {
  console.log("  User may already exist:", createData.msg || createData.message || JSON.stringify(createData));

  let page = 1;
  outer: while (true) {
    const listRes = await fetch(
      `${SUPABASE_URL}/auth/v1/admin/users?page=${page}&per_page=1000`,
      { headers: authHeaders }
    );
    if (!listRes.ok) {
      console.error("✗ Failed to list users:", await listRes.text());
      process.exit(1);
    }
    const listData = await listRes.json();
    const users = listData.users ?? (Array.isArray(listData) ? listData : []);
    if (users.length === 0) break;
    const found = users.find((u) => u.email?.toLowerCase() === ADMIN_EMAIL.toLowerCase());
    if (found) {
      userId = found.id;
      break outer;
    }
    if (users.length < 1000) break;
    page++;
  }

  if (!userId) {
    console.error("✗ Could not locate existing user with email:", ADMIN_EMAIL);
    process.exit(1);
  }
  console.log("✓ Found existing user:", userId);
}

// ── 2. Update password + confirm email ───────────────────────────────────────
console.log("\n[2/4] Updating password and confirming email…");
const updateRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
  method: "PUT",
  headers: authHeaders,
  body: JSON.stringify({
    password: ADMIN_PASSWORD,
    email_confirm: true,
    app_metadata: { role: "admin" },
  }),
});
if (updateRes.ok) {
  console.log("✓ Password updated, email confirmed, app_metadata.role = 'admin' set");
} else {
  console.warn("⚠ User update returned:", await updateRes.text());
}

// ── 3. Upsert profiles.role = 'admin' via direct SQL (if DB URL available) ────
if (DB_URL) {
  console.log("\n[3/4] Upserting profiles.role via direct SQL…");
  const sql = `INSERT INTO profiles (id, role, full_name) VALUES ('${userId}', 'admin', 'Admin') ON CONFLICT (id) DO UPDATE SET role = 'admin';`;
  try {
    const out = execSync(`psql "$SUPABASE_DB_URL" -c "${sql}"`, {
      env: { ...process.env, PGSSLMODE: "require" },
      stdio: "pipe",
    }).toString();
    console.log("✓ profiles.role = 'admin' set via SQL:", out.trim());
  } catch (e) {
    const msg = (e.stderr?.toString() || e.message || "").split("\n")[0];
    console.warn("⚠ profiles SQL skipped (non-fatal):", msg);
    console.warn("  Admin access via app_metadata.role = 'admin' is already active.");
  }
} else {
  console.log("\n[3/4] Skipping profiles SQL upsert (SUPABASE_DB_URL not set)");
  console.log("  app_metadata.role = 'admin' is set as fallback — admin routes will work.");
}

// ── 4. Verify ─────────────────────────────────────────────────────────────────
console.log("\n[4/4] Verifying…");
const verifyRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
  headers: authHeaders,
});
if (!verifyRes.ok) {
  console.error("✗ Could not fetch user for verification");
  process.exit(1);
}
const verifyData = await verifyRes.json();
const appRole = verifyData.app_metadata?.role;
const emailConfirmed = !!verifyData.email_confirmed_at;

if (appRole !== "admin") {
  console.error("✗ Verification failed — app_metadata.role is:", JSON.stringify(appRole));
  process.exit(1);
}
if (!emailConfirmed) {
  console.warn("⚠ Email not yet confirmed — login may require email verification");
}

console.log("\n✅ Admin seeded successfully!");
console.log("   Email:           ", ADMIN_EMAIL);
console.log("   User ID:         ", userId);
console.log("   app_metadata.role:", appRole, "✓");
console.log("   Email confirmed: ", emailConfirmed ? "yes ✓" : "no (check Supabase dashboard)");
console.log("\nLog in at: https://7evencards.xyz");
