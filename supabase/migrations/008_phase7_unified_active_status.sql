-- Phase 7: Unified active-status flow
-- Adds visitor activity denormalized fields used for inferred visitor presence in shared inbox.

alter table public.chats
  add column if not exists last_visitor_message_at timestamptz,
  add column if not exists last_visitor_typing_at timestamptz,
  add column if not exists last_visitor_activity_at timestamptz;

with latest_visitor as (
  select distinct on (m.chat_id)
    m.chat_id,
    m.created_at
  from public.messages m
  where m.is_internal = false
    and m.sender_type = 'visitor'
  order by m.chat_id, m.created_at desc
)
update public.chats c
set
  last_visitor_message_at = latest_visitor.created_at,
  last_visitor_activity_at = coalesce(c.last_visitor_activity_at, latest_visitor.created_at)
from latest_visitor
where c.id = latest_visitor.chat_id;

create index if not exists idx_chats_inbox_visitor_activity_phase7
  on public.chats (
    workspace_id,
    last_visitor_activity_at desc,
    last_message_at desc
  )
  where conversation_mode in ('handoff_pending', 'agent_active', 'copilot')
    and conversation_status in ('active', 'waiting', 'assigned');
