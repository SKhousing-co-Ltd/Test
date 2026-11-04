-- Resolved contract-create requests remain editable in the UI until final application.
-- Persisting their reviewed contract draft allows the apply RPC to receive tenant_id or new_tenant_name.
create or replace function public.save_contract_create_draft(
  p_change_request_id uuid,
  p_expected_row_version integer,
  p_contract jsonb,
  p_units jsonb
) returns public.change_request
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.change_request;
  v_property_id uuid;
  v_unit jsonb;
  v_unit_id uuid;
  v_unit_count integer := 0;
begin
  if not public.current_account_is_active() or public.current_account_role() not in ('admin', 'manager', 'staff') then
    raise exception '契約対応依頼の編集権限がありません';
  end if;
  if jsonb_typeof(p_contract) <> 'object' or jsonb_typeof(p_units) <> 'array' or jsonb_array_length(p_units) = 0 then
    raise exception '契約情報と1件以上の区画が必要です';
  end if;
  if nullif(p_contract ->> 'property_id', '') is null then raise exception '物件を選択してください'; end if;
  v_property_id := (p_contract ->> 'property_id')::uuid;
  if ((p_contract ? 'tenant_id') and nullif(p_contract ->> 'tenant_id', '') is not null)
     = ((p_contract ? 'new_tenant_name') and nullif(btrim(p_contract ->> 'new_tenant_name'), '') is not null) then
    raise exception '既存テナントまたは新規テナント名のどちらか一方を指定してください';
  end if;
  if nullif(p_contract ->> 'tenant_id', '') is not null
     and not exists (select 1 from public.tenant_master where tenant_id = (p_contract ->> 'tenant_id')::uuid) then
    raise exception '選択したテナントが見つかりません';
  end if;
  for v_unit in select value from jsonb_array_elements(p_units)
  loop
    v_unit_id := (v_unit ->> 'unit_id')::uuid;
    if not exists (
      select 1 from public.unit_master
       where unit_id = v_unit_id and property_id = v_property_id and is_active
    ) then raise exception '物件に属する有効な区画を選択してください'; end if;
    if exists (
      select 1 from jsonb_array_elements(p_units) duplicate
       where duplicate.value ->> 'unit_id' = v_unit ->> 'unit_id'
       group by duplicate.value ->> 'unit_id' having count(*) > 1
    ) then raise exception '同じ区画を複数指定できません'; end if;
    v_unit_count := v_unit_count + 1;
  end loop;
  update public.change_request
     set proposed_payload = jsonb_build_object('contract', p_contract, 'units', p_units),
         lease_contract_id = null
   where change_request_id = p_change_request_id
     and request_type = 'contract_create'
     and row_version = p_expected_row_version
     and status in ('draft', 'open', 'in_review', 'on_hold', 'resolved')
  returning * into v_request;
  if not found then raise exception '対応依頼が更新済みか、編集できない状態です'; end if;
  if exists (
    select 1 from public.appsuite_record
     where appsuite_record_id = v_request.source_appsuite_record_id and is_cancelled
  ) then raise exception '取消済み稟議は編集できません'; end if;
  update public.change_request_item set validation_status = 'valid', validation_message = concat(v_unit_count, '区画を確認済み')
   where change_request_id = p_change_request_id;
  insert into public.change_request_action_log(change_request_id, action_type, previous_status, next_status, details, performed_by)
  values (p_change_request_id, 'draft_saved', v_request.status, v_request.status, jsonb_build_object('unit_count', v_unit_count), auth.uid());
  return v_request;
end;
$$;
