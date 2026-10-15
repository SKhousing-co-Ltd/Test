create or replace function public.normalize_contract_property_match_key(value text)
returns text language sql immutable parallel safe set search_path = public as $$
  select replace(
    replace(public.normalize_contract_workflow_key(value), '三共ビル郡山南館', '三共郡山ビル南館'),
    '三共ビル郡山北館', '三共郡山ビル北館'
  );
$$;

create or replace function public.contract_property_names_match(left_name text, right_name text)
returns boolean language sql immutable parallel safe set search_path = public as $$
  select nullif(public.normalize_contract_property_match_key(left_name), '') is not null
     and public.normalize_contract_property_match_key(left_name) = public.normalize_contract_property_match_key(right_name);
$$;

create or replace function public.list_contract_approval_link_candidates(p_lease_contract_id uuid)
returns table (
  appsuite_record_id uuid, app_id varchar, data_id varchar, ringi_number varchar,
  workflow_type varchar, approval_kind text, approval_status varchar,
  property_name text, tenant_name text, approval_floor_label text,
  approval_unit_label text, approval_space_type text,
  source_updated_at timestamptz, floor_match boolean, is_linked boolean, link_locked boolean
)
language plpgsql security definer set search_path = public as $$
begin
  if not public.current_account_is_active() then raise exception 'Active account required'; end if;
  if not exists (select 1 from public.lease_contract where lease_contract_id = p_lease_contract_id) then raise exception 'Lease contract not found'; end if;

  return query
  with contract_context as (
    select distinct contract.tenant_id, tenant.tenant_name
      from public.lease_contract contract join public.tenant_master tenant on tenant.tenant_id = contract.tenant_id
     where contract.lease_contract_id = p_lease_contract_id
  ), contract_buildings as (
    select distinct asset.asset_id, asset.asset_name, asset.short_name
      from public.lease_contract_unit contract_unit
      join public.unit_master unit on unit.unit_id = contract_unit.unit_id
      join public.asset_master asset on asset.asset_id = unit.property_id
     where contract_unit.lease_contract_id = p_lease_contract_id
  ), tenant_building_counts as (
    select contract.tenant_id, count(distinct unit.property_id) as building_count
      from public.lease_contract contract
      join public.lease_contract_unit contract_unit on contract_unit.lease_contract_id = contract.lease_contract_id
      join public.unit_master unit on unit.unit_id = contract_unit.unit_id group by contract.tenant_id
  ), contract_floors as (
    select distinct public.normalize_contract_approval_floor(unit.floor_label) as floor_key
      from public.lease_contract_unit contract_unit join public.unit_master unit on unit.unit_id = contract_unit.unit_id
     where contract_unit.lease_contract_id = p_lease_contract_id and public.normalize_contract_approval_floor(unit.floor_label) is not null
  ), candidate_source as (
    select record.*, application.processing_type,
           coalesce(nullif(record.property_name, ''), public.appsuite_contract_property(record.raw_payload)) as effective_property,
           public.appsuite_contract_floor(record.raw_payload) as approval_floor,
           public.appsuite_contract_unit_label(record.raw_payload) as approval_unit,
           public.appsuite_contract_space_type(record.raw_payload) as approval_space,
           exists (select 1 from public.workflow_contract_link link where link.appsuite_record_id = record.appsuite_record_id and link.lease_contract_id = p_lease_contract_id) as linked,
           exists (select 1 from public.workflow_contract_link link where link.appsuite_record_id = record.appsuite_record_id and link.lease_contract_id = p_lease_contract_id and not (link.link_role = 'related' and link.link_source = 'manual' and link.target_scope = 'contract' and link.lease_contract_unit_id is null)) as locked
      from public.appsuite_record record join public.appsuite_application application on application.app_id = record.app_id
     where application.business_domain = 'lease_contract'
       and application.processing_type in ('contract_create', 'contract_update', 'contract_terminate')
       and record.is_present and record.approval_status in ('社長決裁済', '完了')
       and (record.workflow_processed_at is null or exists (select 1 from public.workflow_contract_link current_link where current_link.appsuite_record_id = record.appsuite_record_id and current_link.lease_contract_id = p_lease_contract_id))
  ), candidates as (
    select source.* from candidate_source source
     where exists (
       select 1 from contract_buildings building
        where public.contract_property_names_match(building.asset_name, source.effective_property)
           or public.contract_property_names_match(building.short_name, source.effective_property)
     ) or (nullif(source.effective_property, '') is null and exists (
       select 1 from contract_context context join tenant_building_counts counts on counts.tenant_id = context.tenant_id and counts.building_count = 1
        where public.normalize_contract_workflow_key(context.tenant_name) = public.normalize_contract_workflow_key(source.tenant_name)
     ))
  )
  select candidate.appsuite_record_id, candidate.app_id::varchar, candidate.data_id::varchar, candidate.ringi_number::varchar,
         candidate.workflow_type::varchar,
         (case candidate.processing_type when 'contract_create' then '新規契約稟議' when 'contract_update' then '契約内容変更稟議' when 'contract_terminate' then '契約解約稟議' else candidate.workflow_type end)::text,
         candidate.approval_status::varchar, candidate.effective_property::text, candidate.tenant_name::text,
         candidate.approval_floor::text, candidate.approval_unit::text, candidate.approval_space::text,
         candidate.source_updated_at::timestamptz,
         case when public.normalize_contract_approval_floor(candidate.approval_floor) is null then null else exists (select 1 from contract_floors floor where floor.floor_key = public.normalize_contract_approval_floor(candidate.approval_floor)) end,
         candidate.linked, candidate.locked
    from candidates candidate
   order by candidate.linked desc,
            (case when public.normalize_contract_approval_floor(candidate.approval_floor) is not null and exists (select 1 from contract_floors floor where floor.floor_key = public.normalize_contract_approval_floor(candidate.approval_floor)) then 1 else 0 end) desc,
            candidate.source_updated_at desc nulls last, candidate.created_at desc;
end;
$$;

revoke all on function public.normalize_contract_property_match_key(text), public.contract_property_names_match(text, text) from public, anon;
grant execute on function public.normalize_contract_property_match_key(text), public.contract_property_names_match(text, text) to authenticated;
revoke all on function public.list_contract_approval_link_candidates(uuid) from public, anon;
grant execute on function public.list_contract_approval_link_candidates(uuid) to authenticated;
comment on function public.normalize_contract_property_match_key(text) is '契約稟議の物件照合用。三共郡山ビル南北館と三共ビル郡山南北館の表記揺れを統一する。';
