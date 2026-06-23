#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Seed Admin User
//
// 1. Creates (or updates) the admin Supabase auth account
// 2. Upserts profiles.role = 'admin' via direct SQL (psql) if SUPABASE_DB_URL
//    is set, with PostgREST as fallback
//
// Required env vars (all stored as GitHub Secrets):
//   VITE_SUPABASE_URL        — Supabase project URL
//   SUPABASE_SERVICE_ROLE_KEY — Service-role key (bypasses RLS)
//   ADMIN_EMAIL              — Email the admin will log in with
//   ADMIN_PASSWORD           — Password the admin will log in with
//
// Optional (enables direct-SQL path which avoids PostgREST schema-cache issues):
//   SUPABASE_DB_URL          — postgres:// connection string
// ─────────────────────────────────────────────────────────────────────────────

import { execSync } from "node:child_process";

const SUPABASE_URL   = process.env.VITE_SUPABASE_URL?.replace(/\/$/, "");
const SERVICE_KEY    = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_EMAIL    = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const DB_URL         = process.env.SUPABASE_DB_URL; // optional

const missing = ["VITE_SUPABASE_URL","SUPABASE_SERVICE_ROLE_KEY","ADMIN_EMAIL","ADMIN_PASSWORD"]
  .filter(k => !process.env[k]);
if (missing.length) {
  console.error("✗ Missing required env vars:", missing.join(", "));
  process.exit(1);
}

const authHeaders = {
  Authorization: `Bearer ${SERVICE_KEY}`,
  apikey: SERVICE_KEY,
  "Content-Type": "application/json",
};

// ── 1. Create the auth user (auto-confirms email) ─────────────────────────────
console.log(`\n[1/3] Creating auth user: ${ADMIN_EMAIL}`);

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
  console.log("  User already exists, searching by email…");
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
    const found = users.find(u => u.email?.toLowerCase() === ADMIN_EMAIL.toLowerCase());
    if (found) { userId = found.id; break outer; }
    if (users.length < 1000) break;
    page++;
  }

  if (!userId) {
    console.error("✗ Could not locate existing user with email:", ADMIN_EMAIL);
    process.exit(1);
  }
  console.log("✓ Found existing user:", userId);

  const updateRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    method: "PUT",
    headers: authHeaders,
    body: JSON.stringify({ password: ADMIN_PASSWORD, email_confirm: true }),
  });
  if (updateRes.ok) {
    console.log("✓ Password updated and email confirmed");
  } else {
    console.warn("⚠ Could not update user:", await updateRes.text());
  }
}

// ── 2. Upsert profiles.role = 'admin' ─────────────────────────────────────────
console.log(`\n[2/3] Setting profiles.role = 'admin' for user ${userId}`);

if (DB_URL) {
  // Direct SQL path — avoids PostgREST schema-cache issues
  const sql = [
    `INSERT INTO profiles (id, role, full_name)`,
    `VALUES ('${userId}', 'admin', 'Admin')`,
    `ON CONFLICT (id) DO UPDATE SET role = 'admin';`,
  ].join(" ");

  try {
    const out = execSync(`psql "$SUPABASE_DB_URL" -c "${sql}"`, {
      env: process.env,
      stdio: "pipe",
    }).toString();
    console.log("✓ profiles.role = 'admin' set via direct SQL:", out.trim());
  } catch (e) {
    console.error("✗ Direct SQL failed:", e.stderr?.toString() || e.message);
    process.exit(1);
  }
} else {
  // PostgREST fallback
  console.log("  (SUPABASE_DB_URL not set — using PostgREST REST API)");
  const patchRes = await fetch(
    `${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}`,
    {
      method: "PATCH",
      headers: { ...authHeaders, Prefer: "return=representation" },
      body: JSON.stringify({ role: "admin" }),
    }
  );
  if (patchRes.ok) {
    const rows = await patchRes.json();
    if (rows.length > 0) {
      console.log("✓ profiles.role = 'admin' updated via PATCH");
    } else {
      // Row didn't exist — insert
      const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles`, {
        method: "POST",
        headers: { ...authHeaders, Prefer: "return=minimal" },
        body: JSON.stringify({ id: userId, role: "admin", full_name: "Admin" }),
      });
      if (insertRes.ok || insertRes.status === 201) {
        console.log("✓ profiles row inserted with role = 'admin'");
      } else {
        console.error("✗ profiles INSERT failed:", await insertRes.text());
        process.exit(1);
      }
    }
  } else {
    console.error("✗ PATCH profiles failed:", await patchRes.text());
    console.error("  Hint: set SUPABASE_DB_URL secret to enable direct-SQL path.");
    process.exit(1);
  }
}

// ── 3. Verify ─────────────────────────────────────────────────────────────────
console.log(`\n[3/3] Verifying…`);

let role = null;
if (DB_URL) {
  const out = execSync(
    `psql "$SUPABASE_DB_URL" -t -c "SELECT role FROM profiles WHERE id = '${userId}';"`,
    { env: process.env, stdio: "pipe" }
  ).toString().trim();
  role = out;
} else {
  const verRes = await fetch(
    `${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=role`,
    { headers: authHeaders }
  );
  const [row] = await verRes.json();
  role = row?.role;
}

if (role?.trim() !== "admin") {
  console.error("✗ Verification failed — role is:", JSON.stringify(role));
  process.exit(1);
}

console.log("\n✅ Admin seeded successfully!");
console.log("   Email:   ", ADMIN_EMAIL);
console.log("   User ID: ", userId);
console.log("   Role:     admin ✓");
console.log("\nLog in at: https://7evencards.xyz");
