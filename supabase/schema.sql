-- 1) Required extension
create extension if not exists vector;

-- Optional helper extension for UUIDs
create extension if not exists pgcrypto;

-- 2) Tenants table (domain allowlist per tenant)
create table if not exists public.tenants (
  tenant_id text primary key,
  name text,
  allowed_domains text[] not null,
  created_at timestamptz not null default now()
);

alter table public.tenants
  add column if not exists business_type text not null default 'general_travel',
  add column if not exists supported_services text[] not null default array['flights']::text[],
  add column if not exists support_phone text,
  add column if not exists support_email text,
  add column if not exists support_cta_label text not null default 'Connect with a specialist',
  add column if not exists business_description text,
  add column if not exists knowledge_status text not null default 'pending',
  add column if not exists knowledge_message text,
  add column if not exists knowledge_last_ingested_at timestamptz,
  add column if not exists primary_color text not null default '#006d77',
  add column if not exists user_bubble_color text not null default '#006d77',
  add column if not exists bot_bubble_color text not null default '#edf6f9',
  add column if not exists font_family text not null default 'Manrope',
  add column if not exists widget_position text not null default 'right',
  add column if not exists launcher_style text not null default 'rounded',
  add column if not exists theme_style text not null default 'standard',
  add column if not exists bg_pattern text not null default 'none',
  add column if not exists launcher_icon text not null default 'chat',
  add column if not exists window_width integer not null default 380,
  add column if not exists window_height integer not null default 640,
  add column if not exists border_radius integer not null default 18,
  add column if not exists welcome_message text,
  add column if not exists bot_name text not null default 'AeroConcierge',
  add column if not exists bot_avatar_url text,
  add column if not exists quick_replies text[] not null default array['How does this work?', 'Pricing plans', 'Get support']::text[],
  add column if not exists ai_tone text not null default 'friendly',
  add column if not exists notif_enabled boolean not null default true,
  add column if not exists notif_text text not null default '👋 Need help?',
  add column if not exists notif_animation text not null default 'bounce',
  add column if not exists notif_chips text[] not null default array['I have a question', 'Tell me more']::text[],
  add column if not exists header_cta_label text not null default 'New',
  add column if not exists header_cta_notice text not null default 'Hi! I am your AI assistant. Ask me anything about your trip.';

alter table public.tenants
  drop constraint if exists tenants_knowledge_status_check,
  drop constraint if exists tenants_widget_position_check,
  drop constraint if exists tenants_launcher_style_check,
  drop constraint if exists tenants_theme_style_check,
  drop constraint if exists tenants_bg_pattern_check,
  drop constraint if exists tenants_launcher_icon_check,
  drop constraint if exists tenants_ai_tone_check,
  drop constraint if exists tenants_notif_animation_check;

alter table public.tenants
  add constraint tenants_knowledge_status_check
    check (knowledge_status in ('pending', 'processing', 'ready', 'warning', 'error')),
  add constraint tenants_widget_position_check
    check (widget_position in ('left', 'right')),
  add constraint tenants_launcher_style_check
    check (launcher_style in ('rounded', 'pill', 'square', 'minimal')),
  add constraint tenants_theme_style_check
    check (theme_style in ('standard', 'glass', 'clay', 'dark', 'minimal')),
  add constraint tenants_bg_pattern_check
    check (bg_pattern in ('none', 'dots', 'grid', 'waves')),
  add constraint tenants_launcher_icon_check
    check (launcher_icon in ('chat', 'sparkle', 'headset', 'zap', 'heart')),
  add constraint tenants_ai_tone_check
    check (ai_tone in ('friendly', 'professional', 'concise', 'enthusiastic')),
  add constraint tenants_notif_animation_check
    check (notif_animation in ('bounce', 'pulse', 'slide'));

-- 3) Knowledge chunks (tenant-scoped embeddings)
create table if not exists public.knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(tenant_id) on delete cascade,
  source_url text,
  title text,
  chunk_text text not null,
  embedding vector(768) not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists knowledge_chunks_tenant_idx
  on public.knowledge_chunks (tenant_id);

