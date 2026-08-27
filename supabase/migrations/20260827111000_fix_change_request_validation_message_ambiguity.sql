-- Fix a PL/pgSQL variable/column name collision in parking fee rechecks.
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
  v_validation_message text;
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
      v_validation_message := field_state ->> 'validation_message';
      current_state := field_state -> 'current_state';

      update public.change_request_item item
      set current_value = current_state,
          proposed_value = case when resolved then current_state -> 'monthly_parking_fee' else item.proposed_value end,
          validation_status = case when resolved then 'valid' else 'pending' end,
          validation_message = case when resolved then null else v_validation_message end
      where item.change_request_id = request_record.change_request_id
        and item.entity_type = 'parking_fee_history';

      if not resolved then
        update public.change_request request
        set title = concat('駐車料設定: ', field_state ->> 'property_name', ' ', field_state ->> 'space_number'),
            summary = concat(field_state ->> 'tenant_name', 'の', v_validation_message),
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
