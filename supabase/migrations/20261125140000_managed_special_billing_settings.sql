-- Special billing lines are configured with their source management tables.
create table public.managed_special_billing_setting (
  kind text primary key check (kind in ('deposit', 'garage_certificate', 'security_card')),
  invoice_item_1 text not null default 'その他' check (length(btrim(invoice_item_1)) > 0),
  invoice_item_2 text not null check (length(btrim(invoice_item_2)) > 0),
  account_code text not null check (account_code ~ '^[0-9]+$'),
  subaccount_code text not null default '' check (subaccount_code = '' or subaccount_code ~ '^[0-9]+$'),
  updated_at timestamptz not null default now()
);
insert into public.managed_special_billing_setting(kind, invoice_item_1, invoice_item_2, account_code, subaccount_code) values
  ('deposit', 'その他', '敷金', '3600', ''),
  ('garage_certificate', 'その他', '車庫証明発行手数料', '4100', '1'),
  ('security_card', 'その他', 'セキュリティカード発行手数料', '4100', '1');
alter table public.managed_special_billing_setting enable row level security;
grant select, update on public.managed_special_billing_setting to authenticated;
create policy managed_special_billing_admin_read on public.managed_special_billing_setting
  for select to authenticated using (public.current_account_is_admin());
create policy managed_special_billing_admin_update on public.managed_special_billing_setting
  for update to authenticated using (public.current_account_is_admin()) with check (public.current_account_is_admin());

-- These placeholders are now owned by their management tables. Remove only the
-- explicitly named legacy rows and their billing-code allocation.
delete from public.billing_code_line_item_allocation
where asset_billing_line_item_id in (
  select asset_billing_line_item_id from public.asset_billing_line_item
  where line_item_name in ('その他（敷金）', 'その他（車庫証明）')
);
delete from public.asset_billing_line_item
where line_item_name in ('その他（敷金）', 'その他（車庫証明）');
