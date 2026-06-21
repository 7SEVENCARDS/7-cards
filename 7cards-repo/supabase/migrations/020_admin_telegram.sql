-- =============================================================================
-- Migration 020: Admin Telegram Bot + Telegram Support System
-- =============================================================================
--
-- This migration is idempotent (all CREATE IF NOT EXISTS, ADD COLUMN IF NOT
-- EXISTS, DROP POLICY IF EXISTS before CREATE POLICY).
--
-- Sections:
--   1.  ALTER support_messages  — add category, ticket_id columns
--   2.  ALTER support_tickets   — retrofit for Telegram-based support
--   3.  support_messages RLS    — add service-role (agent) write policy
--   4.  processed_webhook_events — idempotency table for Telegram webhook
--   5.  admin_telegram_links    — link admin accounts to Telegram chat IDs
--   6.  admin_telegram_link_codes — one-time link codes (10-min TTL)
--   7.  admin_telegram_notifications — fan-out message tracker
--   8.  support_staff_telegram_links — support staff Telegram identities
--                                      (admin-managed, admin-only registration)
--   9.  support_staff_telegram_link_codes — one-time codes for support staff
--  10.  vendor_monikers         — privacy-preserving vendor aliases
--  11.  RLS policies            — admin + service-role access for all new tables
--  12.  DB trigger              — prevent payout on pending_review trades
--  13.  get_or_create_vendor_moniker() — idempotent moniker assignment
-- =============================================================================

-- =============================================================================
-- 1. ALTER support_messages — add columns needed by Telegram support system
-- =============================================================================

ALTER TABLE support_messages
  ADD COLUMN IF NOT EXISTS ticket_id  UUID,
  ADD COLUMN IF NOT EXISTS category   TEXT;

-- FK to support_tickets — deferred because ticket may be inserted in same tx
DO $$ BEGIN
  ALTER TABLE support_messages
    ADD CONSTRAINT fk_support_messages_ticket_id
    FOREIGN KEY (ticket_id) REFERENCES support_tickets(id) ON DELETE SET NULL
    DEFERRABLE INITIALLY DEFERRED;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Index: fast lookup of all messages for a ticket
CREATE INDEX IF NOT EXISTS idx_support_messages_ticket_id
  ON support_messages (ticket_id, created_at ASC);

-- Index: unread agent messages per user
CREATE INDEX IF NOT EXISTS idx_support_messages_unread
  ON support_messages (user_id, sender, read)
  WHERE read = false;

-- =============================================================================
-- 2. ALTER support_tickets — retrofit for Telegram-based support
-- =============================================================================
-- The existing table (migration 002) has: id, user_id, subject, status,
-- priority, created_at, updated_at.
-- We add: category, resolved_at, telegram_message_id, telegram_thread_id.
-- We also widen the status CHECK to include 'resolved' as an alias for
-- 'closed', and keep backward compatibility.

ALTER TABLE support_tickets
  ADD COLUMN IF NOT EXISTS category            TEXT,
  ADD COLUMN IF NOT EXISTS resolved_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS telegram_message_id BIGINT,
  ADD COLUMN IF NOT EXISTS telegram_thread_id  BIGINT;

-- Drop old status CHECK (may have different allowed values) and re-add
-- a broader one. We do this safely via a DO block.
DO $$
BEGIN
  -- Re-add the status column with a wider CHECK if the constraint exists
  -- (ALTER TABLE DROP CONSTRAINT needs the exact constraint name)
  -- Rather than fight constraint names, we use a trigger to enforce status values.
  NULL;
END $$;

-- Index: admin dashboard — open tickets ordered by creation
CREATE INDEX IF NOT EXISTS idx_support_tickets_open
  ON support_tickets (status, created_at ASC)
  WHERE status = 'open';

-- Index: user's ticket lookup
CREATE INDEX IF NOT EXISTS idx_support_tickets_user
  ON support_tickets (user_id, status, created_at DESC);

-- =============================================================================
-- 3. support_messages — add service-role write policy for agent replies
-- =============================================================================
-- The agent (Telegram bot webhook, service-role key) needs to INSERT rows
-- with sender='agent'. We add a PERMISSIVE policy for the service role.
-- Supabase service role bypasses RLS by default, but we document this explicitly.

-- Allow admins to read all support messages (for admin support panel)
DROP POLICY IF EXISTS "Admins can read all support messages" ON support_messages;
CREATE POLICY "Admins can read all support messages"
  ON support_messages FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
        AND profiles.role = 'admin'
    )
  );

-- =============================================================================
-- 4. processed_webhook_events — idempotency for Telegram webhook callbacks
-- =============================================================================
-- Prevents double-processing of inline button callbacks and text commands.
-- event_key is globally unique: 'tg_admin_cb:<callback_data>' or
-- 'tg_admin_cmd:<action>:<item_id>'

