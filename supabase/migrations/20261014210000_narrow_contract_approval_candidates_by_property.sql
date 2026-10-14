create index if not exists ix_appsuite_record_contract_candidate_property
  on public.appsuite_record (
    app_id,
    public.normalize_contract_property_match_key(property_name),
    source_updated_at desc
  )
  where is_present
    and workflow_processed_at is null
    and approval_status in ('社長決裁済', '完了')
    and nullif(property_name, '') is not null;

create index if not exists ix_appsuite_record_contract_candidate_payload_property
  on public.appsuite_record (
    app_id,
    public.normalize_contract_property_match_key(public.appsuite_contract_property(raw_payload)),
    source_updated_at desc
  )
  where is_present
    and workflow_processed_at is null
    and approval_status in ('社長決裁済', '完了')
    and nullif(property_name, '') is null;

create index if not exists ix_appsuite_record_contract_candidate_tenant
  on public.appsuite_record (
    app_id,
    public.normalize_contract_workflow_key(tenant_name),
    source_updated_at desc
  )
  where is_present
    and workflow_processed_at is null
    and approval_status in ('社長決裁済', '完了')
    and nullif(property_name, '') is null;

create or replace function public.list_contract_approval_link_candidates(p_lease_contract_id uuid)
returns table (
  appsuite_record_id uuid, app_id varchar, data_id varchar, ringi_number varchar,
  workflow_type varchar, approval_kind text, approval_status varchar,
  property_name text, tenant_name text, approval_floor_label text,
  approval_unit_label text, approval_space_type text,
  source_updated_at timestamptz, floor_match boolean, is_linked boolean, link_locked boolean
)
language plpgsql security definer set search_path = public as $$
declare
  v_tenant_id uuid;
  v_tenant_name_key text;
  v_tenant_building_count integer;
  v_application_ids varchar[];
  v_building_keys text[];
  v_floor_keys text[];
