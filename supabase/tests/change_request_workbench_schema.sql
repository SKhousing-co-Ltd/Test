begin;

do $$
declare
  v_request_id uuid;
  v_item_id uuid;
  v_version integer;
begin
  insert into public.change_request (
    source_type, source_record_key, request_type, title, source_payload, proposed_payload
  ) values (
    'initial_import', 'test-row-1', 'rent_roll_correction', 'Test import correction',
    '{"source_row": 1}'::jsonb, '{"monthly_rent_amount": 120000}'::jsonb
  ) returning change_request_id, row_version into v_request_id, v_version;

  insert into public.change_request_item (
    change_request_id, entity_type, field_name, current_value, proposed_value, validation_status
  ) values (
    v_request_id, 'lease_contract_unit', 'monthly_rent_amount', '100000'::jsonb, '120000'::jsonb, 'valid'
  ) returning change_request_item_id into v_item_id;

  if not exists (select 1 from public.change_request_action_log where change_request_id = v_request_id and action_type = 'created') then
    raise exception 'Change request creation must be audited';
  end if;

  update public.change_request set summary = 'Edited test request' where change_request_id = v_request_id;
  if (select row_version from public.change_request where change_request_id = v_request_id) <> v_version + 1 then
    raise exception 'Change request row version must increase on update';
  end if;

  begin
    insert into public.change_request (source_type, request_type, title, proposed_payload)
    values ('manual', 'other', 'Invalid payload', '[]'::jsonb);
    raise exception 'Array payload should fail validation';
  exception when check_violation then
    null;
  end;

  if (select updated_at from public.change_request_item where change_request_item_id = v_item_id) is null then
    raise exception 'Change request item must have timestamps';
  end if;
end;
$$;

rollback;
