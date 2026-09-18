-- 月次確定した検針の請求金額を、そのときの条件ごと残すテーブルです。
-- 単価や丸めの設定を後から変えても、確定済みの月の金額が動かないようにします。
create table if not exists public.meter_reading_confirmed_amount (
  meter_reading_confirmed_amount_id uuid primary key default gen_random_uuid(),
  asset_id uuid not null,
  billing_month date not null,
  -- 契約行は後から消えることがあるため、消えても金額は残します。
  meter_reading_contract_id uuid references public.meter_reading_contract(meter_reading_contract_id) on delete set null,
  tenant_id uuid not null references public.tenant_master(tenant_id) on delete restrict,
  tenant_name varchar(200) not null,
  row_no smallint not null default 1 check (row_no between 1 and 9),
  invoice_number smallint not null default 1 check (invoice_number between 1 and 3),
  category varchar(10) not null check (category in ('electric', 'water', 'gas')),
  -- 小分類の金額か、分類全体にかかる増額分の金額かです。
  source_kind varchar(10) not null check (source_kind in ('subItem', 'surcharge')),
  source_id uuid,
  source_name varchar(100) not null,
  -- 請求明細のどの項目として請求したかです。項目が消えても名前は残します。
  asset_billing_line_item_id uuid references public.asset_billing_line_item(asset_billing_line_item_id) on delete set null,
  line_item_name varchar(200),
  usage_amount numeric(14, 3) not null default 0,
  usage_unit varchar(10) not null,
  unit_price numeric(12, 4),
  amount numeric(12, 0) not null,
  -- 確定時に適用した丸めです。金額の再現に必要なため、設定側とは別に残します。
  amount_rounding_mode varchar(10) not null check (amount_rounding_mode in ('floor', 'ceil', 'round')),
  usage_rounding_digits smallint check (usage_rounding_digits between 0 and 3),
  usage_rounding_mode varchar(10) check (usage_rounding_mode in ('floor', 'ceil', 'round')),
  tax_mode varchar(10) check (tax_mode in ('exclusive', 'inclusive')),
  tax_rate numeric(5, 4),
  created_at timestamptz not null default now(),
  foreign key (asset_id, billing_month) references public.meter_reading_month(asset_id, billing_month) on delete cascade,
  constraint uq_meter_reading_confirmed_amount unique (asset_id, billing_month, meter_reading_contract_id, source_kind, source_id)
);

create index if not exists ix_meter_reading_confirmed_amount_month on public.meter_reading_confirmed_amount(asset_id, billing_month);
create index if not exists ix_meter_reading_confirmed_amount_tenant on public.meter_reading_confirmed_amount(tenant_id, billing_month);

alter table public.meter_reading_confirmed_amount enable row level security;

-- 確定した金額は書き換えず、確定解除のときだけ消して入れ直します。
grant select, insert, delete on public.meter_reading_confirmed_amount to authenticated;

create policy "active users read confirmed meter amounts" on public.meter_reading_confirmed_amount
  for select to authenticated using (public.current_account_is_active());
create policy "active users insert confirmed meter amounts" on public.meter_reading_confirmed_amount
  for insert to authenticated with check (public.current_account_is_active());
create policy "active users delete confirmed meter amounts" on public.meter_reading_confirmed_amount
  for delete to authenticated using (public.current_account_is_active());

comment on table public.meter_reading_confirmed_amount is '月次確定した検針の請求金額。確定時の使用量・単価・丸めを残し、後から設定を変えても過去月が動かないようにする。';
