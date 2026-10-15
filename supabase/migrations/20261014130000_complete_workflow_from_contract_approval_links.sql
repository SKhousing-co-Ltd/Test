-- The rent-roll approval linker is a one-time migration aid for approvals that
-- predate the contract workflow operation. Linking therefore completes and
-- processes the workflow item in the same transaction as the normal workflow UI.

create or replace function public.list_contract_approval_link_candidates(p_lease_contract_id uuid)
returns table (
  appsuite_record_id uuid, app_id varchar, data_id varchar, ringi_number varchar,
  workflow_type varchar, approval_status varchar, property_name text, tenant_name text,
  approval_floor_label text, source_updated_at timestamptz, floor_match boolean,
  is_linked boolean, link_locked boolean
)
language plpgsql security definer set search_path = public
as $$
begin
  if not public.current_account_is_active() then raise exception 'Active account required'; end if;
  if not exists (select 1 from public.lease_contract where lease_contract_id = p_lease_contract_id) then
    raise exception 'Lease contract not found';
  end if;

  return query
  with contract_buildings as (
    select distinct asset.asset_id, asset.asset_name
      from public.lease_contract_unit contract_unit
      join public.unit_master unit on unit.unit_id = contract_unit.unit_id
      join public.asset_master asset on asset.asset_id = unit.property_id
     where contract_unit.lease_contract_id = p_lease_contract_id
  ), contract_floors as (
    select distinct public.normalize_contract_approval_floor(unit.floor_label) as floor_key
      from public.lease_contract_unit contract_unit
      join public.unit_master unit on unit.unit_id = contract_unit.unit_id
     where contract_unit.lease_contract_id = p_lease_contract_id
       and public.normalize_contract_approval_floor(unit.floor_label) is not null
  ), candidates as (
    select record.*,
           public.appsuite_contract_floor(record.raw_payload) as approval_floor,
           exists (
             select 1 from public.workflow_contract_link link
              where link.appsuite_record_id = record.appsuite_record_id
                and link.lease_contract_id = p_lease_contract_id
           ) as linked,
           exists (
             select 1 from public.workflow_contract_link link
              where link.appsuite_record_id = record.appsuite_record_id
                and link.lease_contract_id = p_lease_contract_id
                and not (
                  link.link_role = 'related' and link.link_source = 'manual'
                  and link.target_scope = 'contract' and link.lease_contract_unit_id is null
                )
           ) as locked
      from public.appsuite_record record
      join public.appsuite_application application on application.app_id = record.app_id
     where application.business_domain = 'lease_contract'
       and record.is_present
       and record.approval_status in ('社長決裁済', '完了')
       and (
         record.workflow_processed_at is null
         or exists (
           select 1 from public.workflow_contract_link current_link
            where current_link.appsuite_record_id = record.appsuite_record_id
              and current_link.lease_contract_id = p_lease_contract_id
         )
       )
       and exists (
         select 1 from contract_buildings building
          where public.normalize_contract_workflow_key(building.asset_name)
              = public.normalize_contract_workflow_key(record.property_name)
       )
  )
  select candidate.appsuite_record_id, candidate.app_id::varchar, candidate.data_id::varchar,
         candidate.ringi_number::varchar, candidate.workflow_type::varchar,
         candidate.approval_status::varchar, candidate.property_name::text,
         candidate.tenant_name::text, candidate.approval_floor::text,
         candidate.source_updated_at::timestamptz,
         case when public.normalize_contract_approval_floor(candidate.approval_floor) is null then null
              else exists (select 1 from contract_floors floor where floor.floor_key = public.normalize_contract_approval_floor(candidate.approval_floor)) end,
         candidate.linked, candidate.locked
    from candidates candidate
   order by candidate.linked desc,
            (case when public.normalize_contract_approval_floor(candidate.approval_floor) is not null
                       and exists (select 1 from contract_floors floor where floor.floor_key = public.normalize_contract_approval_floor(candidate.approval_floor))
                  then 1 else 0 end) desc,
            candidate.source_updated_at desc nulls last, candidate.created_at desc;
end;
$$;

create or replace function public.set_contract_approval_links(
  p_lease_contract_id uuid,
  p_appsuite_record_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  candidate_id uuid;
  selected_ids uuid[] := coalesce(p_appsuite_record_ids, array[]::uuid[]);
begin
  if not public.current_account_is_active() or public.current_account_role() not in ('admin', 'manager', 'staff') then
    raise exception 'Active operator account required';
  end if;
  if exists (
    select 1 from unnest(selected_ids) selected_id
     where not exists (
       select 1 from public.list_contract_approval_link_candidates(p_lease_contract_id) candidate
        where candidate.appsuite_record_id = selected_id
     )
  ) then raise exception 'Approval candidate does not belong to the contract building'; end if;

  delete from public.workflow_contract_link link
   where link.lease_contract_id = p_lease_contract_id
     and link.link_role = 'related' and link.link_source = 'manual'
     and link.target_scope = 'contract' and link.lease_contract_unit_id is null
     and not (link.appsuite_record_id = any(selected_ids))
     and exists (
       select 1 from public.list_contract_approval_link_candidates(p_lease_contract_id) candidate
        where candidate.appsuite_record_id = link.appsuite_record_id
     );

  for candidate_id in select distinct unnest(selected_ids)
  loop
    if exists (
      select 1 from public.appsuite_record record
       where record.appsuite_record_id = candidate_id
         and record.workflow_processed_at is null
    ) then
      perform public.link_and_complete_contract_workflow(
        candidate_id, p_lease_contract_id, array[]::uuid[], null
      );
    end if;
  end loop;
end;
$$;

revoke all on function public.list_contract_approval_link_candidates(uuid) from public, anon;
revoke all on function public.set_contract_approval_links(uuid, uuid[]) from public, anon;
grant execute on function public.list_contract_approval_link_candidates(uuid) to authenticated;
grant execute on function public.set_contract_approval_links(uuid, uuid[]) to authenticated;

comment on function public.set_contract_approval_links(uuid, uuid[]) is
  '運用開始前稟議を契約へ紐づけ、通常の契約業務フローと同様に完了・処理済みへ更新する。';
