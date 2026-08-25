-- 駐車料はExcelから登録せず、対応依頼で確認・手入力して履歴へ反映する。

alter table public.change_request drop constraint if exists ck_change_request_request_type;
alter table public.change_request add constraint ck_change_request_request_type check (
  request_type in (
    'contract_create', 'contract_update', 'contract_terminate', 'approval_cancel',
    'contract_cancellation_review', 'rent_roll_correction', 'master_data_correction',
    'parking_fee_setup', 'other'
  )
);

alter table public.change_request_item drop constraint if exists ck_change_request_item_entity_type;
alter table public.change_request_item add constraint ck_change_request_item_entity_type check (
  entity_type in (
    'lease_contract', 'lease_contract_unit', 'unit_master', 'tenant_master',
    'rent_roll_import_issue', 'parking_fee_history', 'other'
  )
);

create or replace function public.sync_parking_import_monthly_fee()
returns trigger
language plpgsql
security invoker
set search_path to 'public'
as $$
begin
  if new.monthly_parking_fee is not null
     or nullif(trim(new.raw_payload->>'monthly_parking_fee'), '') is not null then
    raise exception '月額駐車料はExcel取込では登録できません。取込後の対応依頼から入力してください';
  end if;
  new.monthly_parking_fee := null;
  new.raw_payload := new.raw_payload - 'monthly_parking_fee';
  return new;
end;
$$;

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

  if exists (
    select 1 from public.parking_fee_history history
    where history.parking_lease_contract_unit_id = p_parking_lease_contract_unit_id
  ) then
    return null;
  end if;

  select
    contract_unit.lease_contract_unit_id,
    contract_unit.lease_contract_id,
    contract_unit.lease_start_date,
    contract_unit.lease_end_date,
    contract.tenant_id,
    tenant.tenant_name,
    unit.property_id,
    asset.asset_name,
    unit.unit_code,
    coalesce(space.space_number, unit.unit_code) as space_number,
    detail.parking_scope,
    detail.main_lease_contract_id
  into parking_record
  from public.lease_contract_unit contract_unit
  join public.lease_contract contract on contract.lease_contract_id = contract_unit.lease_contract_id
  join public.tenant_master tenant on tenant.tenant_id = contract.tenant_id
  join public.unit_master unit on unit.unit_id = contract_unit.unit_id
  join public.asset_master asset on asset.asset_id = unit.property_id
  left join public.parking_space_master space on space.unit_id = unit.unit_id
  left join public.parking_contract_detail detail on detail.lease_contract_id = contract.lease_contract_id
  where contract_unit.lease_contract_unit_id = p_parking_lease_contract_unit_id
    and unit.unit_type = 'parking';

  if not found then
    raise exception '駐車場契約区画が見つかりません';
  end if;

  if p_import_batch_id is not null then
    select batch.source_file_name, batch.source_sheet_name, row_data.source_row_number
    into source_file_name, source_sheet_name, source_row_number
    from public.parking_import_batch batch
    left join public.parking_import_row row_data
      on row_data.parking_import_row_id = p_import_row_id
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
      concat(parking_record.tenant_name, 'の月額駐車料と適用開始日を入力してください。'),
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
      '月額駐車料・適用開始日・控除対象の主契約区画を確認してください'
    );
  end if;

  return request_id;
end;
$$;

revoke all on function public.enqueue_parking_fee_change_request(uuid, uuid, uuid) from public, anon;
grant execute on function public.enqueue_parking_fee_change_request(uuid, uuid, uuid) to authenticated;

create or replace function public.close_parking_fee_change_request()
returns trigger
language plpgsql
security invoker
set search_path to 'public'
as $$
declare
  closed_request record;
begin
  update public.change_request_item item
  set proposed_value = to_jsonb(new.monthly_parking_fee),
      validation_status = 'valid',
      validation_message = null,
      updated_at = now()
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
          'main_lease_contract_unit_id', new.main_lease_contract_unit_id
        ),
        row_version = row_version + 1,
        updated_by = auth.uid(), updated_at = now()
    where request.source_type = 'manual'
      and request.source_record_key = concat('parking-fee:', new.parking_lease_contract_unit_id)
      and request.request_type = 'parking_fee_setup'
      and request.status not in ('applied', 'excluded')
    returning request.change_request_id, request.status
  loop
    insert into public.change_request_action_log (
      change_request_id, action_type, previous_status, next_status, details, performed_by
    ) values (
      closed_request.change_request_id, 'applied', 'open', 'applied',
      jsonb_build_object('parking_fee_history_id', new.parking_fee_history_id), auth.uid()
    );
  end loop;
  return new;
