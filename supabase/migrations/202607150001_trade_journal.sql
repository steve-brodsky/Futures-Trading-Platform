create table if not exists public.journal_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  timezone text not null default 'America/New_York' check (timezone = 'America/New_York'),
  backfill_start date not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.journal_trades (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  environment text not null check (environment in ('sim','live')),
  account_id text not null,
  symbol text not null,
  direction text not null check (direction in ('Long','Short')),
  status text not null check (status in ('open','closed')),
  opened_at timestamptz not null,
  closed_at timestamptz,
  entry_quantity numeric not null default 0,
  exit_quantity numeric not null default 0,
  average_entry numeric not null,
  average_exit numeric,
  original_stop numeric,
  original_target numeric,
  planned_risk numeric,
  deployed_risk numeric,
  point_value numeric,
  gross_pnl numeric not null default 0,
  fees numeric not null default 0,
  net_pnl numeric not null default 0,
  r_multiple numeric,
  risk_provenance text not null check (risk_provenance in ('exact','inferred','unknown')),
  updated_at timestamptz not null default now(),
  primary key (user_id,id)
);

create table if not exists public.journal_events (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  event_key text not null,
  trade_id text,
  environment text not null check (environment in ('sim','live')),
  account_id text not null,
  broker_order_id text,
  event_type text not null,
  occurred_at timestamptz not null,
  source text not null check (source in ('northstar','broker-stream','broker-history')),
  status text,
  old_price numeric,
  new_price numeric,
  quantity numeric,
  price numeric,
  note text,
  created_at timestamptz not null default now(),
  primary key (user_id,id),
  unique (user_id,event_key)
);

create table if not exists public.journal_annotations (
  user_id uuid not null references auth.users(id) on delete cascade,
  trade_id text not null,
  notes text not null default '',
  tags text[] not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (user_id,trade_id),
  foreign key (user_id,trade_id) references public.journal_trades(user_id,id) on delete cascade
);

create index if not exists journal_trades_scope_opened_idx on public.journal_trades(user_id,environment,account_id,opened_at desc);
create index if not exists journal_events_trade_time_idx on public.journal_events(user_id,trade_id,occurred_at);
create index if not exists journal_events_broker_order_idx on public.journal_events(user_id,environment,account_id,broker_order_id);

alter table public.journal_settings enable row level security;
alter table public.journal_trades enable row level security;
alter table public.journal_events enable row level security;
alter table public.journal_annotations enable row level security;

grant select,insert,update,delete on public.journal_settings to authenticated;
grant select,insert,update on public.journal_trades to authenticated;
grant select,insert on public.journal_events to authenticated;
grant select,insert,update,delete on public.journal_annotations to authenticated;

create policy "journal settings owner access" on public.journal_settings for all to authenticated using ((select auth.uid())=user_id) with check ((select auth.uid())=user_id);
create policy "journal trades owner read" on public.journal_trades for select to authenticated using ((select auth.uid())=user_id);
create policy "journal trades owner insert" on public.journal_trades for insert to authenticated with check ((select auth.uid())=user_id);
create policy "journal trades owner update" on public.journal_trades for update to authenticated using ((select auth.uid())=user_id) with check ((select auth.uid())=user_id);
create policy "journal events owner read" on public.journal_events for select to authenticated using ((select auth.uid())=user_id);
create policy "journal events owner insert" on public.journal_events for insert to authenticated with check ((select auth.uid())=user_id);
create policy "journal annotations owner access" on public.journal_annotations for all to authenticated using ((select auth.uid())=user_id) with check ((select auth.uid())=user_id);

comment on table public.journal_events is 'Append-only normalized TradeStation and Northstar execution audit events.';
comment on column public.journal_trades.account_id is 'Broker account identifier protected by owner-scoped RLS; clients must mask it for display.';
