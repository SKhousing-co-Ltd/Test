create or replace function public.enqueue_parking_fee_change_request(
  p_parking_lease_contract_unit_id uuid,
  p_import_batch_id uuid default null,
  p_import_row_id uuid default null
)
returns uuid
language plpgsql
security invoker
set search_path to 'public'
as $$
declare
  parking_record record;
  source_file_name text;
  source_sheet_name text;
  source_row_number integer;
  request_id uuid;
begin
  if auth.uid() is not null and (
    not (select public.current_account_is_active())
    or (select public.current_account_role()) not in ('admin', 'manager')
  ) then
    raise exception '駐車料対応依頼の作成は管理者またはマネージャーだけが実行できます';
  end if;
  if exists (select 1 from public.parking_fee_history history where history.parking_lease_contract_unit_id = p_parking_lease_contract_unit_id) then return null; end if;

  select contract_unit.lease_contract_unit_id, contract_unit.lease_contract_id,
    contract_unit.lease_start_date, contract_unit.lease_end_date, contract.tenant_id,
    tenant.tenant_name, unit.property_id, asset.asset_name, unit.unit_code,
    coalesce(space.space_number, unit.unit_code) as space_number,
    detail.parking_scope, detail.main_lease_contract_id
  into parking_record
  from public.lease_contract_unit contract_unit
  join public.lease_contract contract on contract.lease_contract_id = contract_unit.lease_contract_id
  join public.tenant_master tenant on tenant.tenant_id = contract.tenant_id
  join public.unit_master unit on unit.unit_id = contract_unit.unit_id
  join public.asset_master asset on asset.asset_id = unit.property_id
  left join public.parking_space_master space on space.unit_id = unit.unit_id
  left join public.parking_contract_detail detail on detail.lease_contract_id = contract.lease_contract_id
  where contract_unit.lease_contract_unit_id = p_parking_lease_contract_unit_id and unit.unit_type = 'parking';
  if not found then raise exception '駐車場契約区画が見つかりません'; end if;

  if p_import_batch_id is not null then
    select batch.source_file_name, batch.source_sheet_name, row_data.source_row_number
    into source_file_name, source_sheet_name, source_row_number
    from public.parking_import_batch batch
    left join public.parking_import_row row_data on row_data.parking_import_row_id = p_import_row_id
    where batch.parking_import_batch_id = p_import_batch_id;
  end if;

  select request.change_request_id into request_id from public.change_request request
  where request.source_type = 'manual'
    and request.source_record_key = concat('parking-fee:', p_parking_lease_contract_unit_id)
    and request.request_type = 'parking_fee_setup' and request.status not in ('applied', 'excluded')
  order by request.created_at desc limit 1;

  if request_id is null then
    insert into public.change_request (source_type, source_record_key, request_type, status, title, summary, source_payload, proposed_payload, lease_contract_id)
    values ('manual', concat('parking-fee:', p_parking_lease_contract_unit_id), 'parking_fee_setup', 'open',
      concat('駐車料設定: ', parking_record.asset_name, ' ', parking_record.space_number),
      concat(parking_record.tenant_name, 'の月額駐車料と適用開始日を入力してください。'),
      jsonb_strip_nulls(jsonb_build_object('source_file_name', source_file_name, 'source_sheet_name', source_sheet_name, 'source_row_number', source_row_number)),
      jsonb_build_object('parking_lease_contract_unit_id', parking_record.lease_contract_unit_id, 'parking_lease_contract_id', parking_record.lease_contract_id,
        'property_id', parking_record.property_id, 'property_name', parking_record.asset_name, 'tenant_id', parking_record.tenant_id,
        'tenant_name', parking_record.tenant_name, 'space_number', parking_record.space_number, 'parking_scope', parking_record.parking_scope,
        'main_lease_contract_id', parking_record.main_lease_contract_id, 'contract_start_date', parking_record.lease_start_date,
        'contract_end_date', parking_record.lease_end_date), parking_record.lease_contract_id)
    returning change_request_id into request_id;
    insert into public.change_request_item (change_request_id, entity_type, entity_id, field_name, current_value, proposed_value, validation_status, validation_message)
    values (request_id, 'parking_fee_history', p_parking_lease_contract_unit_id, 'monthly_parking_fee', null, null, 'pending',
      '月額駐車料・適用開始日・控除対象の主契約区画を確認してください');
  end if;
  return request_id;
end;
$$;

revoke all on function public.enqueue_parking_fee_change_request(uuid, uuid, uuid) from public, anon;
grant execute on function public.enqueue_parking_fee_change_request(uuid, uuid, uuid) to authenticated;
revoke all on function public.close_parking_fee_change_request() from public, anon, authenticated;
