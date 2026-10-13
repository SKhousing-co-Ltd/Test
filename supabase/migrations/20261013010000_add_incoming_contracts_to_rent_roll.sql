-- Rent roll keeps the effective contract as the primary row and exposes future
-- contracts as supplemental information. Historical views intentionally hide them.
create or replace function public.rent_roll_list_with_terms_at_date(
  p_property_id uuid,
  p_as_of_date date
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(
    source_row || jsonb_build_object(
      'lease_term_type', contract.lease_term_type,
      'renewal_due_date', contract.renewal_due_date,
      'actual_end_date', contract.actual_end_date,
      'renewed_from_contract_id', contract.renewed_from_contract_id,
      'incoming_contracts', case when p_as_of_date < current_date then '[]'::jsonb else coalesce(incoming.items, '[]'::jsonb) end
    ) order by source_row ->> 'floor_label', source_row ->> 'unit_code'
  ), '[]'::jsonb)
  from jsonb_array_elements(public.rent_roll_list_at_date(p_property_id, p_as_of_date)) source_row
  left join public.lease_contract contract
    on contract.lease_contract_id = nullif(source_row ->> 'lease_contract_id', '')::uuid
  left join lateral (
    select jsonb_agg(jsonb_build_object(
      'lease_contract_id', future_contract.lease_contract_id,
      'lease_contract_unit_id', future_unit.lease_contract_unit_id,
      'contract_start_date', future_contract.contract_start_date,
      'tenant_name', future_tenant.tenant_name,
      'monthly_total_amount', coalesce(future_unit.monthly_rent_amount, 0) + coalesce(future_unit.monthly_common_charge_amount, 0)
    ) order by future_contract.contract_start_date, future_contract.created_at) as items
    from public.lease_contract_unit future_unit
    join public.lease_contract future_contract on future_contract.lease_contract_id = future_unit.lease_contract_id
    join public.tenant_master future_tenant on future_tenant.tenant_id = future_contract.tenant_id
    where future_unit.unit_id = nullif(source_row ->> 'unit_id', '')::uuid
      and future_contract.contract_status in ('scheduled', 'draft')
      and future_contract.contract_start_date is not null
      and future_contract.contract_start_date > p_as_of_date
  ) incoming on true;
$$;
revoke all on function public.rent_roll_list_with_terms_at_date(uuid, date) from public, anon;
grant execute on function public.rent_roll_list_with_terms_at_date(uuid, date) to authenticated;
