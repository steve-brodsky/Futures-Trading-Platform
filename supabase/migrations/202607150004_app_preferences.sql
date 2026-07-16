create table if not exists public.app_preferences (
  user_id uuid not null references auth.users(id) on delete cascade,
  category text not null check (category in (
    'chart_workspace',
    'alerts',
    'drawings',
    'watchlist',
    'chart_display',
    'order_entry',
    'journal_fees'
  )),
  schema_version integer not null default 1 check (schema_version = 1),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  modified_at timestamptz not null,
  device_id uuid not null,
  server_updated_at timestamptz not null default now(),
  primary key (user_id, category)
);

create or replace function public.keep_newest_app_preference()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and (new.modified_at, new.device_id::text) <= (old.modified_at, old.device_id::text) then
    return old;
  end if;
  new.server_updated_at = now();
  return new;
end;
$$;

drop trigger if exists app_preferences_keep_newest on public.app_preferences;
create trigger app_preferences_keep_newest
before insert or update on public.app_preferences
for each row execute function public.keep_newest_app_preference();

alter table public.app_preferences enable row level security;

grant select, insert, update on public.app_preferences to authenticated;

create policy "app preferences owner read"
on public.app_preferences
for select
to authenticated
using ((select auth.uid()) = user_id);

create policy "app preferences owner insert"
on public.app_preferences
for insert
to authenticated
with check ((select auth.uid()) = user_id);

create policy "app preferences owner update"
on public.app_preferences
for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

comment on table public.app_preferences is
  'Owner-scoped, non-secret Northstar preferences synchronized between desktop devices.';
comment on column public.app_preferences.payload is
  'Versioned preference data only. Credentials, tokens, broker account IDs, and connection configuration are forbidden.';
