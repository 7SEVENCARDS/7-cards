# 7SEVEN CARDS — Admin Telegram Fallback Channel (Feature Build Prompt)

Paste this into your coding agent as the task brief. It specifies a new feature: a Telegram bot for **admins** (separate from the existing vendor bot) that mirrors the web admin panel's approval queues — push notifications on new pending items, inline-button approve/reject, and read-only lookup commands — so an admin can act without opening the dashboard.

This sits on top of the existing fix list (`7cards-production-readiness-prompt.md`). If item P0-1 in that document (the manual-review payout gate) hasn't been fixed yet, fix it first — this feature is the natural remote-approval lever for that exact queue, and building it on top of the current bypassed gate would just give admins a faster way to rubber-stamp a queue that currently doesn't block anything anyway.

---

## Design decisions (don't deviate without good reason)

**Use a second, separate Telegram bot — not the existing vendor bot.** The vendor bot (`TELEGRAM_BOT_TOKEN`, webhook at `/api/webhooks/telegram`) handles low-privilege vendor replies (claim a card, report a rate). Admin actions approve money movement and KYC. Keep them on separate bot tokens, separate webhook secrets, and a separate webhook path (`/api/webhooks/telegram-admin`) so a compromised vendor-bot secret can never reach admin actions, and so chat-identity resolution never has to disambiguate "is this chat_id a vendor or an admin." New env vars: `ADMIN_TELEGRAM_BOT_TOKEN`, `ADMIN_TELEGRAM_WEBHOOK_SECRET`. Document both in `.env.example` next to the existing `TELEGRAM_*` block, and add them to the `wrangler.toml` secrets checklist comment.

**Reuse existing patterns instead of inventing new ones — this codebase already has working precedents for every primitive this feature needs:**
- Multi-turn conversation state → the `telegram_bot_state` / `telegram_bot_state_at` / `telegram_bot_state_data` FSM columns and stale-state cleanup pattern from `supabase/migrations/017_vendor_rate_check.sql`, and the dispatcher logic in `handleTelegramReply` (`src/server-functions/vendor-broadcast.ts`) that routes an incoming message to the right FSM handler before falling through to default behavior. Mirror this exactly for admins (e.g. `awaiting_rejection_reason` state) instead of building a new state-machine convention.
- Idempotent webhook processing → `processed_webhook_events` (used for Squad webhooks in `src/server-functions/webhooks.ts`). Reuse this same table with `source = 'telegram_admin_callback'` and `event_key = callback_query.id`, rather than creating a parallel dedup table.
- Atomic, race-safe state transitions → the same conditional-update discipline already used for wallet balances (`deduct_wallet_balance` RPC's `SELECT ... FOR UPDATE`). Every approve/reject action must be a single conditional `UPDATE ... WHERE id = $1 AND status = $expected_current_status`, checking the affected row count — this is what makes it safe for two admins to tap "Approve" on the same item at the same time (see "Race handling" below).
- Audit logging → `logAdminAction()` from `lib/auth-server.ts`. Every action taken via Telegram must call this exactly as the web admin panel does, with `meta: { via: "telegram", telegram_chat_id, telegram_message_id }` so the audit trail shows the channel.
- Outbound HTTP → `fetchWithTimeout()`. (Note: while you're in `lib/telegram.ts`, also fix the pre-existing gap where `sendTelegramMessage`/`registerTelegramWebhook` use raw `fetch()` instead of `fetchWithTimeout()` — call this out in your PR description as a drive-by fix, it's item P1-8 in the production-readiness doc.)
- Don't call into `admin.ts`/`vendors.ts` business logic twice. The Telegram handler should call the *same* underlying functions the web panel calls (`approveManualTrade`, `rejectManualTrade`, `adminApproveWithdrawal`, `adminRejectWithdrawal`, `approveKYC`, `rejectKYC`, `adminApproveVendorRate`, `adminRejectVendorRate`, `adminReactivateVendor`) so there is exactly one implementation of "what does approval do," not two that can drift apart. Since those are `createServerFn` handlers gated by `requireAdmin()` (which reads a session cookie), you'll need to refactor each into a plain exported function (e.g. `approveManualTradeImpl(adminId, tradeId)`) that both the `createServerFn` wrapper and the Telegram handler call directly — same pattern `webhooks.ts` already uses by calling into `lib/db-helpers.ts` functions rather than duplicating logic inline.

---

## 1. Admin ↔ Telegram identity linking

Telegram chat IDs are not trustworthy on their own — don't let anyone who DMs the bot claim to be an admin. Use an explicit, expiring, single-use linking code generated from an already-authenticated web session.

**New tables (migration `020_admin_telegram.sql`, idempotent like the existing migrations):**

```sql
CREATE TABLE IF NOT EXISTS admin_telegram_links (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id          UUID NOT NULL REFERENCES profiles(id),
  telegram_chat_id  BIGINT NOT NULL,
  telegram_username TEXT,
  linked_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT admin_telegram_links_chat_unique UNIQUE (telegram_chat_id)
);

CREATE TABLE IF NOT EXISTS admin_telegram_link_codes (
  code        TEXT PRIMARY KEY,
  admin_id    UUID NOT NULL REFERENCES profiles(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ
);
```

(One admin may link more than one device/chat — that's fine, just keep `telegram_chat_id` unique so a chat can't be bound to two different admins.)

**Server functions (`src/server-functions/admin-telegram.ts`, new file):**
- `generateAdminTelegramLinkCode` — `requireAdmin()`, generates a random 8-character code, 10-minute expiry, inserts into `admin_telegram_link_codes`, returns the code and the bot's deep link (`https://t.me/<bot_username>?start=<code>`) for the web panel to show as a QR code / copyable string.
- Add a small "Connect Telegram" card to `AdminScreen.tsx` that calls this and displays the code/link, plus a list of currently-linked chats (from `admin_telegram_links`) with an unlink button.

**Admin bot webhook handling of `/start <code>` or `/link <code>`:** look up the code, reject if missing/expired/used, insert into `admin_telegram_links` (chat_id from the incoming update), mark the code `used_at`, reply with a confirmation message and a short list of available commands.

---

## 2. Extend the Telegram webhook to handle button taps, not just text

`handleTelegramWebhook` in `src/server-functions/webhooks.ts` currently only branches on `update.message` — Telegram's `callback_query` updates (sent when a user taps an inline keyboard button) are silently ignored. You need a parallel path for the admin bot:

- New route in `server.ts`: `POST /api/webhooks/telegram-admin`, validated against `ADMIN_TELEGRAM_WEBHOOK_SECRET` via the `x-telegram-bot-api-secret-token` header, same pattern as the existing Telegram route, with its own rate-limit bucket (`rlKey("telegram_admin_webhook", ip)`).
- New handler `handleAdminTelegramWebhook(request)` in a new `src/server-functions/admin-telegram-webhook.ts` (or alongside the link-code functions) that parses both `update.message` (text commands, `/link`, `/queue`, `/trade <id>`, etc.) and `update.callback_query` (button taps: `approve:<type>:<id>`, `reject:<type>:<id>`, `reason:<canned-reason-key>`).
- Callback data format: keep it short and structured, e.g. `mr_approve:<tradeId>` / `mr_reject:<tradeId>` / `wd_approve:<withdrawalId>` / `kyc_approve:<userId>` / `vr_approve:<rateId>` — Telegram caps callback_data at 64 bytes, so use short type prefixes, not full words.
- On every `callback_query`, call Telegram's `answerCallbackQuery` immediately (even before your DB work finishes, or right after — within Telegram's expected response window) so the admin's tap doesn't show a stale loading spinner, and edit the original message (`editMessageText` / `editMessageReplyMarkup`) to reflect the outcome.

