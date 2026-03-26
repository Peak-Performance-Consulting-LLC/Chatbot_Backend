-- Phase 5: Scale Hardening and Enterprise Features
-- Adds advanced routing metadata, CSAT capture, message dedupe keys,
-- retention/export controls, and inbox query hardening indexes.

-- ============================================================
-- 1) Queue + member routing enhancements (skills/VIP/round-robin)
-- ============================================================
alter table public.queues
  add column if not exists routing_strategy text not null default 'priority_least_active',
  add column if not exists is_vip_queue boolean not null default false;

alter table public.queues
  drop constraint if exists queues_routing_strategy_check;

alter table public.queues
  add constraint queues_routing_strategy_check
    check (routing_strategy in ('priority_least_active', 'round_robin'));

alter table public.queue_members
  add column if not exists skills text[] not null default array[]::text[],
  add column if not exists handles_vip boolean not null default true,
  add column if not exists last_assigned_at timestamptz;

-- ============================================================
-- 2) Conversation routing + retention metadata
-- ============================================================
alter table public.chats
  add column if not exists visitor_is_vip boolean not null default false,
  add column if not exists routing_skill text,
  add column if not exists archived_at timestamptz;

create index if not exists idx_chats_vip_pending
  on public.chats (workspace_id, visitor_is_vip, last_message_at desc)
  where conversation_mode = 'handoff_pending';

create index if not exists idx_chats_routing_skill_pending
  on public.chats (workspace_id, routing_skill, last_message_at desc)
  where conversation_mode = 'handoff_pending'
    and routing_skill is not null;

-- ============================================================
-- 3) Message deduplication key for retry safety
-- ============================================================
alter table public.messages
  add column if not exists dedupe_key text;

create unique index if not exists idx_messages_chat_dedupe_key
  on public.messages (chat_id, dedupe_key)
  where dedupe_key is not null;

-- ============================================================
-- 4) CSAT capture
-- ============================================================
create table if not exists public.conversation_csat (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null unique references public.chats(id) on delete cascade,
  tenant_id text not null references public.tenants(tenant_id) on delete cascade,
  workspace_id text references public.tenants(tenant_id) on delete set null,
  rating integer not null,
  feedback text,
  submitted_by text not null default 'visitor',
  submitted_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.conversation_csat
  drop constraint if exists conversation_csat_rating_check,
  drop constraint if exists conversation_csat_submitted_by_check;

alter table public.conversation_csat
  add constraint conversation_csat_rating_check
    check (rating >= 1 and rating <= 5),
  add constraint conversation_csat_submitted_by_check
    check (submitted_by in ('visitor', 'agent', 'supervisor', 'system'));

create index if not exists idx_conversation_csat_tenant_submitted
  on public.conversation_csat (tenant_id, submitted_at desc);

drop trigger if exists conversation_csat_set_updated_at on public.conversation_csat;
create trigger conversation_csat_set_updated_at
before update on public.conversation_csat
for each row
execute procedure public.set_updated_at();

-- ============================================================
-- 5) Retention and export controls (workspace level)
-- ============================================================
alter table public.tenants
  add column if not exists conversation_retention_days integer not null default 365,
  add column if not exists retention_purge_grace_days integer not null default 30,
  add column if not exists allow_conversation_export boolean not null default true,
  add column if not exists csat_enabled boolean not null default true,
  add column if not exists csat_prompt text not null default 'How was your support experience?';

alter table public.tenants
  drop constraint if exists tenants_conversation_retention_days_check,
  drop constraint if exists tenants_retention_purge_grace_days_check,
  drop constraint if exists tenants_csat_prompt_length_check;

alter table public.tenants
  add constraint tenants_conversation_retention_days_check
    check (conversation_retention_days >= 30 and conversation_retention_days <= 3650),
  add constraint tenants_retention_purge_grace_days_check
    check (retention_purge_grace_days >= 0 and retention_purge_grace_days <= 3650),
  add constraint tenants_csat_prompt_length_check
    check (char_length(trim(csat_prompt)) between 8 and 180);

-- ============================================================
-- 6) Inbox query hardening indexes for high-volume workspaces
-- ============================================================
create index if not exists idx_chats_inbox_assigned_phase5
  on public.chats (workspace_id, assigned_agent_id, last_message_at desc)
  where assigned_agent_id is not null
    and conversation_mode in ('agent_active', 'copilot')
    and conversation_status in ('active', 'waiting', 'assigned');

create index if not exists idx_chats_inbox_queue_pending_phase5
  on public.chats (workspace_id, queue_id, last_message_at desc)
  where conversation_mode = 'handoff_pending'
    and assigned_agent_id is null
    and conversation_status in ('active', 'waiting', 'assigned');
