-- An exact recording boundary lets a user discard all prior journal history
-- without a later device or broker-history reconciliation restoring it.
alter table public.journal_settings
add column if not exists record_from timestamptz;

grant delete on public.journal_events to authenticated;

create policy "journal events owner reset delete"
on public.journal_events
for delete
to authenticated
using ((select auth.uid()) = user_id);

comment on column public.journal_settings.record_from is
  'Ignore executions before this exact UTC timestamp after a start-fresh reset.';
