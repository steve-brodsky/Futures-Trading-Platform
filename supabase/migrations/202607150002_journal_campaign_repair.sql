-- Derived campaign rows may be removed only so Northstar can repair a
-- previously misclassified closing fill. Append-only journal_events remain
-- immutable and preserve the original broker audit trail.
grant delete on public.journal_trades to authenticated;

create policy "journal trades owner repair delete"
on public.journal_trades
for delete
to authenticated
using ((select auth.uid()) = user_id);
