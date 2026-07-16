begin;
select plan(6);
select has_table('public','app_preferences','app preferences table exists');
select col_is_pk('public','app_preferences',array['user_id','category'],'preferences are unique per owner and category');
select policies_are(
  'public',
  'app_preferences',
  array['app preferences owner insert','app preferences owner read','app preferences owner update'],
  'preferences expose only owner-scoped policies'
);
select has_trigger('public','app_preferences','app_preferences_keep_newest','newest-wins trigger exists');
select col_type_is('public','app_preferences','payload','jsonb','preference payload is jsonb');
select col_type_is('public','app_preferences','device_id','uuid','device tie-breaker is a uuid');
select * from finish();
rollback;
