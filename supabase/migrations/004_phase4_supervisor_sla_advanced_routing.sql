-- Phase 4: Supervisor Controls, SLA, Business Hours, Overflow, Copilot

-- ============================================================
-- 1) Queue configuration for after-hours + SLA + overflow
-- ============================================================
alter table public.queues
  add column if not exists after_hours_action text not null default 'ai_only',
  add column if not exists sla_first_response_seconds integer not null default 180,
  add column if not exists sla_warning_seconds integer not null default 60,
  add column if not exists overflow_after_seconds integer not null default 300;

alter table public.queues
  drop constraint if exists queues_after_hours_action_check,
  drop constraint if exists queues_sla_first_response_seconds_check,
  drop constraint if exists queues_sla_warning_seconds_check,
  drop constraint if exists queues_overflow_after_seconds_check;

alter table public.queues
  add constraint queues_after_hours_action_check
    check (after_hours_action in ('collect_info', 'overflow', 'ai_only')),
  add constraint queues_sla_first_response_seconds_check
    check (sla_first_response_seconds >= 0 and sla_first_response_seconds <= 86400),
  add constraint queues_sla_warning_seconds_check
    check (sla_warning_seconds >= 0 and sla_warning_seconds <= 86400),
  add constraint queues_overflow_after_seconds_check
    check (overflow_after_seconds >= 0 and overflow_after_seconds <= 172800);

-- ============================================================
-- 2) Conversation-level SLA tracking fields
-- ============================================================
alter table public.chats
  add column if not exists sla_started_at timestamptz,
  add column if not exists sla_first_response_due_at timestamptz,
  add column if not exists first_agent_response_at timestamptz,
  add column if not exists sla_warning_sent_at timestamptz,
  add column if not exists sla_breached_at timestamptz,
  add column if not exists overflowed_at timestamptz;

create index if not exists idx_chats_sla_due_pending
  on public.chats (sla_first_response_due_at asc)
  where conversation_mode = 'handoff_pending'
    and sla_first_response_due_at is not null;

create index if not exists idx_chats_sla_warning_pending
  on public.chats (sla_started_at asc, sla_warning_sent_at asc)
  where conversation_mode = 'handoff_pending'
    and sla_breached = false;

-- ============================================================
-- 3) Message metadata for copilot drafts
-- ============================================================
alter table public.messages
  add column if not exists is_draft boolean not null default false;
