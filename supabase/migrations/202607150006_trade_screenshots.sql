insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
values ('trade-screenshots','trade-screenshots',false,5242880,array['image/png'])
on conflict (id) do update set
  public=false,
  file_size_limit=excluded.file_size_limit,
  allowed_mime_types=excluded.allowed_mime_types;

create table if not exists public.journal_screenshots (
  user_id uuid not null references auth.users(id) on delete cascade,
  trade_id text not null,
  object_path text not null,
  captured_at timestamptz not null,
  width integer not null check (width between 1 and 8192),
  height integer not null check (height between 1 and 8192),
  content_type text not null check (content_type='image/png'),
  created_at timestamptz not null default now(),
  primary key (user_id,trade_id),
  unique (object_path),
  foreign key (user_id,trade_id) references public.journal_trades(user_id,id) on delete cascade,
  check (object_path=(user_id::text || '/' || trade_id || '/entry.png'))
);

alter table public.journal_screenshots enable row level security;
grant select,insert,delete on public.journal_screenshots to authenticated;

create policy "journal screenshots owner read"
on public.journal_screenshots for select to authenticated
using ((select auth.uid())=user_id);

create policy "journal screenshots owner insert"
on public.journal_screenshots for insert to authenticated
with check ((select auth.uid())=user_id);

create policy "journal screenshots owner delete"
on public.journal_screenshots for delete to authenticated
using ((select auth.uid())=user_id);

create policy "trade screenshots owner read"
on storage.objects for select to authenticated
using (
  bucket_id='trade-screenshots'
  and (storage.foldername(name))[1]=(select auth.uid())::text
);

create policy "trade screenshots owner insert"
on storage.objects for insert to authenticated
with check (
  bucket_id='trade-screenshots'
  and (storage.foldername(name))[1]=(select auth.uid())::text
  and name like ((select auth.uid())::text || '/%/entry.png')
);

create policy "trade screenshots owner delete"
on storage.objects for delete to authenticated
using (
  bucket_id='trade-screenshots'
  and (storage.foldername(name))[1]=(select auth.uid())::text
);

comment on table public.journal_screenshots is 'Owner-scoped metadata for private cloud-only entry chart PNGs.';
