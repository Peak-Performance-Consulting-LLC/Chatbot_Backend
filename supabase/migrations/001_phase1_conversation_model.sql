-- Phase 1: Conversation Model Foundation
-- Adds conversation mode state machine, sender types, and conversation events

-- ============================================================
-- 1. Create enum types
-- ============================================================
DO $$ BEGIN
  CREATE TYPE conversation_mode AS ENUM (
    'ai_only',
    'handoff_pending',
    'agent_active',
    'copilot',
    'returned_to_ai',
    'closed'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE conversation_status AS ENUM (
    'active',
    'waiting',
    'assigned',
    'closed',
    'archived'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE sender_type AS ENUM (
    'visitor',
    'ai',
    'agent',
    'system'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================
-- 2. Extend chats table
-- ============================================================
ALTER TABLE chats
  ADD COLUMN IF NOT EXISTS conversation_mode conversation_mode NOT NULL DEFAULT 'ai_only',
  ADD COLUMN IF NOT EXISTS conversation_status conversation_status NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS assigned_agent_id uuid DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS handoff_requested_at timestamptz DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS assigned_at timestamptz DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS closed_at timestamptz DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sla_breached boolean NOT NULL DEFAULT false;

-- Index for agent inbox queries
CREATE INDEX IF NOT EXISTS idx_chats_assigned_agent
  ON chats (assigned_agent_id)
  WHERE assigned_agent_id IS NOT NULL;

-- Index for finding handoff_pending conversations
CREATE INDEX IF NOT EXISTS idx_chats_conversation_mode
  ON chats (conversation_mode)
  WHERE conversation_mode != 'ai_only';

CREATE INDEX IF NOT EXISTS idx_chats_handoff_pending
  ON chats (last_message_at DESC)
  WHERE conversation_mode = 'handoff_pending';

CREATE INDEX IF NOT EXISTS idx_chats_mode_status
  ON chats (conversation_mode, conversation_status, last_message_at DESC);

ALTER TABLE chats
  DROP CONSTRAINT IF EXISTS chats_assigned_agent_required_check;

ALTER TABLE chats
  ADD CONSTRAINT chats_assigned_agent_required_check
  CHECK (
    (
      conversation_mode IN ('agent_active', 'copilot')
      AND assigned_agent_id IS NOT NULL
    )
    OR conversation_mode NOT IN ('agent_active', 'copilot')
  );

-- ============================================================
-- 3. Extend messages table
-- ============================================================
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS sender_type sender_type NOT NULL DEFAULT 'visitor',
  ADD COLUMN IF NOT EXISTS sender_id uuid DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS is_internal boolean NOT NULL DEFAULT false;

-- Index for filtering out internal messages in widget view
CREATE INDEX IF NOT EXISTS idx_messages_is_internal
  ON messages (chat_id, is_internal)
  WHERE is_internal = true;

-- ============================================================
-- 4. Create conversation_events table
-- ============================================================
CREATE TABLE IF NOT EXISTS conversation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  actor_id uuid DEFAULT NULL,
  actor_type text DEFAULT NULL,
  old_mode conversation_mode DEFAULT NULL,
  new_mode conversation_mode DEFAULT NULL,
  metadata jsonb DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conversation_events_chat
  ON conversation_events (chat_id, created_at DESC);

-- ============================================================
-- 5. Backfill existing data
-- ============================================================

-- All existing chats are AI-only conversations
UPDATE chats
  SET conversation_mode = 'ai_only',
      conversation_status = 'active'
  WHERE conversation_mode IS NULL OR conversation_mode = 'ai_only';

-- Backfill sender_type on existing messages based on role
UPDATE messages SET sender_type = 'visitor' WHERE role = 'user' AND sender_type = 'visitor';
UPDATE messages SET sender_type = 'ai' WHERE role = 'assistant';
UPDATE messages SET sender_type = 'system' WHERE role = 'system';