---

## 3. Notification triggers — wire into the existing approve/reject flows

Add a `notifyAdminsTelegram(...)` helper that fans a message out to every row in `admin_telegram_links`, and records each sent copy (so you can edit/resolve all admins' copies later, not just the one who acted):

```sql
CREATE TABLE IF NOT EXISTS admin_telegram_notifications (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_type          TEXT NOT NULL,   -- 'manual_review' | 'withdrawal' | 'kyc' | 'vendor_rate' | 'dispute'
  item_id            UUID NOT NULL,
  telegram_chat_id   BIGINT NOT NULL,
  telegram_message_id BIGINT NOT NULL,
  resolved_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Fire a notification (with inline Approve/Reject buttons) whenever:
- A trade enters `pending_review` (the new status from production-readiness item P0-1) — include brand, USD amount, user's KYC status, and why it needs review (Reloadly endpoint unavailable vs. not configured), masked card code (e.g. last 4 chars only — see PII note below).
- A new vendor withdrawal request is created (`requestWithdrawal`).
- A new KYC submission completes (`submitKYC`), or BVN/NIN auto-verification fails the name cross-check in `verifyBVN`/`verifyNIN` and needs a human look.
- A vendor rate-change request needs approval (`adminGetVendorRates` queue / the flow behind `adminApproveVendorRate`).
- `runFraudAudit` in `lib/fraud-detection.ts` produces a `fraud_confirmed` or `inconclusive` verdict — this already auto-enforces on `fraud_confirmed`, so this notification is informational ("here's what just got auto-actioned, tap to review/reverse") rather than awaiting approval; give it a single "View / Reverse" button that routes to `adminReactivateVendor` if the admin determines it was a false positive. `system_error`/`inconclusive` verdicts get a "needs manual look" notification with no auto-action.
- A Squad payout webhook reports `transfer.failed` (`handleSquadPayoutWebhook` in `webhooks.ts`) — ops-visibility alert, no action buttons needed, just so admins aren't blind to failed payouts between dashboard checks.

When any item resolves (approved/rejected/reactivated, whether via Telegram or the web panel), look up all rows in `admin_telegram_notifications` for that `(item_type, item_id)`, edit every admin's copy of the message to show the resolution and who actioned it, and set `resolved_at`. This is what prevents the "two admins approve the same withdrawal" confusion — the moment one acts, everyone's copy updates.

---

## 4. Race handling — two admins (or admin + Telegram + web panel) act on the same item

Don't gate on "has anyone clicked yet" with a boolean flag checked-then-set (classic TOCTOU race). Make the underlying mutation itself conditional and check the row count, e.g.:

```ts
const { data, error } = await db
  .from("trades")
  .update({ status: "verified", requires_manual_review: false })
  .eq("id", tradeId)
  .eq("status", "pending_review")   // only succeeds if still pending
  .select("id")
  .maybeSingle();

if (!data) {
  // already resolved by someone else — tell this admin, don't re-process
}
```

Apply the same `.eq("status", expectedCurrentStatus)` guard to withdrawal approval, KYC approval, and vendor-rate approval. Whichever caller's conditional update affects zero rows loses the race and gets an "already handled by <admin name>" reply (look up the action from `admin_audit_log` to tell them who/when) instead of a generic error. Write a test that fires two concurrent `approveManualTradeImpl` calls (or web + Telegram simultaneously) against the same trade and asserts exactly one succeeds and the wallet is credited exactly once.

---

## 5. Read-only commands ("view what's with updates")

Implement these as text commands on the admin bot, each calling the same `requireAdmin`-gated logic the web panel uses (factor out an internal version that takes `adminId` directly instead of reading it from a cookie, same refactor as section "Design decisions" above):

- `/queue` or `/pending` — one summary message with counts per queue (manual review, KYC, withdrawals, vendor rate changes, open disputes) mirroring `getAdminStats`, each count as a button that drills into that queue.
- `/reviews`, `/kyc`, `/withdrawals`, `/disputes`, `/rates` — list up to 5 oldest-first pending items in that queue, each with inline Approve/Reject (or, for disputes, a "View" link to the dashboard rather than direct buttons, since dispute resolution involves judgment calls beyond a binary approve/reject).
- `/trade <id>`, `/vendor <id>`, `/dispute <id>` — direct lookup, read-only, formatted summary (status, amounts, timestamps, audit trail event count). Validate the `<id>` is a UUID before querying (reuse `assertUuid` from `lib/validate.ts`) and reply with a clear "not found" rather than leaking a raw DB error.
- `/stats` — mirrors `getAdminStats` (today's volume, active vendor count, spread revenue) for a quick pulse-check without opening the dashboard.
- `/unlink` — removes this chat from `admin_telegram_links`.

---

## 6. PII handling on Telegram messages

Telegram messages live on a third-party platform and persist on the admin's phone outside your infrastructure's access controls. Don't put full sensitive values in Telegram message bodies if a masked preview is enough to make the approve/reject decision:

- Gift card codes: show only the last 4 characters in the notification (`••••••1234`), with a "View full card on dashboard" button linking to the relevant admin route, rather than the full code Telegram-side.
- BVN/NIN: never send raw values (the codebase already masks these before storing — reuse `maskBVN`/`maskNIN` from `lib/dojah.ts` for the Telegram preview too).
- Bank account numbers (withdrawal requests): show masked (`••••5678`) with full details behind the dashboard link.

---

## 7. Testing

Add `src/__tests__/admin-telegram.test.ts` covering, at minimum:
- Link-code flow: valid code links successfully and is single-use; expired code is rejected; reused code is rejected.
- Callback idempotency: the same `callback_query.id` delivered twice (Telegram does retry on slow acks) only processes once.
- The race-handling conditional update from section 4 — concurrent approve attempts, exactly one wins.
- An unauthenticated/unlinked chat ID sending `/queue` or any approve/reject command gets a clear "not linked" response, not an error and not silent processing.
- Webhook secret validation on `/api/webhooks/telegram-admin` mirrors the existing `webhook-security.test.ts` coverage for the vendor webhook.

---

## Definition of done

1. Admin can generate a link code from the web panel, link a Telegram chat, and receive a confirmation message.
2. A trade entering `pending_review` produces a Telegram notification with masked card details and working inline Approve/Reject buttons; tapping Approve runs the exact same code path as the web panel's `approveManualTrade` (verified by checking `admin_audit_log` shows identical `meta` shape with `via: "telegram"` appended) and credits the wallet exactly once.
3. Two admins linked to two different chats, both tapping Approve on the same item within a second of each other, results in exactly one approval and the second admin sees "already handled by <name>."
4. `/queue`, `/trade <id>`, `/vendor <id>`, `/stats` all return live data matching what the web dashboard shows for the same item, with no PII over-exposure per section 6.
5. The vendor bot and admin bot are fully isolated — confirm a vendor's `telegram_chat_id` cannot trigger any admin webhook handler even if they message the admin bot, and vice versa.
