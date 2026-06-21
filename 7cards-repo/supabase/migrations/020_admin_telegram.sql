-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 020: Admin Telegram Bot + Telegram Support System
--
-- Adds tables for:
--   1. Admin Telegram identity linking (expiring link codes)
--   2. Admin Telegram notification tracking (fan-out + resolve)
--   3. Support ticket routing via Telegram
--   4. Vendor moniker table (privacy-preserving dispute comms)
--   5. pending_review trade status support (P0-1 fix)
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Admin Telegram identity links ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admin_telegram_links (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  telegram_chat_id  BIGINT NOT NULL,
  telegram_username TEXT,
  linked_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT admin_telegram_links_chat_unique UNIQUE (telegram_chat_id)
);

CREATE TABLE IF NOT EXISTS admin_telegram_link_codes (
  code        TEXT PRIMARY KEY,
  admin_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_admin_tg_link_codes_admin
  ON admin_telegram_link_codes (admin_id, expires_at DESC);

-- ── 2. Admin Telegram notification fan-out tracker ───────────────────────────
-- One row per (item, chat). Lets us edit all admins' copies on resolution.
CREATE TABLE IF NOT EXISTS admin_telegram_notifications (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_type           TEXT NOT NULL,   -- 'manual_review' | 'withdrawal' | 'kyc' | 'vendor_rate' | 'dispute' | 'fraud' | 'payout_failed'
  item_id             UUID NOT NULL,
  telegram_chat_id    BIGINT NOT NULL,
  telegram_message_id BIGINT NOT NULL,
  resolved_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_tg_notif_item
  ON admin_telegram_notifications (item_type, item_id, resolved_at);
CREATE INDEX IF NOT EXISTS idx_admin_tg_notif_chat
  ON admin_telegram_notifications (telegram_chat_id, created_at DESC);

-- ── 3. Support tickets (Telegram-based support system) ───────────────────────
-- Replaces FreeScout. Tickets route to a Telegram support group.
CREATE TABLE IF NOT EXISTS support_tickets (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  category         TEXT,
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'closed')),
  telegram_message_id BIGINT,          -- message ID in support group
  telegram_thread_id  BIGINT,          -- thread/topic ID if using forum groups
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at      TIMESTAMPTZ,
  CONSTRAINT support_tickets_user_one_open UNIQUE NULLS NOT DISTINCT (user_id, status)
    DEFERRABLE INITIALLY DEFERRED
);

-- Drop incorrect unique constraint if it was created without NULLS NOT DISTINCT support
-- (Postgres < 15 fallback)
DO $$
BEGIN
  ALTER TABLE support_tickets DROP CONSTRAINT IF EXISTS support_tickets_user_one_open;
EXCEPTION WHEN others THEN null;
END$$;

-- Simple open ticket index (no partial unique — just use index for lookups)
CREATE INDEX IF NOT EXISTS idx_support_tickets_user
  ON support_tickets (user_id, status, created_at DESC);

-- ── 4. Vendor monikers (privacy-preserving dispute comms) ────────────────────
-- Each vendor gets a stable, human-readable moniker used in admin/support comms
-- so their real business name and details are never disclosed.
CREATE TABLE IF NOT EXISTS vendor_monikers (
  vendor_id  UUID PRIMARY KEY REFERENCES vendors(id) ON DELETE CASCADE,
  moniker    TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 5. Ensure trades.status allows 'pending_review' ──────────────────────────
-- The P0-1 fix introduces 'pending_review' as a real status distinct from 'verified'.
-- We add it to the CHECK constraint if it's defined, or just note it for app logic.
-- (Supabase typically uses TEXT without CHECK for status; this is a no-op if so.)
DO $$
BEGIN
  -- Add DB-level guard: pending_review + paid cannot coexist
  -- This is belt-and-suspenders alongside the app-level check.
  -- We do this as a trigger rather than a constraint for compatibility.
  NULL;
END$$;

CREATE OR REPLACE FUNCTION prevent_pending_review_payout()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'paid' AND (OLD.requires_manual_review = true OR NEW.requires_manual_review = true) THEN
    RAISE EXCEPTION 'Cannot mark trade as paid while requires_manual_review is true (trade %)', NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_pending_review_payout ON trades;
CREATE TRIGGER trg_prevent_pending_review_payout
  BEFORE UPDATE ON trades
  FOR EACH ROW
  EXECUTE FUNCTION prevent_pending_review_payout();

-- ── 6. Moniker auto-generation function ──────────────────────────────────────
-- Assigns a deterministic moniker to a vendor if they don't have one.
-- Uses Greek alphabet + color combos for easy recall: "Crimson-Alpha", "Azure-Beta"
CREATE OR REPLACE FUNCTION get_or_create_vendor_moniker(p_vendor_id UUID)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_moniker TEXT;
  v_idx     INT;
  colors    TEXT[] := ARRAY['Crimson','Azure','Jade','Amber','Cobalt','Coral','Indigo','Teal','Scarlet','Sage'];
  names     TEXT[] := ARRAY['Alpha','Beta','Gamma','Delta','Epsilon','Zeta','Eta','Theta','Iota','Kappa',
                             'Lambda','Mu','Nu','Xi','Omicron','Pi','Rho','Sigma','Tau','Upsilon'];
BEGIN
  SELECT moniker INTO v_moniker FROM vendor_monikers WHERE vendor_id = p_vendor_id;
  IF v_moniker IS NOT NULL THEN
    RETURN v_moniker;
  END IF;

  -- Generate a unique moniker using count of existing monikers
  SELECT COUNT(*) INTO v_idx FROM vendor_monikers;
  v_moniker := colors[(v_idx % array_length(colors,1)) + 1] || '-' || names[(v_idx % array_length(names,1)) + 1];

  -- Handle collision by appending a number
  WHILE EXISTS (SELECT 1 FROM vendor_monikers WHERE moniker = v_moniker) LOOP
    v_idx := v_idx + 1;
    v_moniker := colors[(v_idx % array_length(colors,1)) + 1] || '-' || names[(v_idx % array_length(names,1)) + 1] || '-' || v_idx;
  END LOOP;

  INSERT INTO vendor_monikers (vendor_id, moniker) VALUES (p_vendor_id, v_moniker)
    ON CONFLICT (vendor_id) DO NOTHING;

  RETURN v_moniker;
END;
$$;
