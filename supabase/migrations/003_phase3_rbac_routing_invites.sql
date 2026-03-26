-- Phase 3: RBAC, Auto-Assign Routing, Invitations, Audit

-- ============================================================
-- 1) Subscription seat limits
-- ============================================================
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

-- ============================================================
-- 2) Workspace invitation flow
-- ============================================================
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

-- ============================================================
-- 3) Audit logs
-- ============================================================
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
