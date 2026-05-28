-- Adds visitor inactivity warning/auto-close tracking for live agent conversations.

alter table public.chats
  add column if not exists visitor_inactivity_warning_sent_at timestamptz,
  add column if not exists visitor_inactivity_close_due_at timestamptz;

create index if not exists idx_chats_visitor_inactivity_auto_close
  on public.chats (
    workspace_id,
    visitor_inactivity_close_due_at asc,
    last_external_message_at asc
  )
  where conversation_mode in ('handoff_pending', 'agent_active', 'copilot')
    and conversation_status in ('active', 'waiting', 'assigned')
    and (
      last_external_message_at is not null
      or last_visitor_message_at is not null
      or visitor_inactivity_close_due_at is not null
    );
