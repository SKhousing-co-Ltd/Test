-- Resolve legacy AppSuite new-contract requests whose source record foreign key
-- is missing, but whose stable source_record_key still identifies one record.
create or replace function public.complete_linked_contract_request(
  p_change_request_id uuid,
  p_expected_row_version integer,
  p_verified_link_ids uuid[],
  p_confirmed_fields jsonb,
  p_note text
)
returns public.change_request
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.change_request;
  v_record public.appsuite_record;
  v_link_count integer;
  v_verified_count integer;
  v_distinct_contract_count integer;
  v_single_contract_id uuid;
  v_previous_status varchar(20);
  v_record_app_id varchar;
  v_record_data_id varchar;
  v_record_match_count integer;
begin
  if auth.uid() is null or not public.current_account_is_active()
     or public.current_account_role() not in ('admin', 'manager', 'staff') then
    raise exception '対応依頼を確定する権限がありません';
  end if;
  select * into v_request from public.change_request
   where change_request_id = p_change_request_id and row_version = p_expected_row_version
     and status in ('open', 'in_review', 'on_hold', 'resolved', 'applied')
   for update;
  if not found then raise exception '対応依頼が変更されたため再読み込みしてください'; end if;
  if v_request.request_type <> 'contract_create' then
    raise exception 'AppSuite新規契約の対応依頼ではありません';
  end if;

  if v_request.source_appsuite_record_id is not null then
    select * into v_record from public.appsuite_record
     where appsuite_record_id = v_request.source_appsuite_record_id for update;
  else
    if v_request.source_type <> 'desknets' or position(':' in coalesce(v_request.source_record_key, '')) < 2 then
      raise exception '対応依頼からAppSuite稟議を特定できません';
    end if;
    v_record_app_id := split_part(v_request.source_record_key, ':', 1);
    v_record_data_id := substring(v_request.source_record_key from length(v_record_app_id) + 2);
    if v_record_data_id = '' then
      raise exception '対応依頼からAppSuite稟議を特定できません';
    end if;
    select count(*) into v_record_match_count
      from public.appsuite_record record
     where record.app_id = v_record_app_id
       and record.data_id = v_record_data_id
       and exists (
         select 1 from public.appsuite_application application
          where application.app_id = record.app_id
            and application.processing_type = 'contract_create'
       );
    if v_record_match_count <> 1 then
      raise exception '対応依頼に一致するAppSuite新規契約を一意に特定できません';
    end if;
    select * into v_record from public.appsuite_record record
     where record.app_id = v_record_app_id
       and record.data_id = v_record_data_id
       and exists (
         select 1 from public.appsuite_application application
          where application.app_id = record.app_id
            and application.processing_type = 'contract_create'
       )
     for update;
  end if;
  if not found or not v_record.is_present or v_record.is_cancelled
     or v_record.approval_status not in ('完了', '社長決裁済') then
    raise exception '稟議が確定可能な状態ではありません';
  end if;
  if p_confirmed_fields is null or
     p_confirmed_fields ->> 'tenant' is distinct from 'true' or
     p_confirmed_fields ->> 'property' is distinct from 'true' or
     p_confirmed_fields ->> 'unit' is distinct from 'true' or
     p_confirmed_fields ->> 'period' is distinct from 'true' then
    raise exception '契約者・物件・区画・期間をすべて照合してください';
  end if;
  if nullif(btrim(p_note), '') is null then
    raise exception '照合結果と表記差などの判断理由を記録してください';
  end if;
  select count(*), count(distinct lease_contract_id), (array_agg(lease_contract_id))[1]
    into v_link_count, v_distinct_contract_count, v_single_contract_id
    from public.workflow_contract_link
   where appsuite_record_id = v_record.appsuite_record_id;
  select count(distinct link_id) into v_verified_count
    from unnest(coalesce(p_verified_link_ids, '{}'::uuid[])) as link_id;
  if v_link_count = 0 or v_verified_count <> v_link_count or exists (
    select 1 from public.workflow_contract_link link
     where link.appsuite_record_id = v_record.appsuite_record_id
       and not (link.workflow_contract_link_id = any(p_verified_link_ids))
  ) or exists (
    select 1 from unnest(coalesce(p_verified_link_ids, '{}'::uuid[])) as checked_id
     where not exists (
       select 1 from public.workflow_contract_link link
        where link.appsuite_record_id = v_record.appsuite_record_id
          and link.workflow_contract_link_id = checked_id
     )
  ) then
    raise exception '稟議の全対象契約を照合・選択してください';
  end if;
  if exists (
    select 1 from public.workflow_contract_link link
    left join public.lease_contract contract on contract.lease_contract_id = link.lease_contract_id
    left join public.lease_contract_unit unit on unit.lease_contract_unit_id = link.lease_contract_unit_id
    where link.appsuite_record_id = v_record.appsuite_record_id
      and (contract.lease_contract_id is null
        or (link.lease_contract_unit_id is not null and unit.lease_contract_id is distinct from link.lease_contract_id))
  ) then raise exception '契約リンクの参照先を確認してください'; end if;

  v_previous_status := v_request.status;
  if v_request.status <> 'applied' then
    update public.change_request
       set source_appsuite_record_id = coalesce(source_appsuite_record_id, v_record.appsuite_record_id),
           status = 'applied', applied_at = now(), applied_by = auth.uid(),
           resolved_at = coalesce(resolved_at, now()), resolved_by = coalesce(resolved_by, auth.uid()),
           lease_contract_id = case when v_distinct_contract_count = 1 then v_single_contract_id else null end
     where change_request_id = p_change_request_id returning * into v_request;
  elsif v_request.source_appsuite_record_id is null then
    update public.change_request
       set source_appsuite_record_id = v_record.appsuite_record_id
     where change_request_id = p_change_request_id returning * into v_request;
  end if;
  update public.appsuite_record
     set workflow_completed_at = coalesce(workflow_completed_at, now()),
         workflow_completed_by = coalesce(workflow_completed_by, auth.uid()),
         workflow_processed_at = coalesce(workflow_processed_at, now()),
         workflow_processed_reason = 'manual_contract_link'
   where appsuite_record_id = v_record.appsuite_record_id;
  insert into public.change_request_action_log
    (change_request_id, action_type, previous_status, next_status, details, performed_by)
  values (
    p_change_request_id, 'applied', v_previous_status, 'applied',
    jsonb_build_object('mode', 'existing_contract_reconciled', 'verified_link_ids', p_verified_link_ids,
      'confirmed_fields', p_confirmed_fields, 'note', btrim(p_note), 'current_contract_changed', false,
      'source_appsuite_record_reconciled', v_request.source_appsuite_record_id = v_record.appsuite_record_id), auth.uid()
  );
  return v_request;
end;
$$;

revoke execute on function public.complete_linked_contract_request(uuid, integer, uuid[], jsonb, text) from public, anon;
grant execute on function public.complete_linked_contract_request(uuid, integer, uuid[], jsonb, text) to authenticated;
