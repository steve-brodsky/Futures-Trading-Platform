alter table public.journal_trades
  add column if not exists provider text not null default 'tradestation'
    check (provider in ('tradestation','schwab')),
  add column if not exists asset_class text not null default 'futures'
    check (asset_class in ('futures','option')),
  add column if not exists strategy text not null default 'futures-directional'
    check (strategy in ('futures-directional','long-strangle','short-strangle')),
  add column if not exists underlying text;

alter table public.journal_events
  add column if not exists provider text not null default 'tradestation'
    check (provider in ('tradestation','schwab')),
  add column if not exists broker_leg_id text,
  add column if not exists option_symbol text;

drop index if exists public.journal_trades_scope_opened_idx;
create index if not exists journal_trades_provider_scope_opened_idx
  on public.journal_trades(user_id,provider,environment,account_id,opened_at desc);

create table if not exists public.journal_option_legs (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  trade_id text not null,
  option_symbol text not null,
  underlying text not null,
  expiration_date date not null,
  strike_price numeric not null,
  put_call text not null check (put_call in ('CALL','PUT')),
  opening_side text not null check (opening_side in ('Buy','Sell')),
  opened_quantity numeric not null default 0,
  closed_quantity numeric not null default 0,
  average_entry numeric not null default 0,
  average_exit numeric,
  multiplier numeric not null default 100,
  gross_pnl numeric not null default 0,
  fees numeric not null default 0,
  status text not null check (status in ('open','closed')),
  replaces_leg_id text,
  updated_at timestamptz not null default now(),
  primary key (user_id,id),
  foreign key (user_id,trade_id) references public.journal_trades(user_id,id) on delete cascade
);

create index if not exists journal_option_legs_trade_idx
  on public.journal_option_legs(user_id,trade_id);

alter table public.journal_option_legs enable row level security;
grant select,insert,update,delete on public.journal_option_legs to authenticated;

create policy "journal option legs owner access"
on public.journal_option_legs for all to authenticated
using ((select auth.uid())=user_id)
with check ((select auth.uid())=user_id);

comment on table public.journal_option_legs is
  'Owner-scoped execution state for Schwab option legs grouped into journal strangle campaigns.';
