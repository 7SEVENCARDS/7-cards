-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 008: FreeScout support thread tracking
-- Stores the FreeScout conversation ID per user so messages thread correctly.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS support_threads (
  user_id        uuid        PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  conversation_id bigint     NOT NULL,
  customer_id     bigint,
  category        text,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

ALTER TABLE support_threads ENABLE ROW LEVEL SECURITY;

-- Users can only see/touch their own thread record
CREATE POLICY "Users manage own thread"
  ON support_threads
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Service role (server functions) bypasses RLS
-- No explicit policy needed — service key already bypasses

-- Add freescout_thread_id column to support_messages so we can
-- deduplicate synced agent replies
ALTER TABLE support_messages
  ADD COLUMN IF NOT EXISTS freescout_thread_id bigint,
  ADD COLUMN IF NOT EXISTS category text;

-- Index for fast per-user reads
CREATE INDEX IF NOT EXISTS idx_support_messages_user_created
  ON support_messages (user_id, created_at);
