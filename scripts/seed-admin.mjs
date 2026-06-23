#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Seed Admin User
//
// Creates (or updates) the admin Supabase account and sets
// profiles.role = 'admin' so requireAdmin() lets the user through.
//
// Required env vars (all stored as GitHub Secrets):
//   VITE_SUPABASE_URL        — Supabase project URL
//   SUPABASE_SERVICE_ROLE_KEY — Service-role key (bypasses RLS)
//   ADMIN_EMAIL              — Email the admin will log in with
//   ADMIN_PASSWORD           — Password the admin will log in with
// ─────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL  = process.env.VITE_SUPABASE_URL?.replace(/\/$/, "");
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_EMAIL   = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

const missing = ["VITE_SUPABASE_URL","SUPABASE_SERVICE_ROLE_KEY","ADMIN_EMAIL","ADMIN_PASSWORD"]
  .filter(k => !process.env[k]);
if (missing.length) {
  console.error("✗ Missing env vars:", missing.join(", "));
  process.exit(1);
}

const authHeaders = {
  Authorization: `Bearer ${SERVICE_KEY}`,
  apikey: SERVICE_KEY,
  "Content-Type": "application/json",
};

// ── 1. Create the user (auto-confirm email so they can log in immediately) ───
console.log(`\nSeeding admin: ${ADMIN_EMAIL}`);

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
  // User already exists — find them by listing all users and filtering
  console.log("  User exists or error:", createData.msg || createData.message || createData.error_description || JSON.stringify(createData));

  let page = 1;
  while (!userId) {
    const listRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?page=${page}&per_page=1000`, {
      headers: authHeaders,
    });
    if (!listRes.ok) {
      console.error("✗ Failed to list users:", await listRes.text());
      process.exit(1);
    }
    const listData = await listRes.json();
    const users = listData.users ?? listData ?? [];
    if (!Array.isArray(users) || users.length === 0) break;
    const found = users.find(u => u.email?.toLowerCase() === ADMIN_EMAIL.toLowerCase());
    if (found) { userId = found.id; break; }
    if (users.length < 1000) break;
    page++;
  }

  if (!userId) {
    console.error("✗ Could not locate existing user with email:", ADMIN_EMAIL);
    process.exit(1);
  }
  console.log("✓ Found existing user:", userId);

  // Update password + ensure email is confirmed
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

// ── 2. Upsert profiles row with role = 'admin' ────────────────────────────────
// The on_auth_user_created trigger normally creates the row, but it may not
// have fired yet or the seed may run before the first sign-in.

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
  if (Array.isArray(rows) && rows.length > 0) {
    console.log("✓ Set profiles.role = 'admin' (updated existing row)");
  } else {
    // Row didn't exist yet — insert it
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles`, {
      method: "POST",
      headers: { ...authHeaders, Prefer: "return=minimal" },
      body: JSON.stringify({ id: userId, role: "admin", full_name: "Admin" }),
    });
    if (insertRes.ok || insertRes.status === 201) {
      console.log("✓ Inserted profiles row with role = 'admin'");
    } else {
      // Profile might have been created by trigger in the meantime — try patch again
      const retryPatch = await fetch(
        `${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}`,
        {
          method: "PATCH",
          headers: { ...authHeaders, Prefer: "return=minimal" },
          body: JSON.stringify({ role: "admin" }),
        }
      );
      if (retryPatch.ok) {
        console.log("✓ Set profiles.role = 'admin' (retry patch succeeded)");
      } else {
        console.error("✗ Could not upsert profiles row:", await retryPatch.text());
        process.exit(1);
      }
    }
  }
} else {
  console.error("✗ PATCH profiles failed:", await patchRes.text());
  process.exit(1);
}

// ── 3. Verify ─────────────────────────────────────────────────────────────────
const verifyRes = await fetch(
  `${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=id,role,full_name`,
  { headers: authHeaders }
);
const [profile] = await verifyRes.json();
if (profile?.role !== "admin") {
  console.error("✗ Verification failed — profile.role is:", profile?.role);
  process.exit(1);
}

console.log("\n✅ Admin seeded successfully!");
console.log("   Email:   ", ADMIN_EMAIL);
console.log("   User ID: ", userId);
console.log("   Role:    ", profile.role);
console.log("\nLog in at: https://7evencards.xyz");
