-- Make retries with the same logical version true no-ops. This avoids a row
-- update and server_updated_at churn when a client repeats an acknowledged
-- preference upload.
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
