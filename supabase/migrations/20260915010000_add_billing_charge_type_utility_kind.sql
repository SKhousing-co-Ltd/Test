alter table public.billing_charge_type add column if not exists utility_kind varchar(20);
alter table public.billing_charge_type drop constraint if exists billing_charge_type_utility_kind_check;
alter table public.billing_charge_type add constraint billing_charge_type_utility_kind_check check (utility_kind is null or utility_kind in ('electricity', 'water', 'gas'));