begin
  if not public.current_account_is_active() then raise exception 'Active account required'; end if;

  select contract.tenant_id, public.normalize_contract_workflow_key(tenant.tenant_name)
    into v_tenant_id, v_tenant_name_key
    from public.lease_contract contract
    join public.tenant_master tenant on tenant.tenant_id = contract.tenant_id
   where contract.lease_contract_id = p_lease_contract_id;
  if not found then raise exception 'Lease contract not found'; end if;

  select array_agg(application.app_id::varchar)
    into v_application_ids
    from public.appsuite_application application
   where application.business_domain = 'lease_contract'
     and application.processing_type in ('contract_create', 'contract_update', 'contract_terminate');

  select array_agg(distinct public.normalize_contract_property_match_key(name))
           filter (where nullif(public.normalize_contract_property_match_key(name), '') is not null)
    into v_building_keys
    from (
      select asset.asset_name::text as name
        from public.lease_contract_unit contract_unit
        join public.unit_master unit on unit.unit_id = contract_unit.unit_id
        join public.asset_master asset on asset.asset_id = unit.property_id
       where contract_unit.lease_contract_id = p_lease_contract_id
      union all
      select asset.short_name::text
        from public.lease_contract_unit contract_unit
        join public.unit_master unit on unit.unit_id = contract_unit.unit_id
        join public.asset_master asset on asset.asset_id = unit.property_id
       where contract_unit.lease_contract_id = p_lease_contract_id
    ) names;

  select array_agg(distinct public.normalize_contract_approval_floor(unit.floor_label))
           filter (where public.normalize_contract_approval_floor(unit.floor_label) is not null)
    into v_floor_keys
    from public.lease_contract_unit contract_unit
    join public.unit_master unit on unit.unit_id = contract_unit.unit_id
   where contract_unit.lease_contract_id = p_lease_contract_id;

  select count(distinct unit.property_id)::integer into v_tenant_building_count
    from public.lease_contract contract
    join public.lease_contract_unit contract_unit on contract_unit.lease_contract_id = contract.lease_contract_id
    join public.unit_master unit on unit.unit_id = contract_unit.unit_id
   where contract.tenant_id = v_tenant_id;

  return query
  with candidate_ids as materialized (
    select record.appsuite_record_id
      from public.appsuite_record record
     where record.app_id = any(coalesce(v_application_ids, array[]::varchar[]))
       and record.is_present
       and record.workflow_processed_at is null
       and record.approval_status in ('社長決裁済', '完了')
       and nullif(record.property_name, '') is not null
       and public.normalize_contract_property_match_key(record.property_name)
           = any(coalesce(v_building_keys, array[]::text[]))
    union
    select record.appsuite_record_id
      from public.appsuite_record record
     where record.app_id = any(coalesce(v_application_ids, array[]::varchar[]))
       and record.is_present
       and record.workflow_processed_at is null
       and record.approval_status in ('社長決裁済', '完了')
       and nullif(record.property_name, '') is null
       and (
         public.normalize_contract_property_match_key(public.appsuite_contract_property(record.raw_payload))
           = any(coalesce(v_building_keys, array[]::text[]))
         or (
           v_tenant_building_count = 1
           and public.normalize_contract_workflow_key(record.tenant_name) = v_tenant_name_key
         )
       )
    union
    select link.appsuite_record_id
      from public.workflow_contract_link link
     where link.lease_contract_id = p_lease_contract_id
  ), candidate_source as materialized (
    select record.*, application.processing_type,
           coalesce(nullif(record.property_name, ''), public.appsuite_contract_property(record.raw_payload)) as effective_property,
           public.appsuite_contract_floor(record.raw_payload) as approval_floor,
           public.appsuite_contract_unit_label(record.raw_payload) as approval_unit,
           public.appsuite_contract_space_type(record.raw_payload) as approval_space,
           coalesce(link_state.linked, false) as linked,
           coalesce(link_state.locked, false) as locked
      from candidate_ids candidate_id
      join public.appsuite_record record on record.appsuite_record_id = candidate_id.appsuite_record_id
      join public.appsuite_application application on application.app_id = record.app_id
       and application.business_domain = 'lease_contract'
       and application.processing_type in ('contract_create', 'contract_update', 'contract_terminate')
      left join lateral (
        select true as linked,
               bool_or(not (link.link_role = 'related' and link.link_source = 'manual'
                 and link.target_scope = 'contract' and link.lease_contract_unit_id is null)) as locked
          from public.workflow_contract_link link
         where link.appsuite_record_id = record.appsuite_record_id
           and link.lease_contract_id = p_lease_contract_id
        having count(*) > 0
      ) link_state on true
  )
  select candidate.appsuite_record_id, candidate.app_id::varchar, candidate.data_id::varchar,
         candidate.ringi_number::varchar, candidate.workflow_type::varchar,
         (case candidate.processing_type when 'contract_create' then '新規契約稟議'
              when 'contract_update' then '契約内容変更稟議'
              when 'contract_terminate' then '契約解約稟議' else candidate.workflow_type end)::text,
         candidate.approval_status::varchar, candidate.effective_property::text,
         candidate.tenant_name::text, candidate.approval_floor::text,
         candidate.approval_unit::text, candidate.approval_space::text,
         candidate.source_updated_at::timestamptz,
         case when public.normalize_contract_approval_floor(candidate.approval_floor) is null then null
              else public.normalize_contract_approval_floor(candidate.approval_floor)
                = any(coalesce(v_floor_keys, array[]::text[])) end,
         candidate.linked, candidate.locked
    from candidate_source candidate
   order by candidate.linked desc,
            (public.normalize_contract_approval_floor(candidate.approval_floor)
              = any(coalesce(v_floor_keys, array[]::text[]))) desc nulls last,
            candidate.source_updated_at desc nulls last, candidate.created_at desc;
end;
$$;

revoke all on function public.list_contract_approval_link_candidates(uuid) from public, anon;
grant execute on function public.list_contract_approval_link_candidates(uuid) to authenticated;
comment on function public.list_contract_approval_link_candidates(uuid) is
  '物件名・原文物件名の式インデックスで同一ビルの未処理稟議だけを先に抽出し、候補のJSON解析件数を抑えて返す。';
