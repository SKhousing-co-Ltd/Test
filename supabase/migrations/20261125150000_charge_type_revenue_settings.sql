alter table public.billing_charge_type
  add column is_fixed_revenue boolean not null default false,
  add column revenue_account_code text,
  add column revenue_subaccount_code text;
update public.billing_charge_type
set is_fixed_revenue = charge_type_name in ('賃料', '共益費', '駐車料'),
    revenue_account_code = case when charge_type_name = 'その他' then null else '4100' end,
    revenue_subaccount_code = case when charge_type_name = 'その他' then null else '1' end;
alter table public.billing_charge_type
  add constraint billing_charge_type_revenue_codes_check check (
    (charge_type_name = 'その他' and revenue_account_code is null and revenue_subaccount_code is null)
    or (charge_type_name <> 'その他' and revenue_account_code is not null and revenue_account_code ~ '^[0-9]+$' and (revenue_subaccount_code is null or revenue_subaccount_code ~ '^[0-9]+$'))
  );
alter table public.billing_charge_type alter column revenue_account_code set default '4100';
alter table public.billing_charge_type alter column revenue_subaccount_code set default '1';