create index if not exists knowledge_chunks_created_idx
  on public.knowledge_chunks (created_at desc);

create index if not exists knowledge_chunks_embedding_ivfflat
  on public.knowledge_chunks
  using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

-- 4) Chat threads
create table if not exists public.chats (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(tenant_id) on delete cascade,
  device_id text not null,
  title text not null default 'New chat',
  summary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_message_at timestamptz not null default now()
);

create index if not exists chats_tenant_device_idx
  on public.chats (tenant_id, device_id, last_message_at desc);

-- 5) Messages
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.chats(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists messages_chat_created_idx
  on public.messages (chat_id, created_at asc);

-- ============================================================================
-- PHASE 1: CONVERSATION MODEL FOUNDATION
-- ============================================================================

do $$ begin
  create type conversation_mode as enum (
    'ai_only',
    'handoff_pending',
    'agent_active',
    'copilot',
    'returned_to_ai',
    'closed'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  create type conversation_status as enum (
    'active',
    'waiting',
    'assigned',
    'closed',
    'archived'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  create type sender_type as enum (
    'visitor',
    'ai',
    'agent',
    'system'
  );
exception when duplicate_object then null;
end $$;

alter table public.chats
  add column if not exists conversation_mode conversation_mode not null default 'ai_only',
  add column if not exists conversation_status conversation_status not null default 'active',
  add column if not exists assigned_agent_id uuid default null,
  add column if not exists handoff_requested_at timestamptz default null,
  add column if not exists assigned_at timestamptz default null,
  add column if not exists closed_at timestamptz default null,
  add column if not exists priority integer not null default 0,
  add column if not exists sla_breached boolean not null default false;

alter table public.chats
  drop constraint if exists chats_assigned_agent_required_check;

alter table public.chats
  add constraint chats_assigned_agent_required_check
    check (
      (
        conversation_mode in ('agent_active', 'copilot')
        and assigned_agent_id is not null
      )
      or conversation_mode not in ('agent_active', 'copilot')
    );

create index if not exists idx_chats_assigned_agent
  on public.chats (assigned_agent_id)
  where assigned_agent_id is not null;

create index if not exists idx_chats_handoff_pending
  on public.chats (last_message_at desc)
  where conversation_mode = 'handoff_pending';

create index if not exists idx_chats_mode_status
  on public.chats (conversation_mode, conversation_status, last_message_at desc);

alter table public.messages
  add column if not exists sender_type sender_type not null default 'visitor',
  add column if not exists sender_id uuid default null,
  add column if not exists is_internal boolean not null default false;

create index if not exists idx_messages_is_internal
  on public.messages (chat_id, is_internal)
  where is_internal = true;

create table if not exists public.conversation_events (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.chats(id) on delete cascade,
  event_type text not null,
  actor_id uuid default null,
  actor_type text default null,
  old_mode conversation_mode default null,
  new_mode conversation_mode default null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_conversation_events_chat
  on public.conversation_events (chat_id, created_at desc);

-- Dedicated flight state per chat (slot-filling state machine)
create table if not exists public.flight_search_sessions (
  chat_id uuid primary key references public.chats(id) on delete cascade,
  tenant_id text not null references public.tenants(tenant_id) on delete cascade,
  state jsonb not null default '{}'::jsonb,
  status text not null default 'collecting' check (status in ('collecting', 'ready', 'done')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists flight_sessions_tenant_idx
  on public.flight_search_sessions (tenant_id, updated_at desc);

-- Legacy compatibility table (older deployments may still use this)
create table if not exists public.flight_search_states (
  chat_id uuid primary key references public.chats(id) on delete cascade,
  tenant_id text not null references public.tenants(tenant_id) on delete cascade,
  state jsonb not null default '{}'::jsonb,
  status text not null default 'collecting' check (status in ('collecting', 'ready', 'completed', 'done')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists flight_states_tenant_idx
  on public.flight_search_states (tenant_id, updated_at desc);

create table if not exists public.service_request_states (
  chat_id uuid primary key references public.chats(id) on delete cascade,
  tenant_id text not null references public.tenants(tenant_id) on delete cascade,
  state jsonb not null default '{}'::jsonb,
  status text not null default 'collecting' check (status in ('collecting', 'ready', 'completed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists service_states_tenant_idx
  on public.service_request_states (tenant_id, updated_at desc);

-- Auto-update updated_at for chats + flight_search_states
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists chats_set_updated_at on public.chats;
create trigger chats_set_updated_at
before update on public.chats
for each row
execute procedure public.set_updated_at();

drop trigger if exists flight_sessions_set_updated_at on public.flight_search_sessions;
create trigger flight_sessions_set_updated_at
before update on public.flight_search_sessions
for each row
execute procedure public.set_updated_at();

drop trigger if exists flight_states_set_updated_at on public.flight_search_states;
create trigger flight_states_set_updated_at
before update on public.flight_search_states
for each row
execute procedure public.set_updated_at();

drop trigger if exists service_states_set_updated_at on public.service_request_states;
create trigger service_states_set_updated_at
before update on public.service_request_states
for each row
execute procedure public.set_updated_at();

-- RPC: tenant-filtered vector similarity search
create or replace function public.match_knowledge_chunks(
  query_embedding vector(768),
  match_count int,
  tenant text
)
returns table (
  id uuid,
  tenant_id text,
  source_url text,
  title text,
  chunk_text text,
  metadata jsonb,
  similarity float
)
language sql
stable
as $$
  select
    kc.id,
    kc.tenant_id,
    kc.source_url,
    kc.title,
    kc.chunk_text,
    kc.metadata,
    1 - (kc.embedding <=> query_embedding) as similarity
  from public.knowledge_chunks kc
  where kc.tenant_id = tenant
  order by kc.embedding <=> query_embedding
  limit greatest(match_count, 1);
$$;

-- ============================================================================
-- PLATFORM TABLES (self-serve multi-tenant onboarding)
-- ============================================================================

create table if not exists public.platform_users (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  email text not null unique,
  password_hash text,
  avatar_url text,
  avatar_source text not null default 'initials',
  oauth_avatar_url text,
  oauth_avatar_provider text,
  google_user_id text,
  facebook_user_id text,
  created_at timestamptz not null default now()
);

alter table public.platform_users
  add column if not exists avatar_url text,
  add column if not exists avatar_source text not null default 'initials',
  add column if not exists oauth_avatar_url text,
  add column if not exists oauth_avatar_provider text,
  add column if not exists google_user_id text,
  add column if not exists facebook_user_id text;

alter table public.platform_users
  alter column password_hash drop not null;

alter table public.platform_users
  drop constraint if exists platform_users_avatar_source_check,
  drop constraint if exists platform_users_oauth_avatar_provider_check;

alter table public.platform_users
  add constraint platform_users_avatar_source_check
    check (avatar_source in ('initials', 'manual', 'google', 'facebook')),
  add constraint platform_users_oauth_avatar_provider_check
    check (oauth_avatar_provider is null or oauth_avatar_provider in ('google', 'facebook'));

create unique index if not exists platform_users_google_user_id_idx
  on public.platform_users (google_user_id)
  where google_user_id is not null;

create unique index if not exists platform_users_facebook_user_id_idx
  on public.platform_users (facebook_user_id)
  where facebook_user_id is not null;

create table if not exists public.platform_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.platform_users(id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists platform_sessions_user_idx
  on public.platform_sessions(user_id, expires_at desc);

create table if not exists public.platform_user_tenants (
  user_id uuid not null references public.platform_users(id) on delete cascade,
  tenant_id text not null references public.tenants(tenant_id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key(user_id, tenant_id)
);

create index if not exists platform_user_tenants_tenant_idx
  on public.platform_user_tenants(tenant_id, created_at desc);

create table if not exists public.tenant_domain_verifications (
  tenant_id text primary key references public.tenants(tenant_id) on delete cascade,
  domain text not null unique,
  txt_name text not null,
  txt_value text not null,
  status text not null default 'pending',
  last_checked_at timestamptz,
  last_error text,
  last_seen_records text[] not null default array[]::text[],
  verified_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.tenant_domain_verifications
  drop constraint if exists tenant_domain_verifications_status_check;

alter table public.tenant_domain_verifications
  add constraint tenant_domain_verifications_status_check
    check (status in ('pending', 'txt_not_found', 'txt_mismatch', 'verified'));

create index if not exists tenant_domain_status_idx
  on public.tenant_domain_verifications(status, created_at desc);

create table if not exists public.tenant_sources (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(tenant_id) on delete cascade,
  source_type text not null check (source_type in ('sitemap', 'url', 'faq', 'doc_text')),
  source_value text not null,
  created_at timestamptz not null default now()
);

create index if not exists tenant_sources_tenant_idx
  on public.tenant_sources(tenant_id, created_at asc);

create table if not exists public.platform_password_resets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.platform_users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists platform_password_resets_user_idx
  on public.platform_password_resets(user_id, created_at desc);

create index if not exists platform_password_resets_expires_idx
  on public.platform_password_resets(expires_at);

-- ============================================================================
-- SUBSCRIPTIONS (pricing & 14-day trial)
-- ============================================================================

create table if not exists public.platform_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.platform_users(id) on delete cascade,
  plan text not null default 'trial'
    check (plan in ('trial', 'starter', 'growth', 'enterprise')),
  status text not null default 'active'
    check (status in ('active', 'canceled', 'expired', 'past_due')),
  max_tenants int not null default 5,
  max_messages_mo int not null default 100,
  trial_ends_at timestamptz,
  current_period_start timestamptz not null default now(),
  current_period_end timestamptz not null default (now() + interval '30 days'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.platform_subscriptions
  add column if not exists stripe_customer_id text,
  add column if not exists stripe_subscription_id text,
  add column if not exists stripe_price_id text,
  add column if not exists cancel_at_period_end boolean not null default false;

alter table public.platform_subscriptions
  alter column max_messages_mo set default 100;

update public.platform_subscriptions
set max_messages_mo = 100
where plan = 'trial'
  and max_messages_mo <> 100;

create unique index if not exists platform_subscriptions_user_idx
  on public.platform_subscriptions(user_id);

create unique index if not exists platform_subscriptions_stripe_subscription_idx
  on public.platform_subscriptions(stripe_subscription_id)
  where stripe_subscription_id is not null;

drop trigger if exists platform_subscriptions_set_updated_at on public.platform_subscriptions;
create trigger platform_subscriptions_set_updated_at
before update on public.platform_subscriptions
for each row
execute procedure public.set_updated_at();

-- ============================================================================
-- VISITOR CONTACT CAPTURE
-- ============================================================================

create table if not exists public.visitor_contacts (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(tenant_id) on delete cascade,
  device_id text not null,
  chat_id uuid references public.chats(id) on delete set null,
  full_name text not null,
  email text not null,
  phone_raw text not null,
  phone_normalized text not null,
  captured_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, device_id)
);

create index if not exists visitor_contacts_tenant_captured_idx
  on public.visitor_contacts (tenant_id, captured_at desc);

create index if not exists visitor_contacts_tenant_email_idx
  on public.visitor_contacts (tenant_id, lower(email));

drop trigger if exists visitor_contacts_set_updated_at on public.visitor_contacts;
create trigger visitor_contacts_set_updated_at
before update on public.visitor_contacts
for each row
execute procedure public.set_updated_at();

-- ============================================================================
-- PLATFORM ANALYTICS USAGE EVENTS
-- ============================================================================

create table if not exists public.platform_usage_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(tenant_id) on delete cascade,
  chat_id uuid not null references public.chats(id) on delete cascade,
  device_id text not null,
  user_message_id uuid references public.messages(id) on delete set null,
  assistant_message_id uuid references public.messages(id) on delete set null,
  intent text not null,
  service text check (service in ('flights', 'hotels', 'cars', 'cruises')),
  response_source text not null
    check (response_source in ('llm', 'flight_engine', 'service_flow', 'static', 'fallback')),
  rag_match boolean,
  prompt_tokens int not null default 0,
  completion_tokens int not null default 0,
  total_tokens int not null default 0,
  token_source text not null default 'none'
    check (token_source in ('provider', 'counted', 'estimated', 'none')),
  latency_ms int,
  had_error boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists platform_usage_events_tenant_created_idx
  on public.platform_usage_events (tenant_id, created_at desc);

create index if not exists platform_usage_events_created_idx
  on public.platform_usage_events (created_at desc);

create index if not exists platform_usage_events_chat_created_idx
  on public.platform_usage_events (chat_id, created_at desc);

-- ============================================================================
-- PHASE 2: TEAM MEMBERSHIP, QUEUES, PRESENCE
-- ============================================================================

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

insert into public.workspace_members (workspace_id, user_id, role, is_active)
select put.tenant_id, put.user_id, 'owner'::workspace_member_role, true
from public.platform_user_tenants put
left join public.workspace_members wm
  on wm.workspace_id = put.tenant_id
 and wm.user_id = put.user_id
where wm.id is null;

-- ============================================================================
-- PHASE 3: INVITATIONS, AUDIT, SEAT LIMITS
-- ============================================================================

alter table public.platform_subscriptions
  add column if not exists max_seats integer not null default 3;

update public.platform_subscriptions
set max_seats = case
  when plan = 'trial' then 3
  when plan = 'starter' then 5
  when plan = 'growth' then 25
  when plan = 'enterprise' then 500
  else max_seats
end
where max_seats is null
   or max_seats <= 0;

create table if not exists public.workspace_invitations (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null references public.tenants(tenant_id) on delete cascade,
  email text not null,
  role workspace_member_role not null default 'agent',
  token_hash text not null unique,
  invited_by uuid references public.platform_users(id) on delete set null,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_workspace_invitations_workspace
  on public.workspace_invitations (workspace_id, created_at desc);

create index if not exists idx_workspace_invitations_email
  on public.workspace_invitations (lower(email), expires_at desc);

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null references public.tenants(tenant_id) on delete cascade,
  actor_user_id uuid references public.platform_users(id) on delete set null,
  action text not null,
  target_type text not null,
  target_id text,
  ip_address text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_audit_logs_workspace
  on public.audit_logs (workspace_id, created_at desc);

create index if not exists idx_audit_logs_actor
  on public.audit_logs (actor_user_id, created_at desc);

-- ============================================================================
-- PHASE 4: SUPERVISOR CONTROLS, SLA, BUSINESS HOURS, OVERFLOW, COPILOT
-- ============================================================================

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

alter table public.messages
  add column if not exists is_draft boolean not null default false;

-- ============================================================================
-- PHASE 5: SCALE HARDENING + ENTERPRISE FEATURES
-- ============================================================================

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

alter table public.messages
  add column if not exists dedupe_key text;

create unique index if not exists idx_messages_chat_dedupe_key
  on public.messages (chat_id, dedupe_key)
  where dedupe_key is not null;

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

-- ============================================================================
-- PHASE 0 COMPLETION: BASE RLS POLICIES
-- ============================================================================

do $$
declare
  target_table text;
  policy_name text;
  target_tables text[] := array[
    'tenants',
    'chats',
    'messages',
    'conversation_events',
    'workspace_members',
    'queues',
    'queue_members',
    'agent_presence',
    'workspace_invitations',
    'audit_logs',
    'conversation_csat',
    'platform_usage_events'
  ];
begin
  foreach target_table in array target_tables loop
    execute format('alter table public.%I enable row level security', target_table);

    policy_name := format('%s_service_role_all', target_table);
    if not exists (
      select 1
      from pg_policies
      where schemaname = 'public'
        and tablename = target_table
        and policyname = policy_name
    ) then
      execute format(
        'create policy %I on public.%I for all to service_role using (true) with check (true)',
        policy_name,
        target_table
      );
    end if;
  end loop;
end $$;
