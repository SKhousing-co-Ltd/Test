-- asset_id は property_id の正本として新規の業務データから参照される。
-- 既存行は 20260731000000 で uid から移行済みのため、ここでは新規行の採番だけを補う。
alter table public.asset_master
  alter column asset_id set default gen_random_uuid();

-- 対応依頼は認可済みRPCからだけ状態を変更する。
-- SELECT と既存のRPC実行権限は維持し、Data API経由の直接変更だけを禁止する。
revoke insert, update, delete, truncate, references, trigger
  on table public.change_request, public.change_request_item
  from authenticated;

-- 20260827110000 の再チェック用トリガーが同名関数を置換したため、
-- 駐車料金を確定しても対応依頼を applied にできず、終了日も記録されなくなっていた。
-- 再チェックと確定処理を同じトリガー関数に統合する。
create or replace function private.close_parking_fee_change_request()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  target record;
  closed_request record;
  parking_contract_end_date date;
begin
  if auth.uid() is null
     or not public.current_account_is_active()
     or public.current_account_role() not in ('admin', 'manager') then
    raise exception '駐車料対応依頼の確定は管理者またはマネージャーだけが実行できます';
  end if;

  for target in
    select request.change_request_id, request.row_version
    from public.change_request as request
    where request.source_type = 'manual'
      and request.source_record_key = concat('parking-fee:', new.parking_lease_contract_unit_id)
      and request.request_type = 'parking_fee_setup'
      and request.status in ('open', 'in_review', 'on_hold')
    order by request.created_at
  loop
    perform private.recheck_change_request_internal(target.change_request_id, target.row_version);
  end loop;

  select contract_unit.lease_end_date
    into parking_contract_end_date
  from public.lease_contract_unit as contract_unit
  join public.lease_contract as contract
    on contract.lease_contract_id = contract_unit.lease_contract_id
  where contract_unit.lease_contract_unit_id = new.parking_lease_contract_unit_id
    and contract.contract_type = 'parking';

  update public.change_request_item as item
  set proposed_value = to_jsonb(new.monthly_parking_fee),
      validation_status = 'valid',
      validation_message = null,
      updated_at = now()
  from public.change_request as request
  where request.change_request_id = item.change_request_id
    and request.source_type = 'manual'
    and request.source_record_key = concat('parking-fee:', new.parking_lease_contract_unit_id)
    and request.request_type = 'parking_fee_setup'
    and request.status not in ('applied', 'excluded');

  for closed_request in
    update public.change_request as request
    set status = 'applied',
        resolved_at = now(),
        resolved_by = auth.uid(),
        applied_at = now(),
        applied_by = auth.uid(),
        resolution_payload = jsonb_build_object(
          'parking_fee_history_id', new.parking_fee_history_id,
          'monthly_parking_fee', new.monthly_parking_fee,
          'effective_from', new.effective_from,
          'parking_contract_end_date', parking_contract_end_date,
          'main_lease_contract_unit_id', new.main_lease_contract_unit_id
        ),
        row_version = request.row_version + 1,
        updated_by = auth.uid(),
        updated_at = now()
    where request.source_type = 'manual'
      and request.source_record_key = concat('parking-fee:', new.parking_lease_contract_unit_id)
      and request.request_type = 'parking_fee_setup'
      and request.status not in ('applied', 'excluded')
    returning request.change_request_id
  loop
    insert into public.change_request_action_log (
      change_request_id, action_type, previous_status, next_status, details, performed_by
    ) values (
      closed_request.change_request_id, 'applied', 'open', 'applied',
      jsonb_build_object(
        'parking_fee_history_id', new.parking_fee_history_id,
        'parking_contract_end_date', parking_contract_end_date
      ),
      auth.uid()
    );
  end loop;

  return new;
end;
$$;

revoke all on function private.close_parking_fee_change_request() from public, anon, authenticated;

