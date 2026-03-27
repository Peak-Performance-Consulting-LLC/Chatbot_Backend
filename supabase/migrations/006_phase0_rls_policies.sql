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
