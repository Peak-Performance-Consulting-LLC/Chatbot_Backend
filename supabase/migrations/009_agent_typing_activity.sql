-- Phase 8: Durable agent typing fallback
-- Mirrors visitor typing activity so widgets can recover when transient realtime is missed.

alter table public.chats
  add column if not exists last_agent_typing_at timestamptz;

create index if not exists idx_chats_agent_typing_activity
  on public.chats (
    workspace_id,
    last_agent_typing_at desc
  )
  where conversation_mode in ('handoff_pending', 'agent_active', 'copilot')
    and conversation_status in ('active', 'waiting', 'assigned')
    and last_agent_typing_at is not null;