-- 再チェック対応版の enqueue 関数で、終了日を含む入力案内が失われていたため復元する。
create or replace function public.enqueue_parking_fee_change_request(
  p_parking_lease_contract_unit_id uuid,
  p_import_batch_id uuid default null,
  p_import_row_id uuid default null
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  state jsonb;
  source_file_name text;
  source_sheet_name text;
  source_row_number integer;
  request_id uuid;
  guidance text;
begin
  if auth.uid() is not null and (
    not public.current_account_is_active()
    or public.current_account_role() not in ('admin', 'manager')
  ) then
    raise exception '駐車料対応依頼の作成は管理者またはマネージャーだけが実行できます';
  end if;

  state := private.parking_fee_setup_state(p_parking_lease_contract_unit_id);
  if not coalesce((state ->> 'supported')::boolean, false) then
    raise exception '駐車場契約区画が見つかりません';
  end if;
  if coalesce((state ->> 'resolved')::boolean, false) then
    return null;
  end if;

  guidance := case when state ->> 'parking_scope' = 'external'
    then '月額駐車料・適用開始日・駐車場契約終了日を確認してください'
    else '月額駐車料・適用開始日・駐車場契約終了日・控除対象の主契約区画を確認してください'
  end;

  if p_import_batch_id is not null then
    select batch.source_file_name, batch.source_sheet_name, row_data.source_row_number
      into source_file_name, source_sheet_name, source_row_number
    from public.parking_import_batch as batch
    left join public.parking_import_row as row_data
      on row_data.parking_import_row_id = p_import_row_id
    where batch.parking_import_batch_id = p_import_batch_id;
  end if;

  select request.change_request_id into request_id
  from public.change_request as request
  where request.source_type = 'manual'
    and request.source_record_key = concat('parking-fee:', p_parking_lease_contract_unit_id)
    and request.request_type = 'parking_fee_setup'
    and request.status not in ('applied', 'excluded')
  order by request.created_at desc
  limit 1;

  if request_id is null then
    insert into public.change_request (
      source_type, source_record_key, request_type, status, title, summary,
      source_payload, proposed_payload, lease_contract_id
    ) values (
      'manual', concat('parking-fee:', p_parking_lease_contract_unit_id),
      'parking_fee_setup', 'open',
      concat('駐車料設定: ', state ->> 'property_name', ' ', state ->> 'space_number'),
      concat(state ->> 'tenant_name', 'の', guidance),
      jsonb_strip_nulls(jsonb_build_object(
        'source_file_name', source_file_name, 'source_sheet_name', source_sheet_name,
        'source_row_number', source_row_number
      )),
      jsonb_strip_nulls(jsonb_build_object(
        'parking_lease_contract_unit_id', state -> 'lease_contract_unit_id',
        'parking_lease_contract_id', state -> 'lease_contract_id',
        'property_id', state -> 'property_id', 'property_name', state -> 'property_name',
        'tenant_id', state -> 'tenant_id', 'tenant_name', state -> 'tenant_name',
        'space_number', state -> 'space_number', 'parking_scope', state -> 'parking_scope',
        'main_lease_contract_id', state -> 'main_lease_contract_id',
        'contract_start_date', state -> 'lease_start_date', 'contract_end_date', state -> 'lease_end_date'
      )),
      nullif(state ->> 'lease_contract_id', '')::uuid
    ) returning change_request_id into request_id;

    insert into public.change_request_item (
      change_request_id, entity_type, entity_id, field_name,
      current_value, proposed_value, validation_status, validation_message
    ) values (
      request_id, 'parking_fee_history', p_parking_lease_contract_unit_id,
      'monthly_parking_fee', state -> 'current_state', null, 'pending', guidance
    );
  else
    update public.change_request as request
    set title = concat('駐車料設定: ', state ->> 'property_name', ' ', state ->> 'space_number'),
        summary = concat(state ->> 'tenant_name', 'の', guidance),
        proposed_payload = request.proposed_payload || jsonb_strip_nulls(jsonb_build_object(
          'property_name', state -> 'property_name', 'tenant_name', state -> 'tenant_name',
          'parking_scope', state -> 'parking_scope', 'contract_start_date', state -> 'lease_start_date',
          'contract_end_date', state -> 'lease_end_date'
        ))
    where request.change_request_id = request_id;

    update public.change_request_item as item
    set current_value = state -> 'current_state', validation_status = 'pending', validation_message = guidance
    where item.change_request_id = request_id
      and item.entity_type = 'parking_fee_history';
  end if;
  return request_id;
end;
$$;

revoke all on function public.enqueue_parking_fee_change_request(uuid, uuid, uuid) from public, anon;
grant execute on function public.enqueue_parking_fee_change_request(uuid, uuid, uuid) to authenticated;