end;
$$;

revoke all on function public.close_parking_fee_change_request() from public, anon, authenticated;

drop trigger if exists close_parking_fee_change_request_after_write on public.parking_fee_history;
create trigger close_parking_fee_change_request_after_write
after insert or update of monthly_parking_fee, effective_from, main_lease_contract_unit_id
on public.parking_fee_history
for each row execute procedure public.close_parking_fee_change_request();

create or replace function public.apply_parking_fee_change_request(
  p_change_request_id uuid,
  p_expected_row_version integer,
  p_monthly_parking_fee numeric,
  p_effective_from date,
  p_main_lease_contract_unit_id uuid default null
)
returns jsonb
language plpgsql
security invoker
set search_path to 'public'
as $$
declare
  request_record public.change_request%rowtype;
  parking_lcu_id uuid;
  parking_scope text;
  main_lcu_id uuid;
  candidate_count integer;
  parking_record record;
begin
  if not (select public.current_account_is_active())
     or (select public.current_account_role()) not in ('admin', 'manager') then
    raise exception '駐車料対応依頼の確定は管理者またはマネージャーだけが実行できます';
  end if;
  if p_monthly_parking_fee is null or p_monthly_parking_fee < 0
     or trunc(p_monthly_parking_fee) <> p_monthly_parking_fee then
    raise exception '月額駐車料は0以上の整数で指定してください';
  end if;
  if p_effective_from is null then raise exception '適用開始日を指定してください'; end if;

  select * into request_record from public.change_request
  where change_request_id = p_change_request_id
    and request_type = 'parking_fee_setup'
    and status in ('open', 'in_review', 'on_hold')
    and row_version = p_expected_row_version
  for update;
  if not found then raise exception '対応依頼が更新済みか、確定できない状態です'; end if;

  select item.entity_id into parking_lcu_id
  from public.change_request_item item
  where item.change_request_id = p_change_request_id
    and item.entity_type = 'parking_fee_history'
  order by item.sort_order, item.created_at
  limit 1;
  if parking_lcu_id is null then raise exception '対象の駐車場契約区画が見つかりません'; end if;

  select detail.parking_scope, contract.tenant_id, unit.property_id,
         contract_unit.lease_start_date, contract_unit.lease_end_date
  into parking_record
  from public.lease_contract_unit contract_unit
  join public.lease_contract contract on contract.lease_contract_id = contract_unit.lease_contract_id
  join public.unit_master unit on unit.unit_id = contract_unit.unit_id
  join public.parking_contract_detail detail on detail.lease_contract_id = contract.lease_contract_id
  where contract_unit.lease_contract_unit_id = parking_lcu_id;
  if not found then raise exception '駐車場契約情報が見つかりません'; end if;
  parking_scope := parking_record.parking_scope;

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
          >= coalesce(parking_record.lease_end_date, 'infinity'::date);
      if candidate_count <> 1 then
        raise exception '控除対象の主契約区画を1件選択してください（候補%件）', candidate_count;
      end if;
    end if;
  else
    main_lcu_id := null;
  end if;

  perform public.set_parking_fee_history(
    parking_lcu_id, parking_scope, main_lcu_id, p_monthly_parking_fee,
    p_effective_from, null, null, '対応依頼', null, null
  );

  select * into request_record from public.change_request
  where change_request_id = p_change_request_id;
  return to_jsonb(request_record);
end;
$$;

revoke all on function public.apply_parking_fee_change_request(uuid, integer, numeric, date, uuid) from public, anon;
grant execute on function public.apply_parking_fee_change_request(uuid, integer, numeric, date, uuid) to authenticated;

