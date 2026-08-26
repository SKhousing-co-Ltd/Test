-- 駐車料対応依頼で駐車場契約終了日を確定し、同じトランザクションで料金履歴へ反映する。

create or replace function public.enqueue_parking_fee_change_request(
  p_parking_lease_contract_unit_id uuid,
  p_import_batch_id uuid default null,
  p_import_row_id uuid default null
)
returns uuid
language plpgsql
security invoker
set search_path = pg_catalog, public
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
  if exists (
    select 1 from public.parking_fee_history history
    where history.parking_lease_contract_unit_id = p_parking_lease_contract_unit_id
  ) then
    return null;
  end if;

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
  where contract_unit.lease_contract_unit_id = p_parking_lease_contract_unit_id
    and contract.contract_type = 'parking'
    and unit.unit_type = 'parking';
  if not found then raise exception '駐車場契約区画が見つかりません'; end if;

  if p_import_batch_id is not null then
    select batch.source_file_name, batch.source_sheet_name, row_data.source_row_number
    into source_file_name, source_sheet_name, source_row_number
    from public.parking_import_batch batch
    left join public.parking_import_row row_data on row_data.parking_import_row_id = p_import_row_id
    where batch.parking_import_batch_id = p_import_batch_id;
  end if;

  select request.change_request_id into request_id
  from public.change_request request
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
      concat('駐車料設定: ', parking_record.asset_name, ' ', parking_record.space_number),
      concat(parking_record.tenant_name, 'の月額駐車料・適用開始日・駐車場契約終了日を確認してください。'),
      jsonb_strip_nulls(jsonb_build_object(
        'source_file_name', source_file_name,
        'source_sheet_name', source_sheet_name,
        'source_row_number', source_row_number
      )),
      jsonb_build_object(
        'parking_lease_contract_unit_id', parking_record.lease_contract_unit_id,
        'parking_lease_contract_id', parking_record.lease_contract_id,
        'property_id', parking_record.property_id,
        'property_name', parking_record.asset_name,
        'tenant_id', parking_record.tenant_id,
        'tenant_name', parking_record.tenant_name,
        'space_number', parking_record.space_number,
        'parking_scope', parking_record.parking_scope,
        'main_lease_contract_id', parking_record.main_lease_contract_id,
        'contract_start_date', parking_record.lease_start_date,
        'contract_end_date', parking_record.lease_end_date
      ),
      parking_record.lease_contract_id
    ) returning change_request_id into request_id;

    insert into public.change_request_item (
      change_request_id, entity_type, entity_id, field_name,
      current_value, proposed_value, validation_status, validation_message
    ) values (
      request_id, 'parking_fee_history', p_parking_lease_contract_unit_id,
      'monthly_parking_fee', null, null, 'pending',
      case when parking_record.parking_scope = 'external'
        then '月額駐車料・適用開始日・駐車場契約終了日を確認してください'
        else '月額駐車料・適用開始日・駐車場契約終了日・控除対象の主契約区画を確認してください'
      end
    );
  end if;
  return request_id;
end;
$$;

revoke all on function public.enqueue_parking_fee_change_request(uuid, uuid, uuid) from public, anon;
grant execute on function public.enqueue_parking_fee_change_request(uuid, uuid, uuid) to authenticated;

-- 既存の未確定依頼は再生成せず、画面と同じ案内文に揃える。
update public.change_request request
set summary = concat(
      coalesce(nullif(request.proposed_payload ->> 'tenant_name', ''), '対象テナント'),
      'の月額駐車料・適用開始日・駐車場契約終了日を確認してください。'
    ),
    updated_at = now()
where request.request_type = 'parking_fee_setup'
  and request.status not in ('applied', 'excluded');

update public.change_request_item item
set validation_message = case when request.proposed_payload ->> 'parking_scope' = 'external'
      then '月額駐車料・適用開始日・駐車場契約終了日を確認してください'
      else '月額駐車料・適用開始日・駐車場契約終了日・控除対象の主契約区画を確認してください'
    end,
    updated_at = now()
from public.change_request request
where request.change_request_id = item.change_request_id
  and request.request_type = 'parking_fee_setup'
  and request.status not in ('applied', 'excluded')
  and item.entity_type = 'parking_fee_history'
  and item.validation_status <> 'valid';

create or replace function private.close_parking_fee_change_request()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  closed_request record;
  parking_contract_end_date date;
