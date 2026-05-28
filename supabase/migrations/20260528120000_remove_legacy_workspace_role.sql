-- Removes the retired elevated workspace role from live databases.

do $$
declare
  retired_role text := concat('super', 'visor');
begin
  if exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    join pg_enum e on e.enumtypid = t.oid
    where n.nspname = 'public'
      and t.typname = 'workspace_member_role'
      and e.enumlabel = retired_role
  ) then
    update public.workspace_members
      set role = 'admin'::public.workspace_member_role
      where role::text = retired_role;

    update public.workspace_invitations
      set role = 'admin'::public.workspace_member_role
      where role::text = retired_role;

    alter table public.workspace_members
      alter column role drop default;

    alter table public.workspace_invitations
      alter column role drop default;

    alter type public.workspace_member_role
      rename to workspace_member_role_legacy_20260528120000;

    create type public.workspace_member_role as enum (
      'owner',
      'admin',
      'agent',
      'viewer'
    );

    alter table public.workspace_members
      alter column role type public.workspace_member_role
      using role::text::public.workspace_member_role,
      alter column role set default 'agent'::public.workspace_member_role;

    alter table public.workspace_invitations
      alter column role type public.workspace_member_role
      using role::text::public.workspace_member_role,
      alter column role set default 'agent'::public.workspace_member_role;

    drop type public.workspace_member_role_legacy_20260528120000;
  end if;
end $$;

update public.conversation_csat
  set submitted_by = 'system'
  where submitted_by = concat('super', 'visor');

alter table public.conversation_csat
  drop constraint if exists conversation_csat_submitted_by_check;

alter table public.conversation_csat
  add constraint conversation_csat_submitted_by_check
    check (submitted_by in ('visitor', 'agent', 'system'));
