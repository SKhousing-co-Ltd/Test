-- 現在の業務データから対応依頼を再評価する共通基盤。
-- 対応依頼は削除せず、既に正本へ反映済みのときだけ既存の applied 状態へ進める。

create index if not exists ix_change_request_item_entity_recheck
  on public.change_request_item(entity_type, entity_id, change_request_id)
  where entity_id is not null;

create or replace function private.change_request_field_state(
  p_entity_type text,
  p_entity_id uuid,
  p_field_name text
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  current_value jsonb;
begin
  if p_entity_type = 'lease_contract' then
    if p_field_name not in (
      'tenant_id', 'contract_type', 'contract_start_date', 'contract_end_date',
      'renewal_terms', 'payment_terms', 'notes'
    ) then
      return jsonb_build_object('supported', false, 'found', false);
    end if;
    select to_jsonb(contract) -> p_field_name
      into current_value
      from public.lease_contract contract
     where contract.lease_contract_id = p_entity_id;
  elsif p_entity_type = 'lease_contract_unit' then
    if p_field_name not in (
      'leased_area_sqm', 'monthly_rent_amount', 'monthly_common_charge_amount',
      'deposit_amount', 'security_deposit_amount', 'key_money_amount',
      'renewal_fee_amount', 'lease_start_date', 'lease_end_date'
    ) then
      return jsonb_build_object('supported', false, 'found', false);
    end if;
    select to_jsonb(contract_unit) -> p_field_name
      into current_value
      from public.lease_contract_unit contract_unit
     where contract_unit.lease_contract_unit_id = p_entity_id;
  else
    return jsonb_build_object('supported', false, 'found', false);
  end if;

  return jsonb_build_object(
    'supported', true,
    'found', found,
    'value', current_value
  );
end;
$$;

create or replace function private.change_request_values_equal(
  p_field_name text,
  p_current_value jsonb,
  p_expected_value jsonb
)
returns boolean
language plpgsql
immutable
security invoker
set search_path = ''
as $$
begin
  if p_field_name in (
    'leased_area_sqm', 'monthly_rent_amount', 'monthly_common_charge_amount',
    'deposit_amount', 'security_deposit_amount', 'key_money_amount', 'renewal_fee_amount'
  ) then
    return nullif(p_current_value #>> '{}', '')::numeric
      is not distinct from nullif(p_expected_value #>> '{}', '')::numeric;
  elsif p_field_name in (
    'contract_start_date', 'contract_end_date', 'lease_start_date', 'lease_end_date'
  ) then
    return nullif(p_current_value #>> '{}', '')::date
      is not distinct from nullif(p_expected_value #>> '{}', '')::date;
  elsif p_field_name = 'tenant_id' then
    return nullif(p_current_value #>> '{}', '')::uuid
      is not distinct from nullif(p_expected_value #>> '{}', '')::uuid;
  end if;
  return p_current_value is not distinct from p_expected_value
    or p_current_value #>> '{}' is not distinct from p_expected_value #>> '{}';
exception when invalid_text_representation or numeric_value_out_of_range then
  return false;
end;
$$;

create or replace function private.parking_fee_setup_state(
  p_parking_lease_contract_unit_id uuid
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  parking_record record;
  resolved boolean;
  validation_message text;
begin
  select
    contract_unit.lease_contract_unit_id,
    contract_unit.lease_start_date,
    contract_unit.lease_end_date,
    contract.lease_contract_id,
    contract.tenant_id,
    tenant.tenant_name,
    unit.property_id,
    asset.asset_name,
    coalesce(space.space_number, unit.unit_code) as space_number,
    detail.parking_scope,
    detail.main_lease_contract_id,
    fee.parking_fee_history_id,
    fee.monthly_parking_fee,
    fee.effective_from,
    fee.main_lease_contract_unit_id
  into parking_record
  from public.lease_contract_unit contract_unit
  join public.lease_contract contract
    on contract.lease_contract_id = contract_unit.lease_contract_id
  join public.tenant_master tenant on tenant.tenant_id = contract.tenant_id
  join public.unit_master unit on unit.unit_id = contract_unit.unit_id
  join public.asset_master asset on asset.asset_id = unit.property_id
  left join public.parking_space_master space on space.unit_id = unit.unit_id
  left join public.parking_contract_detail detail
    on detail.lease_contract_id = contract.lease_contract_id
  left join lateral (
    select history.parking_fee_history_id, history.monthly_parking_fee,
           history.effective_from, history.main_lease_contract_unit_id
    from public.parking_fee_history history
    where history.parking_lease_contract_unit_id = contract_unit.lease_contract_unit_id
    order by history.effective_from desc, history.created_at desc
    limit 1
  ) fee on true
  where contract_unit.lease_contract_unit_id = p_parking_lease_contract_unit_id
    and contract.contract_type = 'parking'
    and unit.unit_type = 'parking';

  if not found then
    return jsonb_build_object('supported', false, 'resolved', false);
  end if;

  resolved := parking_record.parking_fee_history_id is not null
    and parking_record.effective_from is not null
    and parking_record.lease_end_date is not null
    and (
      parking_record.parking_scope = 'external'
      or parking_record.main_lease_contract_unit_id is not null
    );
  validation_message := concat_ws('・',
    case when parking_record.parking_fee_history_id is null then '月額駐車料と適用開始日' end,
    case when parking_record.lease_end_date is null then '駐車場契約終了日' end,
    case when parking_record.parking_scope is null
           or parking_record.parking_scope not in ('internal', 'external')
         then '契約区分' end,
    case when parking_record.parking_scope = 'internal'
           and parking_record.main_lease_contract_unit_id is null
         then '控除対象の主契約区画' end
  );
  if not resolved then
    validation_message := concat(validation_message, 'を確認してください');
  end if;

  return jsonb_build_object(
    'supported', true,
    'resolved', resolved,
    'validation_message', validation_message,
    'lease_contract_unit_id', parking_record.lease_contract_unit_id,
    'lease_contract_id', parking_record.lease_contract_id,
    'lease_start_date', parking_record.lease_start_date,
    'lease_end_date', parking_record.lease_end_date,
    'tenant_id', parking_record.tenant_id,
    'tenant_name', parking_record.tenant_name,
    'property_id', parking_record.property_id,
    'property_name', parking_record.asset_name,
    'space_number', parking_record.space_number,
    'parking_scope', parking_record.parking_scope,
    'main_lease_contract_id', parking_record.main_lease_contract_id,
    'current_state', jsonb_strip_nulls(jsonb_build_object(
      'parking_fee_history_id', parking_record.parking_fee_history_id,
      'monthly_parking_fee', parking_record.monthly_parking_fee,
      'effective_from', parking_record.effective_from,
      'parking_contract_end_date', parking_record.lease_end_date,
      'main_lease_contract_unit_id', parking_record.main_lease_contract_unit_id
    ))
  );
end;
$$;

revoke all on function private.change_request_field_state(text, uuid, text) from public, anon, authenticated;
revoke all on function private.change_request_values_equal(text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function private.parking_fee_setup_state(uuid) from public, anon;
grant execute on function private.parking_fee_setup_state(uuid) to authenticated;

create or replace function private.recheck_change_request_internal(
  p_change_request_id uuid,
  p_expected_row_version integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  request_record public.change_request%rowtype;
  previous_status text;
  evaluation_kind text;
  current_state jsonb := '{}'::jsonb;
  field_state jsonb;
  operation jsonb;
  item_record public.change_request_item%rowtype;
  parking_unit_id uuid;
  target_tenant_id uuid;
  check_count integer := 0;
  supported boolean := false;
  resolved boolean := true;
  validation_message text;
begin
  if auth.uid() is null or not (select public.current_account_is_active()) then
    raise exception '有効なアカウントが必要です';
  end if;

  select request.* into request_record
  from public.change_request request
  where request.change_request_id = p_change_request_id
    and request.status in ('open', 'in_review', 'on_hold')
    and (p_expected_row_version is null or request.row_version = p_expected_row_version)
  for update;

  if not found then
    return jsonb_build_object(
      'change_request_id', p_change_request_id,
      'outcome', 'not_eligible'
    );
  end if;
  previous_status := request_record.status;

  if request_record.request_type = 'parking_fee_setup' then
    evaluation_kind := 'parking_fee_setup';
    parking_unit_id := coalesce(
      nullif(request_record.proposed_payload ->> 'parking_lease_contract_unit_id', '')::uuid,
      (
        select item.entity_id
        from public.change_request_item item
        where item.change_request_id = request_record.change_request_id
          and item.entity_type = 'parking_fee_history'
        order by item.sort_order, item.created_at
        limit 1
      )
    );
    field_state := private.parking_fee_setup_state(parking_unit_id);
    supported := coalesce((field_state ->> 'supported')::boolean, false);
    if supported then
      resolved := coalesce((field_state ->> 'resolved')::boolean, false);
      validation_message := field_state ->> 'validation_message';
      current_state := field_state -> 'current_state';

      update public.change_request_item item
      set current_value = current_state,
          proposed_value = case when resolved then current_state -> 'monthly_parking_fee' else item.proposed_value end,
          validation_status = case when resolved then 'valid' else 'pending' end,
          validation_message = case when resolved then null else validation_message end
      where item.change_request_id = request_record.change_request_id
        and item.entity_type = 'parking_fee_history';

      if not resolved then
        update public.change_request request
        set title = concat('駐車料設定: ', field_state ->> 'property_name', ' ', field_state ->> 'space_number'),
            summary = concat(field_state ->> 'tenant_name', 'の', validation_message),
            proposed_payload = request.proposed_payload || jsonb_strip_nulls(jsonb_build_object(
              'parking_lease_contract_unit_id', field_state -> 'lease_contract_unit_id',
              'parking_lease_contract_id', field_state -> 'lease_contract_id',
              'property_id', field_state -> 'property_id',
              'property_name', field_state -> 'property_name',
              'tenant_id', field_state -> 'tenant_id',
              'tenant_name', field_state -> 'tenant_name',
              'space_number', field_state -> 'space_number',
              'parking_scope', field_state -> 'parking_scope',
              'contract_start_date', field_state -> 'lease_start_date',
              'contract_end_date', field_state -> 'lease_end_date'
            ))
        where request.change_request_id = request_record.change_request_id
        returning * into request_record;
      end if;
    end if;
  elsif request_record.source_type = 'initial_import'
     and request_record.request_type = 'rent_roll_correction'
     and exists (
       select 1
       from public.change_request_item item
       join public.rent_roll_import_issue issue
         on issue.rent_roll_import_issue_id = item.rent_roll_import_issue_id
       where item.change_request_id = request_record.change_request_id
         and issue.issue_type = 'multiple_tenant_codes'
     ) then
    evaluation_kind := 'tenant_billing_codes';
    target_tenant_id := nullif(request_record.proposed_payload ->> 'tenant_id', '')::uuid;
    supported := target_tenant_id is not null;
    if supported then
      resolved := (
        select count(*)
        from public.change_request_item item
        join public.rent_roll_import_issue issue
          on issue.rent_roll_import_issue_id = item.rent_roll_import_issue_id
        cross join lateral regexp_split_to_table(
          coalesce(issue.source_payload ->> 'tenant_code', ''), E'[\n/]+'
        ) part
        where item.change_request_id = request_record.change_request_id
          and issue.issue_type = 'multiple_tenant_codes'
          and regexp_replace(btrim(part), '[[:space:]　]+', '', 'g') <> ''
      ) >= 2 and not exists (
        select 1
        from public.change_request_item item
        join public.rent_roll_import_issue issue
          on issue.rent_roll_import_issue_id = item.rent_roll_import_issue_id
        cross join lateral regexp_split_to_table(
          coalesce(issue.source_payload ->> 'tenant_code', ''), E'[\n/]+'
        ) part
        where item.change_request_id = request_record.change_request_id
          and issue.issue_type = 'multiple_tenant_codes'
          and regexp_replace(btrim(part), '[[:space:]　]+', '', 'g') <> ''
          and not exists (
            select 1
            from public.tenant_billing_code code
            where code.tenant_id = target_tenant_id
              and code.is_active
              and code.billing_code = regexp_replace(btrim(part), '[[:space:]　]+', '', 'g')
          )
      ) and exists (
        select 1 from public.tenant_billing_code code
        where code.tenant_id = target_tenant_id and code.is_active and code.is_primary
      ) and not exists (
        select 1
        from public.income_expense_account_master account
        where account.income_expense_type = '収入'
          and not exists (
            select 1
            from public.tenant_billing_code_account assignment
            join public.tenant_billing_code code
              on code.tenant_billing_code_id = assignment.tenant_billing_code_id
             and code.tenant_id = assignment.tenant_id
            where assignment.tenant_id = target_tenant_id
              and assignment.account_id = account.account_id
              and code.is_active
          )
      );

      select jsonb_build_object(
        'tenant_id', target_tenant_id,
        'billing_codes', coalesce(jsonb_agg(jsonb_build_object(
          'billing_code', code.billing_code,
          'is_primary', code.is_primary,
          'is_active', code.is_active
        ) order by code.sort_order, code.billing_code), '[]'::jsonb)
      )
      into current_state
      from public.tenant_billing_code code
      where code.tenant_id = target_tenant_id;

      update public.change_request_item item
      set current_value = current_state,
          validation_status = case when resolved then 'valid' else 'pending' end,
          validation_message = case when resolved then null else '必要なテナントコードまたは収入科目割当が未設定です' end
      where item.change_request_id = request_record.change_request_id;
    end if;
  elsif request_record.request_type in ('contract_update', 'contract_cancellation_review', 'rent_roll_correction') then
    evaluation_kind := 'contract_fields';
    resolved := true;

    if jsonb_typeof(request_record.proposed_payload -> 'operations') = 'array'
       and jsonb_array_length(request_record.proposed_payload -> 'operations') > 0 then
      supported := true;
      for operation in
        select value from jsonb_array_elements(request_record.proposed_payload -> 'operations')
      loop
        check_count := check_count + 1;
        if operation ->> 'action' = 'set_field' then
          field_state := private.change_request_field_state(
            operation ->> 'entity_type',
            coalesce(nullif(operation ->> 'entity_id', '')::uuid, request_record.lease_contract_id),
            operation ->> 'field_name'
          );
          if not coalesce((field_state ->> 'supported')::boolean, false)
             or not coalesce((field_state ->> 'found')::boolean, false) then
            resolved := false;
          elsif not private.change_request_values_equal(
            operation ->> 'field_name', field_state -> 'value', operation -> 'value'
          ) then
            resolved := false;
          end if;
        elsif operation ->> 'action' = 'link_unit' then
          -- 区画追加は金額・期間を含む複合操作なので、存在だけでは完了扱いにしない。
          supported := false;
          resolved := false;
        elsif operation ->> 'action' = 'unlink_unit' then
          if not exists (
            select 1 from public.lease_contract_unit contract_unit
            where contract_unit.lease_contract_id = request_record.lease_contract_id
              and contract_unit.lease_contract_unit_id = nullif(operation ->> 'entity_id', '')::uuid
              and contract_unit.lease_end_date = nullif(operation #>> '{value,effective_date}', '')::date - 1
          ) then resolved := false; end if;
        else
          supported := false;
          resolved := false;
        end if;
      end loop;
    else
      for item_record in
        select item.*
        from public.change_request_item item
        where item.change_request_id = request_record.change_request_id
          and item.entity_type in ('lease_contract', 'lease_contract_unit')
          and item.entity_id is not null
          and item.field_name is not null
        order by item.sort_order, item.created_at
      loop
        supported := true;
        check_count := check_count + 1;
        field_state := private.change_request_field_state(
          item_record.entity_type, item_record.entity_id, item_record.field_name
        );
        update public.change_request_item item
        set current_value = field_state -> 'value'
        where item.change_request_item_id = item_record.change_request_item_id;
        if not coalesce((field_state ->> 'supported')::boolean, false)
           or not coalesce((field_state ->> 'found')::boolean, false)
           or not private.change_request_values_equal(
             item_record.field_name, field_state -> 'value', item_record.proposed_value
           ) then
          resolved := false;
        end if;
      end loop;
    end if;
    supported := supported and check_count > 0;
    current_state := jsonb_build_object('checked_field_count', check_count);
  end if;

  if not supported then
    return jsonb_build_object(
      'change_request_id', request_record.change_request_id,
      'status', request_record.status,
      'outcome', 'skipped',
      'evaluation_kind', coalesce(evaluation_kind, 'unsupported')
    );
  end if;

  if not resolved then
    if evaluation_kind <> 'parking_fee_setup' then
      update public.change_request request
      set updated_at = now()
      where request.change_request_id = request_record.change_request_id
      returning * into request_record;
    end if;
    return jsonb_build_object(
      'change_request_id', request_record.change_request_id,
      'status', request_record.status,
      'outcome', 'open',
      'evaluation_kind', evaluation_kind
    );
  end if;

  update public.change_request_item item
  set validation_status = 'valid', validation_message = null
  where item.change_request_id = request_record.change_request_id;

  update public.rent_roll_import_issue issue
  set resolved_at = now(), resolved_by = auth.uid()
  where issue.resolved_at is null
    and issue.rent_roll_import_issue_id in (
      select item.rent_roll_import_issue_id
      from public.change_request_item item
      where item.change_request_id = request_record.change_request_id
        and item.rent_roll_import_issue_id is not null
    );

  update public.change_request request
  set status = 'applied',
      resolution_payload = request.resolution_payload || jsonb_build_object(
        'reason', 'current_business_data_recheck',
        'evaluation_kind', evaluation_kind,
        'current_state', current_state
      ),
      resolved_at = coalesce(request.resolved_at, now()),
      resolved_by = coalesce(request.resolved_by, auth.uid()),
      applied_at = now(),
      applied_by = auth.uid()
  where request.change_request_id = request_record.change_request_id
  returning * into request_record;

  insert into public.change_request_action_log(
    change_request_id, action_type, previous_status, next_status, details, performed_by
  ) values (
    request_record.change_request_id, 'applied', previous_status, 'applied',
    jsonb_build_object(
      'reason', 'current_business_data_recheck',
      'evaluation_kind', evaluation_kind,
      'current_state', current_state
    ), auth.uid()
  );

  return jsonb_build_object(
    'change_request_id', request_record.change_request_id,
    'status', request_record.status,
    'outcome', 'applied',
    'evaluation_kind', evaluation_kind
  );
end;
$$;

revoke all on function private.recheck_change_request_internal(uuid, integer) from public, anon;
grant execute on function private.recheck_change_request_internal(uuid, integer) to authenticated;

create or replace function public.recheck_change_request(
  p_change_request_id uuid,
  p_expected_row_version integer default null
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.recheck_change_request_internal(
    p_change_request_id,
    p_expected_row_version
  );
$$;

revoke all on function public.recheck_change_request(uuid, integer) from public, anon;
grant execute on function public.recheck_change_request(uuid, integer) to authenticated;

create or replace function public.recheck_open_change_requests()
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  target record;
  result jsonb;
  checked_count integer := 0;
  applied_count integer := 0;
  open_count integer := 0;
  skipped_count integer := 0;
begin
  if auth.uid() is null or not (select public.current_account_is_active()) then
    raise exception '有効なアカウントが必要です';
  end if;
  for target in
    select request.change_request_id, request.row_version
    from public.change_request request
    where request.status in ('open', 'in_review', 'on_hold')
    order by request.updated_at desc, request.change_request_id
  loop
    result := private.recheck_change_request_internal(
      target.change_request_id, target.row_version
    );
    checked_count := checked_count + 1;
    case result ->> 'outcome'
      when 'applied' then applied_count := applied_count + 1;
      when 'open' then open_count := open_count + 1;
      else skipped_count := skipped_count + 1;
    end case;
  end loop;
  return jsonb_build_object(
    'checked_count', checked_count,
    'applied_count', applied_count,
    'open_count', open_count,
    'skipped_count', skipped_count
  );
end;
$$;

revoke all on function public.recheck_open_change_requests() from public, anon;
grant execute on function public.recheck_open_change_requests() to authenticated;

-- 新規作成時も再チェック時と同じ駐車場判定を使用する。
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
begin
  if auth.uid() is not null and (
    not (select public.current_account_is_active())
    or (select public.current_account_role()) not in ('admin', 'manager')
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
      concat('駐車料設定: ', state ->> 'property_name', ' ', state ->> 'space_number'),
      concat(state ->> 'tenant_name', 'の', state ->> 'validation_message'),
      jsonb_strip_nulls(jsonb_build_object(
        'source_file_name', source_file_name,
        'source_sheet_name', source_sheet_name,
        'source_row_number', source_row_number
      )),
      jsonb_strip_nulls(jsonb_build_object(
        'parking_lease_contract_unit_id', state -> 'lease_contract_unit_id',
        'parking_lease_contract_id', state -> 'lease_contract_id',
        'property_id', state -> 'property_id',
        'property_name', state -> 'property_name',
        'tenant_id', state -> 'tenant_id',
        'tenant_name', state -> 'tenant_name',
        'space_number', state -> 'space_number',
        'parking_scope', state -> 'parking_scope',
        'main_lease_contract_id', state -> 'main_lease_contract_id',
        'contract_start_date', state -> 'lease_start_date',
        'contract_end_date', state -> 'lease_end_date'
      )),
      nullif(state ->> 'lease_contract_id', '')::uuid
    ) returning change_request_id into request_id;

    insert into public.change_request_item (
      change_request_id, entity_type, entity_id, field_name,
      current_value, proposed_value, validation_status, validation_message
    ) values (
      request_id, 'parking_fee_history', p_parking_lease_contract_unit_id,
      'monthly_parking_fee', state -> 'current_state', null, 'pending',
      state ->> 'validation_message'
    );
  else
    update public.change_request request
    set title = concat('駐車料設定: ', state ->> 'property_name', ' ', state ->> 'space_number'),
        summary = concat(state ->> 'tenant_name', 'の', state ->> 'validation_message'),
        proposed_payload = request.proposed_payload || jsonb_strip_nulls(jsonb_build_object(
          'property_name', state -> 'property_name',
          'tenant_name', state -> 'tenant_name',
          'parking_scope', state -> 'parking_scope',
          'contract_start_date', state -> 'lease_start_date',
          'contract_end_date', state -> 'lease_end_date'
        ))
    where request.change_request_id = request_id;
    update public.change_request_item item
    set current_value = state -> 'current_state',
        validation_status = 'pending',
        validation_message = state ->> 'validation_message'
    where item.change_request_id = request_id
      and item.entity_type = 'parking_fee_history';
  end if;
  return request_id;
end;
$$;

revoke all on function public.enqueue_parking_fee_change_request(uuid, uuid, uuid)
  from public, anon;
grant execute on function public.enqueue_parking_fee_change_request(uuid, uuid, uuid)
  to authenticated;

-- 駐車料履歴が他画面から登録された場合も、共通判定で不足項目を再確認する。
create or replace function private.close_parking_fee_change_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target record;
begin
  if auth.uid() is null
     or not (select public.current_account_is_active())
     or (select public.current_account_role()) not in ('admin', 'manager') then
    raise exception '駐車料対応依頼の確定は管理者またはマネージャーだけが実行できます';
  end if;
  for target in
    select request.change_request_id, request.row_version
    from public.change_request request
    where request.source_type = 'manual'
      and request.source_record_key = concat('parking-fee:', new.parking_lease_contract_unit_id)
      and request.request_type = 'parking_fee_setup'
      and request.status in ('open', 'in_review', 'on_hold')
    order by request.created_at
  loop
    perform private.recheck_change_request_internal(
      target.change_request_id, target.row_version
    );
  end loop;
  return new;
end;
$$;

revoke all on function private.close_parking_fee_change_request() from public, anon, authenticated;

-- レントロール等から契約正本が変わったら、同じ契約・区画を指す未解決依頼だけを再評価する。
create or replace function private.recheck_contract_change_requests_after_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target record;
  target_contract_id uuid;
  target_entity_id uuid;
  target_entity_type text;
begin
  if auth.uid() is null or not (select public.current_account_is_active()) then
    return new;
  end if;
  if tg_table_name = 'lease_contract' then
    target_contract_id := new.lease_contract_id;
    target_entity_id := new.lease_contract_id;
    target_entity_type := 'lease_contract';
  else
    target_contract_id := new.lease_contract_id;
    target_entity_id := new.lease_contract_unit_id;
    target_entity_type := 'lease_contract_unit';
  end if;

  for target in
    select distinct request.change_request_id, request.row_version
    from public.change_request request
    left join public.change_request_item item
      on item.change_request_id = request.change_request_id
    where request.status in ('open', 'in_review', 'on_hold')
      and (
        (item.entity_type = target_entity_type and item.entity_id = target_entity_id)
        or request.lease_contract_id = target_contract_id
      )
    order by request.change_request_id, request.row_version
  loop
    perform private.recheck_change_request_internal(
      target.change_request_id, target.row_version
    );
  end loop;
  return new;
end;
$$;

revoke all on function private.recheck_contract_change_requests_after_update()
  from public, anon, authenticated;

drop trigger if exists recheck_change_requests_after_contract_update on public.lease_contract;
create constraint trigger recheck_change_requests_after_contract_update
after update on public.lease_contract
deferrable initially deferred
for each row execute function private.recheck_contract_change_requests_after_update();

drop trigger if exists recheck_change_requests_after_contract_unit_update on public.lease_contract_unit;
create constraint trigger recheck_change_requests_after_contract_unit_update
after update on public.lease_contract_unit
deferrable initially deferred
for each row execute function private.recheck_contract_change_requests_after_update();

-- テナントコードページは保存の最後に主コードを tenant_master へ反映するため、
-- その時点で全コード・科目割当が揃ったかを共通判定する。
create or replace function private.recheck_tenant_billing_requests_after_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target record;
begin
  if auth.uid() is null or not (select public.current_account_is_active()) then
    return new;
  end if;
  for target in
    select request.change_request_id, request.row_version
    from public.change_request request
    where request.status in ('open', 'in_review', 'on_hold')
      and request.source_type = 'initial_import'
      and request.request_type = 'rent_roll_correction'
      and request.proposed_payload ->> 'tenant_id' = new.tenant_id::text
    order by request.created_at
  loop
    perform private.recheck_change_request_internal(
      target.change_request_id, target.row_version
    );
  end loop;
  return new;
end;
$$;

revoke all on function private.recheck_tenant_billing_requests_after_update()
  from public, anon, authenticated;

drop trigger if exists recheck_tenant_billing_requests_after_update on public.tenant_master;
create trigger recheck_tenant_billing_requests_after_update
after update of external_tenant_code on public.tenant_master
for each row execute function private.recheck_tenant_billing_requests_after_update();

comment on function public.recheck_change_request(uuid, integer)
is '対応依頼を現在の契約・駐車料・テナントコードから再評価し、解消済みなら履歴を残して確定済みにする。';
comment on function public.recheck_open_change_requests()
is '未解決の対応依頼を一括再評価し、解消・継続・対象外の件数を返す。';
