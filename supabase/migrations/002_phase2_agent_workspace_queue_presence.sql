-- Phase 2: Agent Inbox, Team Membership, Queues, Presence
-- Extends the existing tenant-centric platform model with team membership,
-- queue routing metadata, and presence tracking.

-- ============================================================
-- 1) Enums
-- ============================================================
do $$ begin
  create type workspace_member_role as enum (
    'owner',
    'admin',
    'supervisor',
    'agent',
    'viewer'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  create type queue_routing_mode as enum (
    'manual_accept',
    'auto_assign'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  create type agent_presence_status as enum (
    'online',
    'away',
    'offline'
  );
exception when duplicate_object then null;
end $$;

-- Keep trigger helper available for standalone migration runs.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ============================================================
-- 2) Team membership (workspace = existing tenant workspace)
-- ============================================================
create table if not exists public.workspace_members (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null references public.tenants(tenant_id) on delete cascade,
  user_id uuid not null references public.platform_users(id) on delete cascade,
  role workspace_member_role not null default 'agent',
  is_active boolean not null default true,
  created_by uuid references public.platform_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, user_id)
);

create index if not exists idx_workspace_members_workspace
  on public.workspace_members (workspace_id, role, created_at desc);

create index if not exists idx_workspace_members_user
  on public.workspace_members (user_id, is_active);

drop trigger if exists workspace_members_set_updated_at on public.workspace_members;
create trigger workspace_members_set_updated_at
before update on public.workspace_members
for each row
execute procedure public.set_updated_at();

-- ============================================================
-- 3) Queues and queue members
-- ============================================================
create table if not exists public.queues (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null references public.tenants(tenant_id) on delete cascade,
  tenant_id text not null references public.tenants(tenant_id) on delete cascade,
  name text not null,
  routing_mode queue_routing_mode not null default 'manual_accept',
  is_active boolean not null default true,
  business_hours jsonb not null default '{}'::jsonb,
  overflow_queue_id uuid references public.queues(id) on delete set null,
  created_by uuid references public.platform_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, name)
);

create index if not exists idx_queues_workspace_active
  on public.queues (workspace_id, is_active, created_at desc);

create index if not exists idx_queues_tenant
  on public.queues (tenant_id, created_at desc);

drop trigger if exists queues_set_updated_at on public.queues;
create trigger queues_set_updated_at
before update on public.queues
for each row
execute procedure public.set_updated_at();

create table if not exists public.queue_members (
  id uuid primary key default gen_random_uuid(),
  queue_id uuid not null references public.queues(id) on delete cascade,
  workspace_member_id uuid not null references public.workspace_members(id) on delete cascade,
  priority integer not null default 100,
  max_concurrent_chats integer not null default 4,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (queue_id, workspace_member_id)
);

create index if not exists idx_queue_members_queue_priority
  on public.queue_members (queue_id, is_active, priority asc);

create index if not exists idx_queue_members_member
  on public.queue_members (workspace_member_id, is_active);

drop trigger if exists queue_members_set_updated_at on public.queue_members;
create trigger queue_members_set_updated_at
before update on public.queue_members
for each row
execute procedure public.set_updated_at();

-- ============================================================
-- 4) Presence
-- ============================================================
create table if not exists public.agent_presence (
  workspace_member_id uuid primary key references public.workspace_members(id) on delete cascade,
  status agent_presence_status not null default 'offline',
  last_heartbeat_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_agent_presence_status
  on public.agent_presence (status, updated_at desc);

drop trigger if exists agent_presence_set_updated_at on public.agent_presence;
create trigger agent_presence_set_updated_at
before update on public.agent_presence
for each row
execute procedure public.set_updated_at();

-- ============================================================
-- 5) Chat linkage for queue/workspace aware inbox
-- ============================================================
alter table public.chats
  add column if not exists workspace_id text references public.tenants(tenant_id) on delete set null,
  add column if not exists queue_id uuid references public.queues(id) on delete set null;

update public.chats
set workspace_id = tenant_id
where workspace_id is null;

create index if not exists idx_chats_workspace_mode
  on public.chats (workspace_id, conversation_mode, last_message_at desc);

create index if not exists idx_chats_queue_mode
  on public.chats (queue_id, conversation_mode, last_message_at desc);

-- ============================================================
-- 6) Backfill memberships from existing owner links
-- ============================================================
insert into public.workspace_members (workspace_id, user_id, role, is_active)
select put.tenant_id, put.user_id, 'owner'::workspace_member_role, true
from public.platform_user_tenants put
left join public.workspace_members wm
  on wm.workspace_id = put.tenant_id
 and wm.user_id = put.user_id
where wm.id is null;

