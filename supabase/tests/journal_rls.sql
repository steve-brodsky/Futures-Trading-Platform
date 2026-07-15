begin;
select plan(4);
select has_table('public','journal_trades','journal trades table exists');
select has_table('public','journal_events','journal events table exists');
select policies_are('public','journal_events',array['journal events owner insert','journal events owner read'],'events expose only owner insert/read policies');
select policies_are('public','journal_trades',array['journal trades owner insert','journal trades owner read','journal trades owner repair delete','journal trades owner update'],'trade snapshots expose owner-scoped repair policies');
select * from finish();
rollback;
