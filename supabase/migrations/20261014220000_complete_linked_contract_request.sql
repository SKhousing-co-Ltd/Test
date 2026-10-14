-- A reconciled AppSuite new-contract request can point at existing contract
-- units. Completion must not run the contract-creation branch again.
create function public.complete_linked_contract_request(
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
  if v_request.request_type <> 'contract_create' or v_request.source_appsuite_record_id is null then
    raise exception 'AppSuite新規契約の対応依頼ではありません';
  end if;
  select * into v_record from public.appsuite_record
   where appsuite_record_id = v_request.source_appsuite_record_id for update;
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
       set status = 'applied', applied_at = now(), applied_by = auth.uid(),
           resolved_at = coalesce(resolved_at, now()), resolved_by = coalesce(resolved_by, auth.uid()),
           lease_contract_id = case when v_distinct_contract_count = 1 then v_single_contract_id else null end
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
      'confirmed_fields', p_confirmed_fields, 'note', btrim(p_note), 'current_contract_changed', false), auth.uid()
  );
  return v_request;
end;
$$;

revoke execute on function public.complete_linked_contract_request(uuid, integer, uuid[], jsonb, text) from public, anon;
grant execute on function public.complete_linked_contract_request(uuid, integer, uuid[], jsonb, text) to authenticated;

-- Keep the existing apply function intact except for a guard against creating
-- another contract for a workflow that has already been linked.
do $$
declare
  v_definition text;
  v_anchor text := $sql$if v_request.request_type = 'contract_create' then$sql$;
begin
  select pg_get_functiondef('public.apply_change_request(uuid,integer)'::regprocedure) into v_definition;
  if position(v_anchor in v_definition) = 0 then
    raise exception 'apply_change_request contract-create branch was not found';
  end if;
  execute replace(v_definition, v_anchor, v_anchor || $sql$
    if v_request.source_appsuite_record_id is not null and exists (
      select 1 from public.workflow_contract_link
       where appsuite_record_id = v_request.source_appsuite_record_id
    ) then
      raise exception '既存契約に紐付け済みです。照合完了の操作を使用してください';
    end if;$sql$);
end;
$$;