begin
  if auth.uid() is null
     or not (select public.current_account_is_active())
     or (select public.current_account_role()) not in ('admin', 'manager') then
    raise exception '駐車料対応依頼の確定は管理者またはマネージャーだけが実行できます';
  end if;

  select contract_unit.lease_end_date
  into parking_contract_end_date
  from public.lease_contract_unit contract_unit
  join public.lease_contract contract on contract.lease_contract_id = contract_unit.lease_contract_id
  where contract_unit.lease_contract_unit_id = new.parking_lease_contract_unit_id
    and contract.contract_type = 'parking';

  update public.change_request_item item
  set proposed_value = to_jsonb(new.monthly_parking_fee),
      validation_status = 'valid', validation_message = null, updated_at = now()
  from public.change_request request
  where request.change_request_id = item.change_request_id
    and request.source_type = 'manual'
    and request.source_record_key = concat('parking-fee:', new.parking_lease_contract_unit_id)
    and request.request_type = 'parking_fee_setup'
    and request.status not in ('applied', 'excluded');

  for closed_request in
    update public.change_request request
    set status = 'applied',
        resolved_at = now(), resolved_by = auth.uid(),
        applied_at = now(), applied_by = auth.uid(),
        resolution_payload = jsonb_build_object(
          'parking_fee_history_id', new.parking_fee_history_id,
          'monthly_parking_fee', new.monthly_parking_fee,
          'effective_from', new.effective_from,
          'parking_contract_end_date', parking_contract_end_date,
          'main_lease_contract_unit_id', new.main_lease_contract_unit_id
        ),
        row_version = request.row_version + 1,
        updated_by = auth.uid(), updated_at = now()
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

-- 旧シグネチャを残すとPostgRESTでオーバーロードが曖昧になるため置換する。
drop function if exists public.apply_parking_fee_change_request(uuid, integer, numeric, date, uuid);
drop function if exists private.apply_parking_fee_change_request(uuid, integer, numeric, date, uuid);