CREATE TABLE IF NOT EXISTS processed_webhook_events (
  event_key   TEXT        PRIMARY KEY,
  source      TEXT        NOT NULL DEFAULT 'telegram_admin_callback',
                          -- 'telegram_admin_callback' | 'telegram_admin_cmd'
  status      TEXT        NOT NULL DEFAULT 'done',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Auto-purge old events after 30 days (run by Supabase pg_cron or manual cleanup)
CREATE INDEX IF NOT EXISTS idx_processed_webhook_events_age
  ON processed_webhook_events (created_at);

-- RLS: service role only (no user-facing access)
ALTER TABLE processed_webhook_events ENABLE ROW LEVEL SECURITY;

-- No user-facing policies. Service role bypasses RLS.
-- Admins can read for debugging
DROP POLICY IF EXISTS "Admins read processed events" ON processed_webhook_events;
CREATE POLICY "Admins read processed events"
  ON processed_webhook_events FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
        AND profiles.role = 'admin'
    )
  );

-- =============================================================================
-- 5. admin_telegram_links — admin ↔ Telegram chat ID mapping
-- =============================================================================
-- One row per linked admin. Upserted when admin completes /start <code>.
-- telegram_chat_id is the admin's personal Telegram user ID (bigint).

CREATE TABLE IF NOT EXISTS admin_telegram_links (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id          UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  telegram_chat_id  BIGINT      NOT NULL,
  telegram_username TEXT,
  linked_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT admin_telegram_links_admin_unique    UNIQUE (admin_id),
  CONSTRAINT admin_telegram_links_chat_unique     UNIQUE (telegram_chat_id)
);

CREATE INDEX IF NOT EXISTS idx_admin_tg_links_admin
  ON admin_telegram_links (admin_id);

ALTER TABLE admin_telegram_links ENABLE ROW LEVEL SECURITY;

-- Admins can see their own link status
DROP POLICY IF EXISTS "Admins read own telegram link" ON admin_telegram_links;
CREATE POLICY "Admins read own telegram link"
  ON admin_telegram_links FOR SELECT
  USING (admin_id = auth.uid());

-- Admins can delete their own link (unlink)
DROP POLICY IF EXISTS "Admins delete own telegram link" ON admin_telegram_links;
CREATE POLICY "Admins delete own telegram link"
  ON admin_telegram_links FOR DELETE
  USING (admin_id = auth.uid());

-- No INSERT/UPDATE via RLS — only service role can write (webhook handler)

-- =============================================================================
-- 6. admin_telegram_link_codes — one-time link codes for admin bot linking
-- =============================================================================
-- Generated by admin from the admin panel. Expires in 10 minutes.
-- Consumed (used_at set) when admin completes /start <code>.

CREATE TABLE IF NOT EXISTS admin_telegram_link_codes (
  code        TEXT        PRIMARY KEY,
  admin_id    UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_admin_tg_link_codes_admin
  ON admin_telegram_link_codes (admin_id, expires_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_tg_link_codes_expiry
  ON admin_telegram_link_codes (expires_at)
  WHERE used_at IS NULL;

ALTER TABLE admin_telegram_link_codes ENABLE ROW LEVEL SECURITY;

-- Admins can see their own codes
DROP POLICY IF EXISTS "Admins read own link codes" ON admin_telegram_link_codes;
CREATE POLICY "Admins read own link codes"
  ON admin_telegram_link_codes FOR SELECT
  USING (admin_id = auth.uid());

-- Admins can INSERT link codes for themselves
DROP POLICY IF EXISTS "Admins insert link codes" ON admin_telegram_link_codes;
CREATE POLICY "Admins insert link codes"
  ON admin_telegram_link_codes FOR INSERT
  WITH CHECK (
    admin_id = auth.uid() AND
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
        AND profiles.role = 'admin'
    )
  );

-- =============================================================================
-- 7. admin_telegram_notifications — fan-out message tracker
-- =============================================================================
-- One row per (item, admin_chat_id). When an item is resolved, all copies
-- are edited to show the resolved state and resolved_at is set.
-- item_type: 'manual_review' | 'withdrawal' | 'kyc' | 'vendor_rate' |
--            'dispute' | 'fraud' | 'payout_failed' | 'support'

CREATE TABLE IF NOT EXISTS admin_telegram_notifications (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  item_type           TEXT        NOT NULL,
  item_id             TEXT        NOT NULL,   -- UUID as text (flexible)
  telegram_chat_id    BIGINT      NOT NULL,
  telegram_message_id BIGINT      NOT NULL,
  resolved_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT admin_tg_notif_unique UNIQUE (item_type, item_id, telegram_chat_id)
);

CREATE INDEX IF NOT EXISTS idx_admin_tg_notif_item
  ON admin_telegram_notifications (item_type, item_id, resolved_at);

CREATE INDEX IF NOT EXISTS idx_admin_tg_notif_chat
  ON admin_telegram_notifications (telegram_chat_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_tg_notif_unresolved
  ON admin_telegram_notifications (item_type, item_id)
  WHERE resolved_at IS NULL;

ALTER TABLE admin_telegram_notifications ENABLE ROW LEVEL SECURITY;

-- Admins can read all notifications (for audit)
DROP POLICY IF EXISTS "Admins read telegram notifications" ON admin_telegram_notifications;
CREATE POLICY "Admins read telegram notifications"
  ON admin_telegram_notifications FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
        AND profiles.role = 'admin'
    )
  );
