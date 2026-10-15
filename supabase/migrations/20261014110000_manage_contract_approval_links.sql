-- Allow rent-roll operators to associate one contract with multiple approved
-- AppSuite lease workflows. Candidates are limited to the contract's building
-- and ranked by normalized floor information when the source form provides it.

create or replace function public.normalize_contract_approval_floor(value text)
returns text
language plpgsql
immutable
parallel safe
set search_path = public
as $$
declare
  normalized text := upper(translate(btrim(coalesce(value, '')), '０１２３４５６７８９ＢＦｂｆ', '0123456789BFBF'));
  matched text[];
begin
  if normalized = '' then return null; end if;
  normalized := regexp_replace(normalized, '[[:space:]　]+', '', 'g');
  matched := regexp_match(normalized, '地下([0-9]+)(階|F)?');
  if matched is not null then return 'B' || matched[1] || 'F'; end if;
  matched := regexp_match(normalized, 'B([0-9]+)(階|F)?');
  if matched is not null then return 'B' || matched[1] || 'F'; end if;
  matched := regexp_match(normalized, '([0-9]+)(階|F)');
  if matched is not null then return matched[1] || 'F'; end if;
  return regexp_replace(normalized, '[^0-9A-Z一-龠ぁ-んァ-ヶ]', '', 'g');
end;
$$;

create or replace function public.appsuite_contract_floor(payload jsonb)
returns text
language sql
immutable
parallel safe
set search_path = public
as $$
  select coalesce(
    public.appsuite_text_value(payload, '階'),
    public.appsuite_text_value(payload, '階数'),
    public.appsuite_text_value(payload, 'フロア'),
    public.appsuite_text_value(payload, '入居階'),
    public.appsuite_text_value(payload, '対象階'),
    public.appsuite_text_value(payload, 'floor'),
    public.appsuite_text_value(payload, 'floor_label')
  )
$$;

create or replace function public.list_contract_approval_link_candidates(p_lease_contract_id uuid)
returns table (
  appsuite_record_id uuid,
  app_id varchar,
  data_id varchar,
  ringi_number varchar,
  workflow_type varchar,
  approval_status varchar,
  property_name text,
  tenant_name text,
  approval_floor_label text,
  source_updated_at timestamptz,
  floor_match boolean,
  is_linked boolean,
  link_locked boolean
)
language plpgsql
security definer
set search_path = public
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
              else exists (
                select 1 from contract_floors floor
                 where floor.floor_key = public.normalize_contract_approval_floor(candidate.approval_floor)
              ) end as floor_match,
         candidate.linked, candidate.locked
    from candidates candidate
   order by candidate.linked desc,
            (case when public.normalize_contract_approval_floor(candidate.approval_floor) is not null
                       and exists (select 1 from contract_floors floor where floor.floor_key = public.normalize_contract_approval_floor(candidate.approval_floor))
                  then 1 else 0 end) desc,
            candidate.source_updated_at desc nulls last,
            candidate.created_at desc;
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
     and link.link_role = 'related'
     and link.link_source = 'manual'
     and link.target_scope = 'contract'
     and link.lease_contract_unit_id is null
     and not (link.appsuite_record_id = any(selected_ids))
     and exists (
       select 1 from public.list_contract_approval_link_candidates(p_lease_contract_id) candidate
        where candidate.appsuite_record_id = link.appsuite_record_id
     );

  for candidate_id in select distinct unnest(selected_ids)
  loop
    if not exists (
      select 1 from public.workflow_contract_link link
       where link.appsuite_record_id = candidate_id
         and link.lease_contract_id = p_lease_contract_id
    ) then
      perform public.confirm_workflow_contract_link(
        candidate_id, p_lease_contract_id, 'related', null, null, 'contract'
      );
    end if;
  end loop;
end;
$$;

revoke all on function public.normalize_contract_approval_floor(text) from public, anon;
revoke all on function public.appsuite_contract_floor(jsonb) from public, anon;
revoke all on function public.list_contract_approval_link_candidates(uuid) from public, anon;
revoke all on function public.set_contract_approval_links(uuid, uuid[]) from public, anon;
grant execute on function public.list_contract_approval_link_candidates(uuid) to authenticated;
grant execute on function public.set_contract_approval_links(uuid, uuid[]) to authenticated;

comment on function public.list_contract_approval_link_candidates(uuid) is
  '契約と同一ビルの決裁済み賃貸借稟議を返し、稟議の階情報が取得できる場合は契約区画との階一致を判定する。';
comment on function public.set_contract_approval_links(uuid, uuid[]) is
  '契約編集画面で管理する関連稟議リンクを置き換える。既存のprimary・区画単位リンクは削除しない。';
