create or replace function public.appsuite_contract_property(payload jsonb)
returns text language sql immutable set search_path = public as $$
  select coalesce(public.appsuite_text_value(payload, '物件名'), public.appsuite_text_value(payload, '物件名称'), public.appsuite_text_value(payload, '建物名称'), public.appsuite_text_value(payload, 'ビル名称'), public.appsuite_text_value(payload, 'property_name'));
$$;

create or replace function public.appsuite_contract_unit_label(payload jsonb)
returns text language sql immutable set search_path = public as $$
  select coalesce(public.appsuite_text_value(payload, '区画'), public.appsuite_text_value(payload, '区画名'), public.appsuite_text_value(payload, '号室'), public.appsuite_text_value(payload, '部屋番号'), public.appsuite_text_value(payload, 'unit_code'));
$$;

create or replace function public.appsuite_contract_space_type(payload jsonb)
returns text language sql immutable set search_path = public as $$
  select coalesce(public.appsuite_text_value(payload, '貸室・駐車場区分'), public.appsuite_text_value(payload, '契約区分'), public.appsuite_text_value(payload, '区分'), public.appsuite_text_value(payload, '商品'), public.appsuite_text_value(payload, 'unit_type'));
$$;

drop function if exists public.set_contract_approval_links(uuid, uuid[]);
drop function if exists public.list_contract_approval_link_candidates(uuid);
create function public.list_contract_approval_link_candidates(p_lease_contract_id uuid)
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
      from public.lease_contract contract
      join public.tenant_master tenant on tenant.tenant_id = contract.tenant_id
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
      join public.unit_master unit on unit.unit_id = contract_unit.unit_id
     group by contract.tenant_id
  ), contract_floors as (
    select distinct public.normalize_contract_approval_floor(unit.floor_label) as floor_key
      from public.lease_contract_unit contract_unit
      join public.unit_master unit on unit.unit_id = contract_unit.unit_id
     where contract_unit.lease_contract_id = p_lease_contract_id
       and public.normalize_contract_approval_floor(unit.floor_label) is not null
  ), candidate_source as (
    select record.*, application.processing_type,
           coalesce(nullif(record.property_name, ''), public.appsuite_contract_property(record.raw_payload)) as effective_property,
           public.appsuite_contract_floor(record.raw_payload) as approval_floor,
           public.appsuite_contract_unit_label(record.raw_payload) as approval_unit,
           public.appsuite_contract_space_type(record.raw_payload) as approval_space,
           exists (select 1 from public.workflow_contract_link link where link.appsuite_record_id = record.appsuite_record_id and link.lease_contract_id = p_lease_contract_id) as linked,
           exists (select 1 from public.workflow_contract_link link where link.appsuite_record_id = record.appsuite_record_id and link.lease_contract_id = p_lease_contract_id and not (link.link_role = 'related' and link.link_source = 'manual' and link.target_scope = 'contract' and link.lease_contract_unit_id is null)) as locked
      from public.appsuite_record record
      join public.appsuite_application application on application.app_id = record.app_id
     where application.business_domain = 'lease_contract'
       and application.processing_type in ('contract_create', 'contract_update', 'contract_terminate')
       and record.is_present and record.approval_status in ('社長決裁済', '完了')
       and (record.workflow_processed_at is null or exists (select 1 from public.workflow_contract_link current_link where current_link.appsuite_record_id = record.appsuite_record_id and current_link.lease_contract_id = p_lease_contract_id))
  ), candidates as (
    select source.* from candidate_source source
     where exists (
       select 1 from contract_buildings building
        where public.normalize_contract_workflow_key(building.asset_name) = public.normalize_contract_workflow_key(source.effective_property)
           or (nullif(building.short_name, '') is not null and public.normalize_contract_workflow_key(building.short_name) = public.normalize_contract_workflow_key(source.effective_property))
     ) or (nullif(source.effective_property, '') is null and exists (
       select 1 from contract_context context
       join tenant_building_counts counts on counts.tenant_id = context.tenant_id and counts.building_count = 1
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

create function public.set_contract_approval_links(p_lease_contract_id uuid, p_appsuite_record_ids uuid[])
returns void language plpgsql security definer set search_path = public as $$
declare
  candidate_id uuid;
  selected_ids uuid[] := coalesce(p_appsuite_record_ids, array[]::uuid[]);
begin
  if not public.current_account_is_active() or public.current_account_role() not in ('admin', 'manager', 'staff') then raise exception 'Active operator account required'; end if;
  if exists (select 1 from unnest(selected_ids) selected_id where not exists (
    select 1 from public.list_contract_approval_link_candidates(p_lease_contract_id) candidate where candidate.appsuite_record_id = selected_id
  )) then raise exception 'Approval candidate does not belong to the contract building'; end if;

  delete from public.workflow_contract_link link
   where link.lease_contract_id = p_lease_contract_id
     and link.link_role = 'related' and link.link_source = 'manual'
     and link.target_scope = 'contract' and link.lease_contract_unit_id is null
     and not (link.appsuite_record_id = any(selected_ids))
     and exists (select 1 from public.list_contract_approval_link_candidates(p_lease_contract_id) candidate where candidate.appsuite_record_id = link.appsuite_record_id);

  for candidate_id in select distinct unnest(selected_ids) loop
    if exists (select 1 from public.appsuite_record record where record.appsuite_record_id = candidate_id and record.workflow_processed_at is null) then
      perform public.link_and_complete_contract_workflow(candidate_id, p_lease_contract_id, array[]::uuid[], null);
    end if;
  end loop;
end;
$$;

revoke all on function public.appsuite_contract_property(jsonb), public.appsuite_contract_unit_label(jsonb), public.appsuite_contract_space_type(jsonb) from public, anon;
grant execute on function public.appsuite_contract_property(jsonb), public.appsuite_contract_unit_label(jsonb), public.appsuite_contract_space_type(jsonb) to authenticated;
revoke all on function public.list_contract_approval_link_candidates(uuid) from public, anon;
grant execute on function public.list_contract_approval_link_candidates(uuid) to authenticated;
revoke all on function public.set_contract_approval_links(uuid, uuid[]) from public, anon;
grant execute on function public.set_contract_approval_links(uuid, uuid[]) to authenticated;
comment on function public.list_contract_approval_link_candidates(uuid) is '契約業務フローと同じ未処理賃貸借稟議から、正式名・略称・原文物件名または一意なテナント契約で同一ビルと判断できる候補を返す。';