create or replace function private.apply_parking_fee_change_request(
  p_change_request_id uuid,
  p_expected_row_version integer,
  p_monthly_parking_fee numeric,
  p_effective_from date,
  p_parking_contract_end_date date,
  p_main_lease_contract_unit_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  request_record public.change_request%rowtype;
  parking_lcu_id uuid;
  parking_scope text;
  parking_contract_id uuid;
  main_lcu_id uuid;
  main_contract_id uuid;
  candidate_count integer;
  parking_record record;
  contract_max_end date;
  all_contract_units_ended boolean;
begin
  if auth.uid() is null
     or not (select public.current_account_is_active())
     or (select public.current_account_role()) not in ('admin', 'manager') then
    raise exception '駐車料対応依頼の確定は管理者またはマネージャーだけが実行できます';
  end if;
  if p_monthly_parking_fee is null or p_monthly_parking_fee < 0
     or trunc(p_monthly_parking_fee) <> p_monthly_parking_fee then
    raise exception '月額駐車料は0以上の整数で指定してください';
  end if;
  if p_effective_from is null then raise exception '適用開始日を指定してください'; end if;
  select * into request_record
  from public.change_request request
  where request.change_request_id = p_change_request_id
    and request.request_type = 'parking_fee_setup'
    and request.status in ('open', 'in_review', 'on_hold')
    and request.row_version = p_expected_row_version
  for update;
  if not found then raise exception '対応依頼が更新済みか、確定できない状態です'; end if;

  select item.entity_id into parking_lcu_id
  from public.change_request_item item
  where item.change_request_id = p_change_request_id
    and item.entity_type = 'parking_fee_history'
  order by item.sort_order, item.created_at
  limit 1;
  if parking_lcu_id is null then raise exception '対象の駐車場契約区画が見つかりません'; end if;

  select detail.parking_scope, contract.lease_contract_id, contract.tenant_id,
         unit.property_id,
         coalesce(contract_unit.lease_start_date, contract.contract_start_date) as lease_start_date,
         contract_unit.lease_end_date
  into parking_record
  from public.lease_contract_unit contract_unit
  join public.lease_contract contract on contract.lease_contract_id = contract_unit.lease_contract_id
  join public.unit_master unit on unit.unit_id = contract_unit.unit_id
  join public.parking_contract_detail detail on detail.lease_contract_id = contract.lease_contract_id
  where contract_unit.lease_contract_unit_id = parking_lcu_id
    and contract.contract_type = 'parking'
    and unit.unit_type = 'parking'
  for update of contract_unit, contract;
  if not found then raise exception '駐車場契約情報が見つかりません'; end if;

  if p_parking_contract_end_date is null then
    raise exception '駐車場契約の終了日が未登録です。契約書を確認し、終了日を入力してください。';
  end if;
  if p_parking_contract_end_date < p_effective_from then
    raise exception '駐車場契約終了日は適用開始日以降を指定してください。';
  end if;
  if parking_record.lease_start_date is not null
     and p_parking_contract_end_date < parking_record.lease_start_date then
    raise exception '駐車場契約終了日は契約開始日以降を指定してください。';
  end if;

  parking_scope := parking_record.parking_scope;
  parking_contract_id := parking_record.lease_contract_id;

  update public.lease_contract_unit contract_unit
  set lease_end_date = p_parking_contract_end_date,
      updated_at = now()
  where contract_unit.lease_contract_unit_id = parking_lcu_id;

  select max(contract_unit.lease_end_date), bool_and(contract_unit.lease_end_date is not null)
  into contract_max_end, all_contract_units_ended
  from public.lease_contract_unit contract_unit
  where contract_unit.lease_contract_id = parking_contract_id;

  update public.lease_contract contract
  set contract_end_date = case
        when coalesce(all_contract_units_ended, false) then contract_max_end
        else null
      end,
      updated_at = now()
  where contract.lease_contract_id = parking_contract_id
    and contract.contract_type = 'parking';

  select detail.parking_scope, contract.lease_contract_id, contract.tenant_id,
         unit.property_id,
         coalesce(contract_unit.lease_start_date, contract.contract_start_date) as lease_start_date,
         contract_unit.lease_end_date
  into parking_record
  from public.lease_contract_unit contract_unit
  join public.lease_contract contract on contract.lease_contract_id = contract_unit.lease_contract_id
  join public.unit_master unit on unit.unit_id = contract_unit.unit_id
  join public.parking_contract_detail detail on detail.lease_contract_id = contract.lease_contract_id
  where contract_unit.lease_contract_unit_id = parking_lcu_id
    and contract.contract_type = 'parking'
    and unit.unit_type = 'parking';
  if parking_record.lease_end_date is distinct from p_parking_contract_end_date then
    raise exception '駐車場契約終了日の保存を確認できません';
  end if;

  if parking_scope = 'internal' then
    main_lcu_id := p_main_lease_contract_unit_id;
    if main_lcu_id is null then
      select count(*), min(candidate.lease_contract_unit_id)
      into candidate_count, main_lcu_id
      from public.lease_contract_unit candidate
      join public.lease_contract main_contract on main_contract.lease_contract_id = candidate.lease_contract_id
      join public.unit_master main_unit on main_unit.unit_id = candidate.unit_id
      where main_contract.tenant_id = parking_record.tenant_id
        and main_unit.property_id = parking_record.property_id
        and main_unit.unit_type <> 'parking'
        and coalesce(candidate.lease_start_date, main_contract.contract_start_date) <= p_effective_from
        and coalesce(candidate.lease_end_date, main_contract.contract_end_date, 'infinity'::date)
          >= parking_record.lease_end_date;
      if candidate_count <> 1 then
        raise exception '控除対象の主契約区画を1件選択してください（候補%件）', candidate_count;
      end if;
    end if;

    select contract_unit.lease_contract_id into main_contract_id
    from public.lease_contract_unit contract_unit
    where contract_unit.lease_contract_unit_id = main_lcu_id;
    if main_contract_id is null then raise exception '控除対象の主契約区画が見つかりません'; end if;
  else
    main_lcu_id := null;
    main_contract_id := null;
  end if;

  perform public.set_parking_fee_history(
    parking_lcu_id, parking_scope, main_contract_id, p_monthly_parking_fee,
    p_effective_from, null, null, '対応依頼', null, null
  );

  select * into request_record
  from public.change_request request
  where request.change_request_id = p_change_request_id;
  return to_jsonb(request_record);
end;
$$;

revoke all on function private.apply_parking_fee_change_request(uuid, integer, numeric, date, date, uuid)
  from public, anon;
grant execute on function private.apply_parking_fee_change_request(uuid, integer, numeric, date, date, uuid)
  to authenticated;

create or replace function public.apply_parking_fee_change_request(
  p_change_request_id uuid,
  p_expected_row_version integer,
  p_monthly_parking_fee numeric,
  p_effective_from date,
  p_parking_contract_end_date date,
  p_main_lease_contract_unit_id uuid default null
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog, public, private
as $$
  select private.apply_parking_fee_change_request(
    p_change_request_id, p_expected_row_version, p_monthly_parking_fee,
    p_effective_from, p_parking_contract_end_date, p_main_lease_contract_unit_id
  );
$$;

revoke all on function public.apply_parking_fee_change_request(uuid, integer, numeric, date, date, uuid)
  from public, anon;
grant execute on function public.apply_parking_fee_change_request(uuid, integer, numeric, date, date, uuid)
  to authenticated;

comment on function public.apply_parking_fee_change_request(uuid, integer, numeric, date, date, uuid)
is '駐車場契約終了日を駐車場契約に保存し、対応依頼から駐車料履歴を確定する。管理者・マネージャーのみ実行可能。';