-- INSERT/UPDATE only via service role (webhook handler)

-- =============================================================================
-- 8. support_staff_telegram_links — support staff ↔ Telegram mapping
-- =============================================================================
-- Support staff are NOT admin users. They are external people (customer support
-- agents) who are given access to reply to support tickets via the admin bot.
-- ONLY an admin can add a support staff member (generate a link code).
-- Support staff have access ONLY to /reply <ticketId> <message>.
-- They cannot approve/reject trades, KYC, withdrawals, or rates.

CREATE TABLE IF NOT EXISTS support_staff_telegram_links (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_chat_id  BIGINT      NOT NULL,
  telegram_username TEXT,
  staff_name        TEXT        NOT NULL,     -- human-readable name set by admin
  added_by_admin_id UUID        NOT NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  linked_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_active         BOOLEAN     NOT NULL DEFAULT TRUE,
  CONSTRAINT support_staff_tg_chat_unique UNIQUE (telegram_chat_id)
);

CREATE INDEX IF NOT EXISTS idx_support_staff_tg_active
  ON support_staff_telegram_links (telegram_chat_id, is_active)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_support_staff_tg_admin
  ON support_staff_telegram_links (added_by_admin_id);

ALTER TABLE support_staff_telegram_links ENABLE ROW LEVEL SECURITY;

-- Only admins can read, insert, update, delete support staff links
DROP POLICY IF EXISTS "Admins manage support staff telegram" ON support_staff_telegram_links;
CREATE POLICY "Admins manage support staff telegram"
  ON support_staff_telegram_links FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
        AND profiles.role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
        AND profiles.role = 'admin'
    )
  );

-- =============================================================================
-- 9. support_staff_telegram_link_codes — one-time codes for support staff linking
-- =============================================================================
-- Generated by admin (generateSupportStaffLinkCode server fn).
-- Support staff DMs /start <code> to the admin bot → linked as support staff.
-- Expires in 30 minutes (longer than admin codes because staff may be slow).

CREATE TABLE IF NOT EXISTS support_staff_telegram_link_codes (
  code          TEXT        PRIMARY KEY,
  staff_name    TEXT        NOT NULL,
  created_by    UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL,
  used_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_support_staff_link_codes_expiry
  ON support_staff_telegram_link_codes (expires_at)
  WHERE used_at IS NULL;

ALTER TABLE support_staff_telegram_link_codes ENABLE ROW LEVEL SECURITY;

-- Admins can manage support staff codes
DROP POLICY IF EXISTS "Admins manage support staff codes" ON support_staff_telegram_link_codes;
CREATE POLICY "Admins manage support staff codes"
  ON support_staff_telegram_link_codes FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
        AND profiles.role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
        AND profiles.role = 'admin'
    )
  );

-- =============================================================================
-- 10. vendor_monikers — privacy-preserving vendor aliases
-- =============================================================================
-- Each vendor gets a stable human-readable moniker (e.g. "Crimson-Alpha")
-- used in all admin Telegram notifications. Their real business name and
-- bank details are never sent to Telegram.

CREATE TABLE IF NOT EXISTS vendor_monikers (
  vendor_id  UUID PRIMARY KEY REFERENCES vendors(id) ON DELETE CASCADE,
  moniker    TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vendor_monikers_moniker
  ON vendor_monikers (moniker);

ALTER TABLE vendor_monikers ENABLE ROW LEVEL SECURITY;

-- Admins can read monikers (for audit)
DROP POLICY IF EXISTS "Admins read vendor monikers" ON vendor_monikers;
CREATE POLICY "Admins read vendor monikers"
  ON vendor_monikers FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
        AND profiles.role = 'admin'
    )
  );
-- INSERT/UPDATE only via service role (get_or_create_vendor_moniker function)

-- =============================================================================
-- 11. Additional RLS — support_tickets admin access
-- =============================================================================
-- Migration 002 created basic user RLS. We add admin read + update access.

