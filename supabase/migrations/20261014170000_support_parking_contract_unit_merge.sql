create or replace function public.list_contract_unit_merge_candidates(p_target_lease_contract_id uuid)
returns table (
  lease_contract_unit_id uuid, source_lease_contract_id uuid, unit_code text,
  unit_name text, floor_label text, unit_type text, lease_start_date date,
  lease_end_date date, contract_start_date date, contract_end_date date
)
language plpgsql security definer set search_path = public as $$
begin
  if not public.current_account_is_active() then raise exception 'Active account required'; end if;
  if not exists (select 1 from public.lease_contract where lease_contract_id = p_target_lease_contract_id) then raise exception 'Lease contract not found'; end if;

  return query
  with target as (
    select contract.tenant_id, unit.property_id, unit.unit_type
      from public.lease_contract contract
      join public.lease_contract_unit contract_unit on contract_unit.lease_contract_id = contract.lease_contract_id
      join public.unit_master unit on unit.unit_id = contract_unit.unit_id
     where contract.lease_contract_id = p_target_lease_contract_id
     group by contract.tenant_id, unit.property_id, unit.unit_type
  )
  select contract_unit.lease_contract_unit_id, contract.lease_contract_id,
         unit.unit_code::text, unit.unit_name::text, unit.floor_label::text, unit.unit_type::text,
         contract_unit.lease_start_date, contract_unit.lease_end_date,
         contract.contract_start_date, contract.contract_end_date
    from public.lease_contract contract
    join public.lease_contract_unit contract_unit on contract_unit.lease_contract_id = contract.lease_contract_id
    join public.unit_master unit on unit.unit_id = contract_unit.unit_id
    join target on target.tenant_id = contract.tenant_id and target.property_id = unit.property_id
      and (
        (target.unit_type = 'parking' and unit.unit_type = 'parking')
        or (target.unit_type = 'bicycle_parking' and unit.unit_type = 'bicycle_parking')
        or (target.unit_type not in ('parking', 'bicycle_parking') and unit.unit_type not in ('parking', 'bicycle_parking'))
      )
   where contract.lease_contract_id <> p_target_lease_contract_id
     and contract.contract_status in ('draft', 'scheduled', 'active')
     and not exists (
       select 1 from public.lease_contract_unit existing
        where existing.lease_contract_id = p_target_lease_contract_id and existing.unit_id = contract_unit.unit_id
     )
   order by unit.floor_label nulls last, unit.unit_code;
end;
$$;

revoke all on function public.list_contract_unit_merge_candidates(uuid) from public, anon;
grant execute on function public.list_contract_unit_merge_candidates(uuid) to authenticated;
comment on function public.list_contract_unit_merge_candidates(uuid) is '同じテナント・同じ物件で別契約になっている同種区画を返す。駐車場は駐車場同士に限定して増車候補とする。';
