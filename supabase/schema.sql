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
  add column if not exists window_width integer not null default 380,
  add column if not exists window_height integer not null default 640,
  add column if not exists border_radius integer not null default 18,
  add column if not exists welcome_message text,
  add column if not exists bot_name text not null default 'AeroConcierge',
  add column if not exists bot_avatar_url text;

alter table public.tenants
  drop constraint if exists tenants_knowledge_status_check,
  drop constraint if exists tenants_widget_position_check,
  drop constraint if exists tenants_launcher_style_check;

alter table public.tenants
  add constraint tenants_knowledge_status_check
    check (knowledge_status in ('pending', 'processing', 'ready', 'warning', 'error')),
  add constraint tenants_widget_position_check
    check (widget_position in ('left', 'right')),
  add constraint tenants_launcher_style_check
    check (launcher_style in ('rounded', 'pill', 'square', 'minimal'));

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
  password_hash text not null,
  created_at timestamptz not null default now()
);

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
