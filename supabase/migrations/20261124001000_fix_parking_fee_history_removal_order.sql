create or replace function public.apply_parking_fee_schedule(
  p_parking_lease_contract_unit_id uuid,
  p_expected_row_version integer,
  p_changes jsonb,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_unit public.lease_contract_unit%rowtype;
  v_contract public.lease_contract%rowtype;
  v_change jsonb;
  v_action text;
  v_effective_from date;
  v_amount numeric;
  v_scope text;
  v_main_unit_id uuid;
  v_main_contract_id uuid;
  v_fee public.parking_fee_history%rowtype;
  v_previous public.parking_fee_history%rowtype;
  v_next_start date;
  v_contract_end date;
  v_before jsonb;
  v_after jsonb;
  v_request_id uuid;
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
begin
  if auth.uid() is null or not (select public.current_account_is_active())
     or (select public.current_account_role()) not in ('admin', 'manager') then
    raise exception '駐車料履歴の編集は管理者またはマネージャーだけが実行できます';
  end if;
  if nullif(btrim(p_reason), '') is null then raise exception '変更理由を入力してください'; end if;
  if jsonb_typeof(p_changes) is distinct from 'array' or jsonb_array_length(p_changes) = 0 then
    raise exception '駐車料の変更を1件以上入力してください';
  end if;

  select cu.* into v_unit
    from public.lease_contract_unit cu
    join public.unit_master u on u.unit_id = cu.unit_id
   where cu.lease_contract_unit_id = p_parking_lease_contract_unit_id
     and u.unit_type = 'parking'
   for update of cu;
  if not found then raise exception '対象の駐車場契約区画が見つかりません'; end if;
  if v_unit.row_version <> p_expected_row_version then
    raise exception '契約区画が別の操作で更新されました。再読み込みしてください';
  end if;
  select c.* into v_contract from public.lease_contract c
   where c.lease_contract_id = v_unit.lease_contract_id for update;
  if not found or v_contract.contract_type <> 'parking' then raise exception '対象の駐車場契約が見つかりません'; end if;
  v_contract_end := coalesce(v_unit.lease_end_date, v_contract.contract_end_date);

  if exists (
    select 1 from (
      select value ->> 'effective_from' as effective_from, count(*) as row_count
        from jsonb_array_elements(p_changes) group by value ->> 'effective_from'
    ) d where d.row_count > 1
  ) then raise exception '同じ適用開始日を複数回指定できません'; end if;

  for v_change in select value from jsonb_array_elements(p_changes) loop
    v_action := v_change ->> 'action';
    if v_action is null or v_action not in ('upsert', 'remove') then raise exception '駐車料変更操作が不正です'; end if;
    if nullif(v_change ->> 'effective_from', '') is null then raise exception '適用開始日を入力してください'; end if;
    v_effective_from := (v_change ->> 'effective_from')::date;
    if v_effective_from < coalesce(v_unit.lease_start_date, v_contract.contract_start_date, v_effective_from)
       or v_effective_from > coalesce(v_contract_end, 'infinity'::date) then
      raise exception '適用開始日は契約区画の利用期間内に設定してください';
    end if;
    if v_action = 'upsert' then
      v_amount := (v_change ->> 'monthly_parking_fee')::numeric;
      if v_amount is null or v_amount < 0 or trunc(v_amount) <> v_amount then
        raise exception '月額駐車料は0以上の整数で指定してください';
      end if;
      v_scope := v_change ->> 'parking_scope';
      if v_scope not in ('internal', 'external') then raise exception '契約区分を確認してください'; end if;
      v_main_unit_id := nullif(v_change ->> 'main_lease_contract_unit_id', '')::uuid;
      if v_scope = 'internal' and v_main_unit_id is null then raise exception '内部契約には主契約区画が必要です'; end if;
    elsif v_effective_from < v_today then
      raise exception '適用済みの駐車料履歴は取消できません';
    end if;
  end loop;

  select coalesce(jsonb_agg(to_jsonb(h) order by h.effective_from), '[]'::jsonb)
    into v_before from public.parking_fee_history h
   where h.parking_lease_contract_unit_id = p_parking_lease_contract_unit_id;

  insert into public.change_request (
    source_type, source_record_key, request_type, status, title, summary,
    source_payload, proposed_payload, resolution_payload, lease_contract_id,
    resolved_at, resolved_by, applied_at, applied_by
  ) values (
    'manual', concat('parking-fee-schedule:', p_parking_lease_contract_unit_id, ':', gen_random_uuid()),
    'contract_update', 'applied', '駐車料履歴の修正', btrim(p_reason),
    jsonb_build_object('origin', 'parking_fee_schedule_editor', 'lease_contract_unit_id', p_parking_lease_contract_unit_id),
    jsonb_build_object('changes', p_changes, 'before_schedule', v_before),
    jsonb_build_object('reason', btrim(p_reason)), v_contract.lease_contract_id,
    now(), auth.uid(), now(), auth.uid()
  ) returning change_request_id into v_request_id;

  for v_change in
    select value from jsonb_array_elements(p_changes)
     where value ->> 'action' = 'remove'
     order by (value ->> 'effective_from')::date desc
  loop
    v_effective_from := (v_change ->> 'effective_from')::date;
    select h.* into v_fee from public.parking_fee_history h
     where h.parking_lease_contract_unit_id = p_parking_lease_contract_unit_id
       and h.effective_from = v_effective_from for update;
    if not found then raise exception '取消対象の将来駐車料が見つかりません'; end if;
    if v_fee.source_import_batch_id is not null or v_fee.source_import_row_id is not null then
      raise exception '取込データ由来の駐車料履歴は取消できません';
    end if;
    select h.* into v_previous from public.parking_fee_history h
     where h.parking_lease_contract_unit_id = p_parking_lease_contract_unit_id
       and h.effective_from < v_effective_from order by h.effective_from desc limit 1 for update;
    if not found then raise exception '最初の駐車料条件は取消できません'; end if;
    select h.effective_from into v_next_start from public.parking_fee_history h
     where h.parking_lease_contract_unit_id = p_parking_lease_contract_unit_id
       and h.effective_from > v_effective_from order by h.effective_from limit 1;
    delete from public.parking_fee_history where parking_fee_history_id = v_fee.parking_fee_history_id;
    update public.parking_fee_history set effective_to = case when v_next_start is null then v_contract_end else v_next_start - 1 end, updated_at = now()
     where parking_fee_history_id = v_previous.parking_fee_history_id;
  end loop;

  for v_change in
    select value from jsonb_array_elements(p_changes)
     where value ->> 'action' = 'upsert'
     order by (value ->> 'effective_from')::date
  loop
    v_effective_from := (v_change ->> 'effective_from')::date;
    v_amount := (v_change ->> 'monthly_parking_fee')::numeric;
    v_scope := v_change ->> 'parking_scope';
    v_main_unit_id := nullif(v_change ->> 'main_lease_contract_unit_id', '')::uuid;
    v_main_contract_id := null;
    if v_scope = 'internal' then
      select cu.lease_contract_id into v_main_contract_id
        from public.lease_contract_unit cu where cu.lease_contract_unit_id = v_main_unit_id;
      if v_main_contract_id is null then raise exception '主契約区画が見つかりません'; end if;
    end if;
    perform public.set_parking_fee_history_for_unit(
      p_parking_lease_contract_unit_id, v_scope, v_main_contract_id, v_main_unit_id,
      v_amount, v_effective_from,
      nullif(v_change ->> 'source_import_batch_id', '')::uuid,
      nullif(v_change ->> 'source_import_row_id', '')::uuid,
      v_change ->> 'source_file_name',
      v_change ->> 'source_sheet_name',
      nullif(v_change ->> 'source_row_number', '')::integer
    );
  end loop;

  update public.lease_contract_unit set updated_at = now()
   where lease_contract_unit_id = p_parking_lease_contract_unit_id;
  select coalesce(jsonb_agg(to_jsonb(h) order by h.effective_from), '[]'::jsonb)
    into v_after from public.parking_fee_history h
   where h.parking_lease_contract_unit_id = p_parking_lease_contract_unit_id;
  update public.change_request set proposed_payload = jsonb_build_object(
    'changes', p_changes, 'before_schedule', v_before, 'after_schedule', v_after
  ), updated_by = auth.uid(), updated_at = now() where change_request_id = v_request_id;
  insert into public.change_request_item (
    change_request_id, entity_type, entity_id, field_name,
    current_value, proposed_value, validation_status, validation_message
  ) values (
    v_request_id, 'lease_contract_unit', p_parking_lease_contract_unit_id, 'parking_fee_schedule',
    v_before, v_after, 'valid', '適用開始日ごとの駐車料条件を保存しました'
  );
  insert into public.change_request_action_log (
    change_request_id, action_type, previous_status, next_status, details, performed_by
  ) values (
    v_request_id, 'applied', null, 'applied',
    jsonb_build_object('reason', btrim(p_reason), 'change_count', jsonb_array_length(p_changes)), auth.uid()
  );
  return jsonb_build_object('change_request_id', v_request_id, 'parking_fee_schedule', v_after);
end;
$$;

revoke all on function public.apply_parking_fee_schedule(uuid, integer, jsonb, text) from public, anon;
grant execute on function public.apply_parking_fee_schedule(uuid, integer, jsonb, text) to authenticated;
