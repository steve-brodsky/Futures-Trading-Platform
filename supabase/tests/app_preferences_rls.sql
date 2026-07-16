begin;
select plan(18);
select has_table('public','app_preferences','app preferences table exists');
select col_is_pk('public','app_preferences',array['user_id','category'],'preferences are unique per owner and category');
select policies_are(
  'public',
  'app_preferences',
  array['app preferences owner insert','app preferences owner read','app preferences owner update'],
  'preferences expose only owner-scoped policies'
);
select col_type_is('public','app_preferences','payload','jsonb','preference payload is jsonb');
select col_type_is('public','app_preferences','device_id','uuid','device tie-breaker is a uuid');
select col_type_is('public','app_preferences','revision','bigint','server revision is a bigint');
select col_type_is('public','app_preferences','mutation_id','uuid','mutation id is a uuid');
select has_function(
  'public',
  'commit_app_preference',
  array['text','integer','jsonb','uuid','uuid','bigint'],
  'preference compare-and-set RPC exists'
);
select ok(
  exists (
    select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='app_preferences'
  ),
  'app preferences are published to Realtime'
);
select ok(
  not has_table_privilege('authenticated','public.app_preferences','INSERT'),
  'authenticated clients cannot bypass the commit RPC with direct inserts'
);
select ok(
  not has_table_privilege('authenticated','public.app_preferences','UPDATE'),
  'authenticated clients cannot bypass the commit RPC with direct updates'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

select is(
  (select applied from public.commit_app_preference(
    'watchlist', 1, '{"symbols":["MESU26"]}'::jsonb,
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 0
  )),
  true,
  'first preference commit is accepted'
);
select is(
  (select revision from public.commit_app_preference(
    'watchlist', 1, '{"symbols":["MESU26"]}'::jsonb,
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 0
  )),
  1::bigint,
  'retrying a mutation is idempotent'
);
select is(
  (select applied from public.commit_app_preference(
    'watchlist', 1, '{"symbols":["MNQU26"]}'::jsonb,
    'cccccccc-cccc-cccc-cccc-cccccccccccc',
    'dddddddd-dddd-dddd-dddd-dddddddddddd', 0
  )),
  false,
  'stale concurrent preference commit loses'
);
select is(
  (select payload from public.commit_app_preference(
    'watchlist', 1, '{"symbols":["MNQU26"]}'::jsonb,
    'cccccccc-cccc-cccc-cccc-cccccccccccc',
    'dddddddd-dddd-dddd-dddd-dddddddddddd', 0
  )),
  '{"symbols":["MESU26"]}'::jsonb,
  'conflict returns the authoritative preference'
);
select is(
  (select revision from public.commit_app_preference(
    'watchlist', 1, '{"symbols":["MCLU26"]}'::jsonb,
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 1
  )),
  2::bigint,
  'commit against the current revision advances it'
);
select is(
  (select user_id from public.app_preferences where category='watchlist'),
  '11111111-1111-1111-1111-111111111111'::uuid,
  'RPC writes only for the authenticated owner'
);
set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
select is(
  (select count(*) from public.app_preferences),
  0::bigint,
  'another authenticated owner cannot read the first owner preferences'
);
select * from finish();
rollback;