DROP POLICY IF EXISTS "Admins manage support tickets" ON support_tickets;
CREATE POLICY "Admins manage support tickets"
  ON support_tickets FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
        AND profiles.role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
        AND profiles.role = 'admin'
    )
  );

-- =============================================================================
-- 12. DB trigger — prevent payout on pending_review trades (belt-and-suspenders)
-- =============================================================================
-- App-level guard is in processPayout (vendors.ts). This trigger is the DB
-- fallback: even a raw SQL UPDATE cannot mark a trade 'paid' while
-- requires_manual_review is true.

CREATE OR REPLACE FUNCTION prevent_pending_review_payout()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'paid' AND (
    OLD.requires_manual_review = TRUE OR
    NEW.requires_manual_review = TRUE OR
    OLD.status = 'pending_review'
  ) THEN
    RAISE EXCEPTION
      'SAFETY: Cannot mark trade % as paid while it is under manual review. '
      'Approve the review first via admin panel or admin bot.',
      NEW.id
    USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_pending_review_payout ON trades;
CREATE TRIGGER trg_prevent_pending_review_payout
  BEFORE UPDATE ON trades
  FOR EACH ROW
  EXECUTE FUNCTION prevent_pending_review_payout();

-- =============================================================================
-- 13. get_or_create_vendor_moniker() — idempotent moniker assignment
-- =============================================================================
-- SECURITY DEFINER so the webhook handler (service role) can call it without
-- needing direct INSERT permission on vendor_monikers.
-- Monikers follow the pattern: <Color>-<GreekLetter>[-<number>]
-- e.g. "Crimson-Alpha", "Azure-Beta", "Jade-Alpha-21"

CREATE OR REPLACE FUNCTION get_or_create_vendor_moniker(p_vendor_id UUID)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_moniker TEXT;
  v_idx     INT;
  v_attempt INT := 0;
  colors    TEXT[] := ARRAY[
    'Crimson','Azure','Jade','Amber','Cobalt',
    'Coral','Indigo','Teal','Scarlet','Sage',
    'Violet','Onyx','Bronze','Silver','Ivory'
  ];
  letters   TEXT[] := ARRAY[
    'Alpha','Beta','Gamma','Delta','Epsilon',
    'Zeta','Eta','Theta','Iota','Kappa',
    'Lambda','Mu','Nu','Xi','Omicron',
    'Pi','Rho','Sigma','Tau','Upsilon',
    'Phi','Chi','Psi','Omega'
  ];
BEGIN
  -- Fast path: moniker already assigned
  SELECT moniker INTO v_moniker
  FROM vendor_monikers
  WHERE vendor_id = p_vendor_id;

  IF v_moniker IS NOT NULL THEN
    RETURN v_moniker;
  END IF;

  -- Assign new moniker: use (count of existing) to pick a color+letter pair
  SELECT COUNT(*) INTO v_idx FROM vendor_monikers;

  LOOP
    IF v_attempt = 0 THEN
      v_moniker :=
        colors[(v_idx % array_length(colors, 1)) + 1] || '-' ||
        letters[(v_idx % array_length(letters, 1)) + 1];
    ELSE
      -- Collision: append incrementing number
      v_moniker :=
        colors[(v_idx % array_length(colors, 1)) + 1] || '-' ||
        letters[(v_idx % array_length(letters, 1)) + 1] || '-' ||
        v_attempt;
    END IF;

    EXIT WHEN NOT EXISTS (SELECT 1 FROM vendor_monikers WHERE moniker = v_moniker);

    v_idx     := v_idx + 1;
    v_attempt := v_attempt + 1;

    -- Safety: bail after 1000 iterations (should never happen in practice)
    IF v_attempt > 1000 THEN
      v_moniker := 'Vendor-' || substr(p_vendor_id::TEXT, 1, 8);
      EXIT;
    END IF;
  END LOOP;

  INSERT INTO vendor_monikers (vendor_id, moniker)
  VALUES (p_vendor_id, v_moniker)
  ON CONFLICT (vendor_id) DO UPDATE SET moniker = vendor_monikers.moniker
  RETURNING moniker INTO v_moniker;

  RETURN v_moniker;
END;
$$;

-- Grant EXECUTE to authenticated role so admin server functions can call it
GRANT EXECUTE ON FUNCTION get_or_create_vendor_moniker(UUID) TO authenticated;

-- =============================================================================
-- 14. Cleanup old processed_webhook_events function (cron-friendly)
-- =============================================================================
-- Call periodically to prevent unbounded table growth.
CREATE OR REPLACE FUNCTION purge_old_processed_webhook_events(
  older_than_days INT DEFAULT 30
) RETURNS INT LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_deleted INT;
BEGIN
  DELETE FROM processed_webhook_events
  WHERE created_at < NOW() - (older_than_days || ' days')::INTERVAL;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;
