-- This flag describes the charge type independently of revenue posting.
alter table public.billing_charge_type rename column is_fixed_revenue to is_fixed_charge;
