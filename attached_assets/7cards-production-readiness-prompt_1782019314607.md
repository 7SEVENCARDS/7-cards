# 7SEVEN CARDS — Production Readiness Fix List

Paste this whole document into your coding agent (Claude Code, Cursor, etc.) as the task brief. It's ordered by severity. Each item names the exact file/function, explains *why* it matters, and states what "done" looks like so the agent can self-verify instead of guessing.

---

## How to work through this

This is a fintech app that already moves real money (gift-card payouts, crypto swaps, vendor settlements) over Squad, Reloadly, Busha, and a vendor network. The existing codebase is well above average — atomic wallet RPCs, HMAC-verified webhooks, an immutable hash-chained audit log, an automated fraud-enforcement engine. Don't rewrite what's working. Fix the specific gaps below, write a regression test for each one, and don't mark anything "done" until you can show the broken path now fails closed instead of open.

Work top-down. P0 items are exploitable today with real financial impact — fix and verify those before touching anything else. Do not deploy to production until all P0 items are closed.

---

## P0 — Money-safety blockers (fix before any real traffic)

### 1. Manual-review verdict never actually blocks payout

**Files:** `src/server-functions/trades.ts` (`verifyGiftCard`, `processPayout`, `submitCardBatch`), `src/server-functions/admin.ts` (`getManualReviewQueue`, `approveManualTrade`)

**The bug:** `verifyUserGiftCard()` in `lib/reloadly.ts` returns `requiresManualReview: true` whenever Reloadly's redeem-codes endpoint isn't available at the account's tier, or when Reloadly isn't configured at all — and the code comment says this is "standard practice for Nigerian gift card trading platforms," meaning it *will* happen routinely in production, not just in edge cases.

When that happens, `verifyGiftCard` still sets `trades.status = "verified"` (it only stores `requires_manual_review: true` as a side flag). `processPayout`'s only authorization check is:

```ts
if (trade.status !== "verified") {
  return { success: false, reason: `Trade is not verified (status: ${trade.status}).` };
}
```

