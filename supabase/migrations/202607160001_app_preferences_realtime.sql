-- Replace client-clock conflict ordering with an idempotent, server-revisioned
-- compare-and-set RPC and publish preference changes to Supabase Realtime.
alter table public.app_preferences
  add column if not exists revision bigint not null default 1 check (revision > 0),
  add column if not exists mutation_id uuid not null default gen_random_uuid();

drop trigger if exists app_preferences_keep_newest on public.app_preferences;
drop function if exists public.keep_newest_app_preference();

revoke insert, update on public.app_preferences from authenticated;
grant select on public.app_preferences to authenticated;

create or replace function public.commit_app_preference(
  p_category text,
  p_schema_version integer,
  p_payload jsonb,
  p_device_id uuid,
  p_mutation_id uuid,
  p_expected_revision bigint
)
returns table (
  applied boolean,
  category text,
  schema_version integer,
  payload jsonb,
  revision bigint,
  mutation_id uuid,
  device_id uuid,
  server_updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner_id uuid := auth.uid();
  current_record public.app_preferences%rowtype;
begin
  if owner_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if p_schema_version is null or p_schema_version <> 1
     or p_payload is null or jsonb_typeof(p_payload) <> 'object'
     or p_device_id is null or p_mutation_id is null
     or p_expected_revision is null or p_expected_revision < 0 then
    raise exception 'Invalid app preference payload' using errcode = '22023';
  end if;
  if p_category not in (
    'chart_workspace', 'alerts', 'drawings', 'watchlist',
    'chart_display', 'order_entry', 'journal_fees'
  ) then
    raise exception 'Invalid app preference category' using errcode = '22023';
  end if;

  select ap.*
  into current_record
  from public.app_preferences as ap
  where ap.user_id = owner_id and ap.category = p_category
  for update;

  if not found then
    if p_expected_revision <> 0 then
      raise exception 'Missing app preference has nonzero expected revision' using errcode = '22023';
    end if;
    insert into public.app_preferences (
      user_id, category, schema_version, payload, modified_at, device_id,
      server_updated_at, revision, mutation_id
    ) values (
      owner_id, p_category, p_schema_version, p_payload, now(), p_device_id,
      now(), 1, p_mutation_id
    )
    on conflict (user_id, category) do nothing
    returning * into current_record;
    if found then
      return query select true, current_record.category, current_record.schema_version,
        current_record.payload, current_record.revision, current_record.mutation_id,
        current_record.device_id, current_record.server_updated_at;
      return;
    end if;

    -- Another device may have inserted this category after the first SELECT.
    -- Lock and evaluate that winner with the same retry/conflict rules below.
    select ap.*
    into current_record
    from public.app_preferences as ap
    where ap.user_id = owner_id and ap.category = p_category
    for update;
  end if;

  if current_record.mutation_id = p_mutation_id then
    return query select true, current_record.category, current_record.schema_version,
      current_record.payload, current_record.revision, current_record.mutation_id,
      current_record.device_id, current_record.server_updated_at;
    return;
  end if;

  if current_record.revision <> p_expected_revision then
    return query select false, current_record.category, current_record.schema_version,
      current_record.payload, current_record.revision, current_record.mutation_id,
      current_record.device_id, current_record.server_updated_at;
    return;
  end if;

  update public.app_preferences as ap
  set schema_version = p_schema_version,
      payload = p_payload,
      modified_at = now(),
      device_id = p_device_id,
      server_updated_at = now(),
      revision = current_record.revision + 1,
      mutation_id = p_mutation_id
  where ap.user_id = owner_id and ap.category = p_category
  returning ap.* into current_record;

  return query select true, current_record.category, current_record.schema_version,
    current_record.payload, current_record.revision, current_record.mutation_id,
    current_record.device_id, current_record.server_updated_at;
end;
$$;

revoke all on function public.commit_app_preference(text, integer, jsonb, uuid, uuid, bigint) from public;
grant execute on function public.commit_app_preference(text, integer, jsonb, uuid, uuid, bigint) to authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1
       from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'app_preferences'
     ) then
    alter publication supabase_realtime add table public.app_preferences;
  end if;
end;
$$;

comment on function public.commit_app_preference(text, integer, jsonb, uuid, uuid, bigint) is
  'Owner-scoped compare-and-set commit for idempotent cross-device app preference synchronization.';
