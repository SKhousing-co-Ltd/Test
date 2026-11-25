create table public.garage_certificate_records (
  id uuid primary key default gen_random_uuid(),
  issued_on date, building_name text not null, tenant_name text not null,
  contact_name text, parking_number text, vehicle_information text,
  phone_number text, billing_amount text, notes text,
  invoice_issued_on date, created_by uuid not null default auth.uid() references auth.users(id),
  person_in_charge text not null, created_at timestamptz not null default now()
);
create table public.security_card_prices (
  building_name text primary key, issue_unit_price numeric(12,2), cancellation_unit_price numeric(12,2),
  check (issue_unit_price is null or issue_unit_price >= 0),
  check (cancellation_unit_price is null or cancellation_unit_price >= 0)
);
create table public.security_card_orders (
  id uuid primary key default gen_random_uuid(),
  building_name text not null references public.security_card_prices(building_name),
  ordered_on date, tenant_name text not null,
  order_type text not null check (order_type in ('発行','抹消')),
  quantity integer not null check (quantity > 0),
  vendor_invoice text, tenant_billed_on date, notes text,
  tenant_billing_amount numeric(12,2), unit_price_at_order numeric(12,2),
  vendor_payment text, receipt_created text, receipt_collected text,
  created_by uuid not null default auth.uid() references auth.users(id),
  person_in_charge text not null, created_at timestamptz not null default now(),
  check (order_type <> '発行' or tenant_billing_amount = quantity * unit_price_at_order)
);
insert into public.security_card_prices(building_name,issue_unit_price,cancellation_unit_price) values
 ('四ツ橋',2000,5000),('日本橋',1500,0),('新大阪',2000,8500),('肥後橋',2000,0),
 ('東館',2000,6000),('堺東',1400,null),('本町',1800,10000),('神戸',1000,null),
 ('梅田',1800,8500),('堺筋本町',2000,13000),('本町プラザビル',null,null),
 ('広島',2000,2000),('京橋',1500,1500),('若草',2000,2000),('稲荷町',2000,2000),
 ('福岡',1600,800),('仙台',1500,null),('小石川',2000,5000),('郡山北',1500,5000),
 ('郡山南',1800,null),('福島',1695,null),('仙台東',null,null),('小山',1000,null),
 ('西新宿',1500,3500),('赤坂',2000,null),('横浜',null,2000);
alter table public.garage_certificate_records enable row level security;
alter table public.security_card_prices enable row level security;
alter table public.security_card_orders enable row level security;
grant select, insert, update on public.garage_certificate_records to authenticated;
grant select on public.security_card_prices to authenticated;
grant select, insert on public.security_card_orders to authenticated;
create policy garage_admin_read on public.garage_certificate_records for select to authenticated using (public.current_account_is_admin());
create policy garage_admin_insert on public.garage_certificate_records for insert to authenticated with check (public.current_account_is_admin() and created_by = auth.uid());
create policy garage_admin_update on public.garage_certificate_records for update to authenticated using (public.current_account_is_admin()) with check (public.current_account_is_admin());
create policy card_price_admin_read on public.security_card_prices for select to authenticated using (public.current_account_is_admin());
create policy card_order_admin_read on public.security_card_orders for select to authenticated using (public.current_account_is_admin());
create policy card_order_admin_insert on public.security_card_orders for insert to authenticated with check (public.current_account_is_admin() and created_by = auth.uid());
