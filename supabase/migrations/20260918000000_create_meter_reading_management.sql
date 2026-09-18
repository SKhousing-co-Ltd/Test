-- 検針データの管理テーブルです。画面の構成（分類・小分類・メーター・契約行）と
-- 月次の検針値を物件ごとのデータとして保持し、集計処理は全ビル共通で行えるようにします。

-- 分類は電気・水道・ガスの3つで固定し、物件ごとに請求するかどうかと使用量の単位を持ちます。
create table if not exists public.asset_meter_category_setting (
  asset_id uuid not null references public.asset_master(asset_id) on delete cascade,
  category varchar(10) not null check (category in ('electric', 'water', 'gas')),
  usage_unit varchar(10) not null default 'kWh',
  is_billable boolean not null default true,
  is_basic_billable boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (asset_id, category)
);

-- 小分類です。基本料は分類ごとに1つ固定で、それ以外は物件ごとに増減できます。
create table if not exists public.asset_meter_sub_item (
  asset_meter_sub_item_id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.asset_master(asset_id) on delete cascade,
  category varchar(10) not null check (category in ('electric', 'water', 'gas')),
  sub_item_name varchar(100) not null,
  sub_item_kind varchar(10) not null check (sub_item_kind in ('basic', 'custom')),
  -- 請求明細のどの項目として請求するかです。請求種別に公共料金が設定された項目だけを紐づけます。
  asset_billing_line_item_id uuid references public.asset_billing_line_item(asset_billing_line_item_id) on delete set null,
  price_mode varchar(10) not null default 'fixed' check (price_mode in ('fixed', 'variable')),
  default_unit_price numeric(12, 4),
  tax_mode varchar(10) not null default 'exclusive' check (tax_mode in ('exclusive', 'inclusive')),
  tax_rounding_digits smallint not null default 2 check (tax_rounding_digits between 0 and 3),
  tax_rounding_mode varchar(10) not null default 'floor' check (tax_rounding_mode in ('floor', 'ceil', 'round')),
  usage_rounding_digits smallint not null default 1 check (usage_rounding_digits between 0 and 3),
  usage_rounding_mode varchar(10) not null default 'round' check (usage_rounding_mode in ('floor', 'ceil', 'round')),
  -- 既定の請求期間です。請求設定の請求期間パターンから選びます。
  billing_period_pattern_id uuid references public.asset_billing_period_pattern(billing_period_pattern_id) on delete set null,
  sort_order integer not null default 0 check (sort_order >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_asset_meter_sub_item_name unique (asset_id, category, sub_item_name),
  constraint ck_asset_meter_sub_item_basic check (sub_item_kind <> 'basic' or (price_mode = 'fixed' and default_unit_price is null))
);

-- 増額分です。小分類ではなく、分類全体の使用量にかかります。単価は月ごとに持ちます。
create table if not exists public.asset_meter_surcharge (
  asset_meter_surcharge_id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.asset_master(asset_id) on delete cascade,
  category varchar(10) not null check (category in ('electric', 'water', 'gas')),
  surcharge_name varchar(100) not null,
  asset_billing_line_item_id uuid references public.asset_billing_line_item(asset_billing_line_item_id) on delete set null,
  is_billable boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_asset_meter_surcharge_name unique (asset_id, category, surcharge_name)
);

-- 契約行です。1テナントが複数区画を契約している場合、データ分割の数だけ行を持ちます。
create table if not exists public.meter_reading_contract (
  meter_reading_contract_id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.asset_master(asset_id) on delete cascade,
  tenant_id uuid not null references public.tenant_master(tenant_id) on delete cascade,
  row_no smallint not null default 1 check (row_no between 1 and 9),
  -- 請求書分割設定で区画ごとに請求書を分けている場合、この行をどの請求書に載せるかです。
  invoice_number smallint not null default 1 check (invoice_number between 1 and 3),
  electric_billable boolean not null default true,
  water_billable boolean not null default true,
  gas_billable boolean not null default true,
  electric_sum_mode varchar(12) not null default 'aggregate' check (electric_sum_mode in ('aggregate', 'perMeter')),
  water_sum_mode varchar(12) not null default 'aggregate' check (water_sum_mode in ('aggregate', 'perMeter')),
  gas_sum_mode varchar(12) not null default 'aggregate' check (gas_sum_mode in ('aggregate', 'perMeter')),
  amount_rounding_mode varchar(10) not null default 'floor' check (amount_rounding_mode in ('floor', 'ceil', 'round')),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_meter_reading_contract_row unique (asset_id, tenant_id, row_no)
);

-- 契約行ごとの小分類の設定です。請求するかどうかと、契約単価（未設定なら小分類の既定単価）を持ちます。
create table if not exists public.meter_reading_contract_item (
  meter_reading_contract_id uuid not null references public.meter_reading_contract(meter_reading_contract_id) on delete cascade,
  asset_meter_sub_item_id uuid not null references public.asset_meter_sub_item(asset_meter_sub_item_id) on delete cascade,
  is_billable boolean not null default true,
  unit_price numeric(12, 4),
  -- 基本料の金額です。小分類が基本料のときだけ使います。
  fixed_amount numeric(12, 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (meter_reading_contract_id, asset_meter_sub_item_id)
);

-- メーターです。小分類に属し、メーター番号とメーター識別（設置位置など）を持ちます。
create table if not exists public.asset_meter (
  asset_meter_id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.asset_master(asset_id) on delete cascade,
  asset_meter_sub_item_id uuid not null references public.asset_meter_sub_item(asset_meter_sub_item_id) on delete cascade,
  meter_code varchar(100) not null,
  meter_label varchar(100),
  -- 割当先の契約行です。テナントはこの行を通じて決まります。
  meter_reading_contract_id uuid references public.meter_reading_contract(meter_reading_contract_id) on delete set null,
  unit_price_override numeric(12, 4),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_asset_meter_code unique (asset_meter_sub_item_id, meter_code)
);

-- 月次の検針ヘッダーです。検針日と確定状態を持ちます。前回検針日は前月の行を参照します。
create table if not exists public.meter_reading_month (
  asset_id uuid not null references public.asset_master(asset_id) on delete cascade,
  billing_month date not null,
  meter_date date,
  status varchar(10) not null default 'draft' check (status in ('draft', 'confirmed')),
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (asset_id, billing_month),
  constraint ck_meter_reading_month_first_day check (billing_month = date_trunc('month', billing_month)::date)
);

-- 増額分の単価は月ごとに変わるため、月次で保持します。
create table if not exists public.meter_reading_month_surcharge (
  asset_id uuid not null,
  billing_month date not null,
  asset_meter_surcharge_id uuid not null references public.asset_meter_surcharge(asset_meter_surcharge_id) on delete cascade,
  unit_price numeric(12, 4) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (asset_id, billing_month, asset_meter_surcharge_id),
  foreign key (asset_id, billing_month) references public.meter_reading_month(asset_id, billing_month) on delete cascade
);

-- 月次の検針値です。使用量を保持します。
create table if not exists public.meter_reading_entry (
  asset_id uuid not null,
  billing_month date not null,
  asset_meter_id uuid not null references public.asset_meter(asset_meter_id) on delete cascade,
  usage_amount numeric(14, 3) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (asset_id, billing_month, asset_meter_id),
  foreign key (asset_id, billing_month) references public.meter_reading_month(asset_id, billing_month) on delete cascade
);

create index if not exists ix_asset_meter_sub_item_asset on public.asset_meter_sub_item(asset_id, category, sort_order);
create index if not exists ix_asset_meter_surcharge_asset on public.asset_meter_surcharge(asset_id, category);
create index if not exists ix_meter_reading_contract_asset on public.meter_reading_contract(asset_id, tenant_id, row_no);
create index if not exists ix_asset_meter_sub_item_contract on public.asset_meter(asset_meter_sub_item_id, meter_reading_contract_id);
create index if not exists ix_meter_reading_entry_meter on public.meter_reading_entry(asset_meter_id, billing_month);

alter table public.asset_meter_category_setting enable row level security;
alter table public.asset_meter_sub_item enable row level security;
alter table public.asset_meter_surcharge enable row level security;
alter table public.meter_reading_contract enable row level security;
alter table public.meter_reading_contract_item enable row level security;
alter table public.asset_meter enable row level security;
alter table public.meter_reading_month enable row level security;
alter table public.meter_reading_month_surcharge enable row level security;
alter table public.meter_reading_entry enable row level security;

grant select, insert, update, delete on
  public.asset_meter_category_setting,
  public.asset_meter_sub_item,
  public.asset_meter_surcharge,
  public.meter_reading_contract,
  public.meter_reading_contract_item,
  public.asset_meter,
  public.meter_reading_month,
  public.meter_reading_month_surcharge,
  public.meter_reading_entry
to authenticated;

create policy "active users manage meter category settings" on public.asset_meter_category_setting for all to authenticated using (public.current_account_is_active()) with check (public.current_account_is_active());
create policy "active users manage meter sub items" on public.asset_meter_sub_item for all to authenticated using (public.current_account_is_active()) with check (public.current_account_is_active());
create policy "active users manage meter surcharges" on public.asset_meter_surcharge for all to authenticated using (public.current_account_is_active()) with check (public.current_account_is_active());
create policy "active users manage meter reading contracts" on public.meter_reading_contract for all to authenticated using (public.current_account_is_active()) with check (public.current_account_is_active());
create policy "active users manage meter reading contract items" on public.meter_reading_contract_item for all to authenticated using (public.current_account_is_active()) with check (public.current_account_is_active());
create policy "active users manage asset meters" on public.asset_meter for all to authenticated using (public.current_account_is_active()) with check (public.current_account_is_active());
create policy "active users manage meter reading months" on public.meter_reading_month for all to authenticated using (public.current_account_is_active()) with check (public.current_account_is_active());
create policy "active users manage meter reading month surcharges" on public.meter_reading_month_surcharge for all to authenticated using (public.current_account_is_active()) with check (public.current_account_is_active());
create policy "active users manage meter reading entries" on public.meter_reading_entry for all to authenticated using (public.current_account_is_active()) with check (public.current_account_is_active());

drop trigger if exists set_asset_meter_category_setting_updated_at on public.asset_meter_category_setting;
create trigger set_asset_meter_category_setting_updated_at before update on public.asset_meter_category_setting for each row execute procedure public.set_billing_item_setting_updated_at();
drop trigger if exists set_asset_meter_sub_item_updated_at on public.asset_meter_sub_item;
create trigger set_asset_meter_sub_item_updated_at before update on public.asset_meter_sub_item for each row execute procedure public.set_billing_item_setting_updated_at();
drop trigger if exists set_asset_meter_surcharge_updated_at on public.asset_meter_surcharge;
create trigger set_asset_meter_surcharge_updated_at before update on public.asset_meter_surcharge for each row execute procedure public.set_billing_item_setting_updated_at();
drop trigger if exists set_meter_reading_contract_updated_at on public.meter_reading_contract;
create trigger set_meter_reading_contract_updated_at before update on public.meter_reading_contract for each row execute procedure public.set_billing_item_setting_updated_at();
drop trigger if exists set_meter_reading_contract_item_updated_at on public.meter_reading_contract_item;
create trigger set_meter_reading_contract_item_updated_at before update on public.meter_reading_contract_item for each row execute procedure public.set_billing_item_setting_updated_at();
drop trigger if exists set_asset_meter_updated_at on public.asset_meter;
create trigger set_asset_meter_updated_at before update on public.asset_meter for each row execute procedure public.set_billing_item_setting_updated_at();
drop trigger if exists set_meter_reading_month_updated_at on public.meter_reading_month;
create trigger set_meter_reading_month_updated_at before update on public.meter_reading_month for each row execute procedure public.set_billing_item_setting_updated_at();
drop trigger if exists set_meter_reading_month_surcharge_updated_at on public.meter_reading_month_surcharge;
create trigger set_meter_reading_month_surcharge_updated_at before update on public.meter_reading_month_surcharge for each row execute procedure public.set_billing_item_setting_updated_at();
drop trigger if exists set_meter_reading_entry_updated_at on public.meter_reading_entry;
create trigger set_meter_reading_entry_updated_at before update on public.meter_reading_entry for each row execute procedure public.set_billing_item_setting_updated_at();

comment on table public.asset_meter_sub_item is '検針データの小分類。基本料は分類ごとに1つ、それ以外は物件ごとに増減できる。';
comment on table public.meter_reading_contract is '検針データの契約行。データ分割した場合は分割数だけ行を持つ。';
comment on table public.asset_meter is 'メーター。小分類に属し、契約行を通じてテナントへ紐づく。';
comment on table public.meter_reading_entry is '月次の検針値。確定後の金額は請求側でスナップショットする。';
