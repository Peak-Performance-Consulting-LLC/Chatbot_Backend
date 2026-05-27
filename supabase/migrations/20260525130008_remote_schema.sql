drop extension if exists "pg_net";

alter table "public"."flight_search_states" drop constraint "flight_search_states_status_check";

drop index if exists "public"."idx_chats_agent_typing_activity";

alter table "public"."chats" drop column "last_agent_typing_at";

alter table "public"."flight_search_sessions" enable row level security;

alter table "public"."flight_search_states" enable row level security;

alter table "public"."knowledge_chunks" enable row level security;

alter table "public"."platform_password_resets" enable row level security;

alter table "public"."platform_sessions" enable row level security;

alter table "public"."platform_subscriptions" enable row level security;

alter table "public"."platform_user_tenants" enable row level security;

alter table "public"."platform_users" enable row level security;

alter table "public"."service_request_states" enable row level security;

alter table "public"."tenant_domain_verifications" enable row level security;

alter table "public"."tenant_sources" enable row level security;

alter table "public"."tenants" alter column "notif_text" set default '👋 Need help?'::text;

alter table "public"."visitor_contacts" enable row level security;

alter table "public"."flight_search_states" add constraint "flight_search_states_status_check" CHECK ((status = ANY (ARRAY['collecting'::text, 'ready'::text, 'completed'::text]))) not valid;

alter table "public"."flight_search_states" validate constraint "flight_search_states_status_check";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  new.updated_at = now();
  return new;
end;
$function$
;


