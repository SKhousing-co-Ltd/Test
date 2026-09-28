-- 単価を「変動」にした小分類の単価計算です。
-- 単価の決め方（手入力／請求額から計算）と、計算した単価の小数点以下の処理は小分類の設定として持ち、
-- 手入力の単価・水道会社などからの請求額・使用量は月ごとに持ちます。
alter table public.asset_meter_sub_item
  add column if not exists variable_price_method varchar(10) not null default 'manual'
    check (variable_price_method in ('manual', 'billed')),
  add column if not exists unit_price_rounding_digits smallint not null default 2
    check (unit_price_rounding_digits between 0 and 3),
  add column if not exists unit_price_rounding_mode varchar(10) not null default 'floor'
    check (unit_price_rounding_mode in ('floor', 'ceil', 'round'));

comment on column public.asset_meter_sub_item.variable_price_method is '変動単価の決め方（manual：手入力／billed：請求額÷使用量）';
comment on column public.asset_meter_sub_item.unit_price_rounding_digits is '請求額から計算した単価の、残す小数点以下の桁数';
comment on column public.asset_meter_sub_item.unit_price_rounding_mode is '請求額から計算した単価の丸め方';

create table if not exists public.meter_reading_month_sub_item (
  asset_id uuid not null,
  billing_month date not null,
  asset_meter_sub_item_id uuid not null references public.asset_meter_sub_item(asset_meter_sub_item_id) on delete cascade,
  -- 手入力の単価です。
  unit_price numeric(12, 4),
  -- 請求額です。税抜は手入力したときだけ持ち、それ以外は税込・消費税から求めます。
  billed_inclusive numeric(12, 0),
  billed_tax numeric(12, 0),
  billed_exclusive numeric(12, 0),
  billed_usage numeric(14, 3),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (asset_id, billing_month, asset_meter_sub_item_id),
  foreign key (asset_id, billing_month) references public.meter_reading_month(asset_id, billing_month) on delete cascade
);

alter table public.meter_reading_month_sub_item enable row level security;
grant select, insert, update, delete on public.meter_reading_month_sub_item to authenticated;
create policy "active users manage meter reading month sub items" on public.meter_reading_month_sub_item for all to authenticated
  using (public.current_account_is_active()) with check (public.current_account_is_active());

drop trigger if exists set_meter_reading_month_sub_item_updated_at on public.meter_reading_month_sub_item;
create trigger set_meter_reading_month_sub_item_updated_at before update on public.meter_reading_month_sub_item
  for each row execute procedure public.set_billing_item_setting_updated_at();

comment on table public.meter_reading_month_sub_item is '変動単価の小分類の月次入力（手入力の単価、請求額と使用量）。';