create or replace function public.commit_parking_import(p_batch_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path to 'public'
as $$
declare
  batch public.parking_import_batch%rowtype;
  import_row public.parking_import_row%rowtype;
  result jsonb;
  row_status text;
  fee_contract_unit_id uuid;
  request_id uuid;
  request_count integer := 0;
begin
  if not (select public.current_account_is_active())
     or (select public.current_account_role()) not in ('admin', 'manager') then
    raise exception '駐車場取込は管理者またはマネージャーだけが実行できます';
  end if;
  select * into batch from public.parking_import_batch where parking_import_batch_id = p_batch_id;
  if not found then raise exception '取込バッチが見つかりません'; end if;

  result := public.commit_parking_import_without_fee(p_batch_id);

  for import_row in
    select * from public.parking_import_row where parking_import_batch_id = p_batch_id order by source_row_number
  loop
    row_status := coalesce(
      nullif(trim(import_row.raw_payload->>'parking_status'), ''),
      case when coalesce((import_row.raw_payload->>'is_vacant')::boolean, false) then 'vacant' else 'occupied' end
    );
    fee_contract_unit_id := import_row.committed_lease_contract_unit_id;

    if row_status = 'occupied' and fee_contract_unit_id is not null then
      request_id := public.enqueue_parking_fee_change_request(
        fee_contract_unit_id, batch.parking_import_batch_id, import_row.parking_import_row_id
      );
      if request_id is not null then request_count := request_count + 1; end if;
    else
      if fee_contract_unit_id is null and import_row.committed_unit_id is not null then
        select contract_unit.lease_contract_unit_id into fee_contract_unit_id
        from public.lease_contract_unit contract_unit
        join public.lease_contract contract on contract.lease_contract_id = contract_unit.lease_contract_id
        where contract_unit.unit_id = import_row.committed_unit_id
          and contract.contract_type = 'parking'
        order by coalesce(contract_unit.lease_end_date, 'infinity'::date) desc, contract_unit.created_at desc
        limit 1;
      end if;
      if fee_contract_unit_id is not null then
        delete from public.parking_fee_history history
        where history.parking_lease_contract_unit_id = fee_contract_unit_id
          and history.effective_from >= batch.as_of_date;
        update public.parking_fee_history history
        set effective_to = batch.as_of_date - 1, updated_at = now()
        where history.parking_lease_contract_unit_id = fee_contract_unit_id
          and history.effective_from < batch.as_of_date
          and (history.effective_to is null or history.effective_to >= batch.as_of_date);
        update public.change_request request
        set status = 'excluded',
            resolution_payload = jsonb_build_object('reason', 'parking_contract_not_occupied'),
            row_version = row_version + 1, updated_by = auth.uid(), updated_at = now()
        where request.source_type = 'manual'
          and request.source_record_key = concat('parking-fee:', fee_contract_unit_id)
          and request.request_type = 'parking_fee_setup'
          and request.status not in ('applied', 'excluded');
      end if;
    end if;
  end loop;

  return result || jsonb_build_object(
    'parking_fees_applied', false,
    'parking_fee_requests_created', request_count
  );
end;
$$;

revoke all on function public.commit_parking_import(uuid) from public, anon;
grant execute on function public.commit_parking_import(uuid) to authenticated;

-- 既存の未設定駐車契約も対応依頼へ展開する。完了済み・対象外の依頼は再作成しない。
do $$
declare parking_unit record;
begin
  for parking_unit in
    select contract_unit.lease_contract_unit_id
    from public.lease_contract_unit contract_unit
    join public.lease_contract contract on contract.lease_contract_id = contract_unit.lease_contract_id
    join public.unit_master unit on unit.unit_id = contract_unit.unit_id
    where unit.unit_type = 'parking'
      and contract.contract_status <> 'cancelled'
      and not exists (
        select 1 from public.parking_fee_history history
        where history.parking_lease_contract_unit_id = contract_unit.lease_contract_unit_id
      )
      and not exists (
        select 1 from public.change_request request
        where request.source_type = 'manual'
          and request.source_record_key = concat('parking-fee:', contract_unit.lease_contract_unit_id)
          and request.request_type = 'parking_fee_setup'
      )
  loop
    perform public.enqueue_parking_fee_change_request(parking_unit.lease_contract_unit_id, null, null);
  end loop;
end;
$$;

comment on function public.apply_parking_fee_change_request(uuid, integer, numeric, date, uuid)
is '駐車料対応依頼で手入力した月額・適用開始日・控除先を検証し、駐車料履歴へ反映して依頼を完了する。';
