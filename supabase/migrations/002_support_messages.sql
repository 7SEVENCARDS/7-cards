-- Support messages table
CREATE TABLE IF NOT EXISTS support_messages (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  sender        TEXT NOT NULL CHECK (sender IN ('user','agent')),
  body          TEXT NOT NULL,
  read          BOOLEAN DEFAULT FALSE,
  created_at    TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE support_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own messages"
  ON support_messages FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own messages"
  ON support_messages FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Support tickets table (groups conversations)
CREATE TABLE IF NOT EXISTS support_tickets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  subject     TEXT NOT NULL,
  status      TEXT DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved','closed')),
  priority    TEXT DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE support_tickets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own tickets"
  ON support_tickets FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own tickets"
  ON support_tickets FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE OR REPLACE TRIGGER support_tickets_updated_at
  BEFORE UPDATE ON support_tickets FOR EACH ROW EXECUTE FUNCTION set_updated_at();
