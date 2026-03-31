-- Phase 6: Shared inbox response-state tracking
-- Adds denormalized fields used for waiting/answered inbox UX and prioritization.

alter table public.chats
  add column if not exists awaiting_agent_reply boolean not null default false,
  add column if not exists last_external_sender_type text,
  add column if not exists last_external_message_at timestamptz;

alter table public.chats
  drop constraint if exists chats_last_external_sender_type_check;

alter table public.chats
  add constraint chats_last_external_sender_type_check
    check (
      last_external_sender_type is null
      or last_external_sender_type in ('visitor', 'agent')
    );

with latest_external as (
  select distinct on (m.chat_id)
    m.chat_id,
    m.sender_type,
    m.created_at
  from public.messages m
  where m.is_internal = false
    and m.sender_type in ('visitor', 'agent')
  order by m.chat_id, m.created_at desc
)
update public.chats c
set
  last_external_sender_type = latest_external.sender_type,
  last_external_message_at = latest_external.created_at,
  awaiting_agent_reply = (latest_external.sender_type = 'visitor')
from latest_external
where c.id = latest_external.chat_id;

create index if not exists idx_chats_inbox_waiting_priority_phase6
  on public.chats (
    workspace_id,
    awaiting_agent_reply desc,
    last_external_message_at desc,
    last_message_at desc
  )
  where conversation_mode in ('handoff_pending', 'agent_active', 'copilot')
    and conversation_status in ('active', 'waiting', 'assigned');
