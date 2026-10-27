-- A single physical contract unit may be split into multiple utility billing units.
alter table public.lease_contract_billing_unit_member
  drop constraint if exists lease_contract_billing_unit_member_lease_contract_unit_id_key;