It never checks `requires_manual_review`. So a user can call `processPayout` immediately after `verifyGiftCard` returns and get paid out — bank transfer or wallet credit — *before* any admin has looked at the manual-review queue. The admin UI (`approveManualTrade`'s notification text: "Proceed to submit for payout") assumes review happens first; nothing enforces that.

`submitCardBatch` (the multi-card batch flow) is worse: it doesn't even capture `requiresManualReview` from the Reloadly result — it treats `result.success` as fully verified and immediately dispatches the card to a vendor over Telegram, who will pay the user real NGN via VAN transfer. There is no review gate on this path at all.

**Fix:**
- Introduce a real status, e.g. `pending_review`, distinct from `verified`. When `requiresManualReview` is true, set the trade to `pending_review`, not `verified`.
- `processPayout` must reject any trade where `status !== "verified"` (already does) **and** explicitly reject `requires_manual_review === true` as defense in depth, in case status ever gets set incorrectly elsewhere.
- `submitCardBatch` must read `requiresManualReview` off the Reloadly result, set the per-card trade to `pending_review` when true, and skip vendor dispatch for that card until an admin approves it via the existing `approveManualTrade` flow (extend that admin action to also trigger the deferred vendor dispatch).
- Add a DB constraint or trigger so `requires_manual_review = true` and `status = 'paid'` can never coexist — belt and suspenders, consistent with how this codebase already does positive-amount and non-negative-balance constraints.
- Write a test that asserts: given a Reloadly response with `requiresManualReview: true`, calling `processPayout` (or the batch dispatch path) on that trade fails until `approveManualTrade` has run.

### 2. Demo-mode fallbacks gated on `NODE_ENV` — verify this actually holds at Worker runtime

**Files:** `src/server-functions/{kyc,trades,crypto,premium,payout-accounts,vendors}.ts`, `wrangler.toml`

Several payment/KYC/payout paths fall back to auto-crediting wallets or faking a payout when a provider call fails with a message containing "not configured," gated by `process.env.NODE_ENV === "production"`. `NODE_ENV` is set at build time in `.github/workflows/deploy.yml`, but this app runs on Cloudflare Workers via Nitro's `cloudflare-module` preset — confirm `process.env.NODE_ENV` is actually `"production"` at *request-handling* time inside the deployed Worker, not just baked into the client bundle.

**Fix:**
- Add `NODE_ENV = "production"` explicitly to `[env.production.vars]` in `wrangler.toml` — don't rely on inference.
- Add a startup/health-check assertion (e.g. extend `/api/health`) that reports the resolved `NODE_ENV` value so you can verify in the live environment, not just locally.
- Better: replace the string-matching `msg.includes("not configured")` demo-mode gate with an explicit `IS_DEMO_MODE` env var that defaults to `false` and must be deliberately set — don't infer "is this a demo" from an error message substring, which is fragile and could misfire on unrelated errors.
- Write an integration test that simulates a provider throwing a "not configured" error in a build with `NODE_ENV=production` and asserts the trade fails closed (no wallet credit, no fake "paid" status) rather than falling into demo mode.

### 3. Suspended vendors can still process existing assignments

**File:** `src/server-functions/vendors.ts` — `getMyAssignments`, `markAssignmentRedeemed`, `markAssignmentFailed`, `getVendorWallet`, `getActiveVirtualAccounts`, `provisionVirtualAccount`

These six functions call `requireUser()` + a manual `getVendorId(db, userId)` lookup that only checks the vendor row exists — it never checks `vendor.status`. `requireVendorAuth()` (already defined in `lib/auth-server.ts` and correctly used elsewhere, e.g. `requestWithdrawal`) does check and rejects `status === 'suspended'`. New-assignment dispatch already filters on `status = 'active'` so a suspended vendor won't receive new cards, and withdrawals are correctly blocked — but a vendor the fraud-enforcement engine just suspended can still call `markAssignmentRedeemed` on a pre-existing assignment and have their internal wallet credited.

**Fix:** Replace `requireUser()` + `getVendorId()` with `requireVendorAuth()` in all six functions. Keep the `vendor.id` you get back from it for the subsequent queries (it returns the same shape). Add a regression test: a suspended vendor's session should get a 403 from each of these six endpoints, matching the existing behavior already tested for `requestWithdrawal`.

### 4. `refreshExchangeRates` has no auth check

**File:** `src/server-functions/rates.ts`

It's a public POST endpoint that calls the Reloadly products API and upserts `exchange_rates`. Every other admin/cron-triggered job in this codebase is gated (`requireAdmin()`, or the `x-cron-secret` header pattern used for `/api/cron/rate-check` in `server.ts`) — this one was missed.

**Fix:** Gate it the same way `/api/cron/rate-check` is gated, or wrap it in `requireAdmin()` and call it only from `getAdminRates`/`bulkUpdateRates` admin flows. Add a test asserting an unauthenticated call returns 401/403.

---

## P1 — Platform hardening (fix before scaling traffic)

### 5. No runtime input validation on ~14 of 15 server-function files

`zod` is a dependency but is never imported anywhere in `src`. Every `.validator()`/`.inputValidator()` callback across `src/server-functions/*.ts` (96 call sites) is a TypeScript-only identity pass-through, e.g. `(d: { amount: number }) => d` — this provides compile-time typing only; at runtime any JSON shape is accepted. Only `kyc.ts` and `vendors.ts` use the hand-rolled helpers in `lib/validate.ts`, and even there it's partial.

**Fix:** Write zod schemas for every server-function input and parse with `.parse()` (not just cast) inside each `.validator()`/`.inputValidator()` callback, throwing a 422 on failure (reuse the `badInput()` pattern already in `lib/validate.ts` for the error shape). Prioritize the money-touching functions first: `submitCardBatch`, `createTrade`, `verifyGiftCard`, `processPayout`, `initiateCryptoSwap`, `initiateCryptoSend`, everything in `admin.ts` and `vendors.ts` that takes a `userId`/`vendorId`/amount. Co-locate schemas near each server-function file or in a shared `src/lib/schemas.ts` — your call, but be consistent. Add at least one test per money-touching function asserting malformed input (negative amount, oversized array, wrong type) is rejected with a 422, not silently coerced.

### 6. No real production error monitoring

**Files:** `src/lib/lovable-error-reporting.ts`, `src/lib/error-capture.ts`

`reportLovableError` only forwards into `window.__lovableEvents`, which exists inside the Lovable editor's iframe and will be `undefined` in the actual deployed app. `error-capture.ts` is a 5-second in-memory buffer used to recover stack traces for one SSR error-formatting edge case — neither is a real APM/error-tracking service.

**Fix:** Wire in a real error monitoring service (Sentry's Cloudflare Workers SDK is the standard choice and has first-class support for this exact deployment target). Capture: unhandled exceptions in `server.ts`'s catch block, every `console.error` currently scattered through `webhooks.ts`/`fraud-detection.ts`/`vendors.ts` (search for `console.error(` — there are dozens), and client-side React error boundaries. Keep `lovable-error-reporting.ts` for the editor-preview case if you want, but don't rely on it for production.

### 7. Rate limiting is per-isolate, not distributed

**File:** `src/lib/rate-limiter.ts`

The in-memory `Map`-based limiter is explicitly documented as per-Worker-isolate — on Cloudflare, that means it does not enforce a true global limit across instances; an attacker spread across edge locations/isolates gets effectively higher limits than configured.

**Fix:** `wrangler.toml` already has the Workers Rate Limiting binding blocks commented out at the bottom — uncomment them, create the namespaces (`wrangler rate-limit create ...` as documented inline), and switch the call sites in `server.ts` and `kyc.ts`/`vendors.ts` to use `env.RATE_LIMITER_*.limit({ key })` instead of `allow()`. Keep `allow()` as a local fallback for `vite dev` if useful, but production should use the binding.

### 8. Inconsistent timeout handling on outbound calls

**Files:** `src/lib/onesignal.ts`, `src/lib/telegram.ts`

`fetch-with-timeout.ts`'s own header comment says every external call (Reloadly, Squad, Dojah, Busha) must go through it — and Reloadly/Squad/Dojah/Busha do — but `onesignal.ts` and `telegram.ts` both use raw `fetch()` with no abort timeout. `sendTelegramMessage` is `await`ed directly inside `fraud-detection.ts`'s enforcement path, so a hung Telegram API call could stall fraud enforcement.

**Fix:** Route both through `fetchWithTimeout()` for consistency with the rest of the codebase.

---

## P2 — Compliance, cleanup, and maintainability

### 9. No real Terms of Service / Privacy Policy

`AuthScreen.tsx` has one line of text ("By continuing you agree to our Terms of Service and Privacy Policy") with no linked document. Given this app collects BVN/NIN and moves money, you need an actual privacy policy (Nigeria's NDPR applies) and ToS before launch. This isn't something the coding agent can write the legal content for — flag it back to the business owner — but the agent should add the actual page/route and link it once content exists, rather than leaving a dangling promise in the UI.

### 10. Hardcoded USD/NGN conversion duplicated across files

**Files:** `src/lib/db-helpers.ts` (`WEEKLY_THRESHOLD_NGN = 25 * 1485`, `MONTHLY_THRESHOLD_NGN = 50 * 1485`), `src/server-functions/rates.ts` (fallback `1485`), `src/lib/reloadly.ts` (`return 1485` fallback in two places)

The verification-allowance thresholds hardcode the same magic exchange rate that lives independently as a fallback elsewhere. If the real rate drifts, these limits silently go stale relative to actual pricing.

**Fix:** Pull this from a single source of truth — either compute the thresholds in USD and convert using the live rate from `exchange_rates` at check time, or centralize the fallback constant in one exported `FALLBACK_USD_NGN_RATE` and import it everywhere instead of repeating the literal `1485`.

### 11. Dead scaffolding folders should be removed

- `7cards/` (top-level) — 3 orphaned files (`CryptoScreen.tsx`, `useAppData.ts`, `index.tsx`) disconnected from the real app under `src/`.
- `artifacts/api-server/` and `lib/db/` — an Express + Drizzle-style scaffold from a monorepo template; `artifacts/api-server` imports `@workspace/api-zod`, which doesn't exist anywhere in this repo, so it can't even build. Neither is referenced by the real TanStack Start app in `src/`.

**Fix:** Delete both, or if there's a real future plan for a separate API server, move it to its own repo/branch so it doesn't sit in the main tree looking like live code.

### 12. Pin `nitro` off its beta version

**File:** `package.json` — `"nitro": "3.0.260603-beta"`

A beta release of the core build/runtime tool is a real-but-deferrable risk for a money-moving app. Track Nitro's release notes and pin to the first stable 3.x release before go-live; re-run the full build + smoke test suite after the bump since beta-to-stable can include breaking changes.

---

## P3 — Test coverage

Current coverage is 3 files: `auth-server.test.ts` (error class shapes), `security.test.ts` (input shape contracts), `webhook-security.test.ts` (signature verification + idempotency). None of these exercise the actual business logic.

**Add tests for, at minimum:**
- The manual-review gate fix from item 1 (most important — this is the bug that motivated this whole list).
- `submitCardBatch` end-to-end: vendor assignment rotation, queued vs. immediate dispatch, partial-batch failure handling.
- `markAssignmentFailed` → `runFraudAudit` → `autoEnforceFraudVerdict`: assert deposit forfeiture and suspension actually fire on a `fraud_confirmed` verdict, and don't fire on `inconclusive`/`system_error`.
- `deduct_wallet_balance`/`increment_wallet_balance` RPC behavior under concurrent calls (you can test this against a local Supabase instance — two simultaneous deduct calls against a balance that can only satisfy one should result in exactly one success).
- Referral commission crediting (`creditReferrerCommissionFn`) — correct 5% calculation, no double-crediting on retried webhook delivery.
- KYC name cross-check (`namesMatch`) edge cases — reversed name order, middle names, diacritics.

---

## Non-code blocker — flag, don't try to code around

Crypto buy/sell and gift-card-for-cash trading both sit in legally sensitive territory in Nigeria (CBN and SEC have shifted positions on crypto multiple times; P2P gift-card trading is a known fraud vector regulators watch). This is a business/legal question, not an engineering one — get it answered by someone qualified before driving real volume through this, independent of how clean the code is.

---

## Definition of done

Before calling this production-ready:

1. All four P0 items have a passing regression test that fails on the pre-fix code and passes on the post-fix code.
2. A full `bun run build --mode development` + `bun run test` + `bun run lint` passes clean (not `continue-on-error`, as lint currently is in CI).
3. You've done one real end-to-end dry run against Squad/Reloadly/Busha/Dojah **sandbox** credentials (not demo mode) and confirmed: a gift card flagged for manual review cannot be paid out until approved; a webhook retried twice only credits once; a suspended vendor is rejected by all vendor endpoints, not just withdrawal.
4. Error monitoring is live and you've manually triggered one exception path to confirm it actually reports.
5. `NODE_ENV` resolved value has been confirmed inside the deployed Worker, not just assumed from the build step.
