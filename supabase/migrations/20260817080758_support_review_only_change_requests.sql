-- Initial-import review requests can be completed without inventing a contract
-- field change. The review itself validates the linked import issue.
create or replace function public.apply_change_request(
  p_change_request_id uuid,
  p_expected_row_version integer
) returns public.change_request
language plpgsql security definer set search_path = public as $$
declare
  v_request public.change_request;
  v_item public.change_request_item;
  v_item_count integer := 0;
  v_domain_item_count integer := 0;
begin
  if not public.current_account_is_active() then
    raise exception 'Active account required';
  end if;

  select * into v_request
    from public.change_request
   where change_request_id = p_change_request_id
     and row_version = p_expected_row_version
     and status = 'resolved'
   for update;
  if not found then
    raise exception 'Only a resolved change request with the expected version can be applied';
  end if;

  for v_item in
    select * from public.change_request_item
     where change_request_id = p_change_request_id
     order by sort_order, created_at
  loop
    v_item_count := v_item_count + 1;

    -- A linked import issue represents a review target, not a domain-field
    -- update. Confirming the request validates it later in this transaction.
    if v_item.entity_type = 'rent_roll_import_issue' then
      continue;
    end if;

    if v_item.validation_status <> 'valid' then
      raise exception 'Every contract change item must be valid before applying';
    end if;
    if v_item.entity_type <> 'lease_contract_unit'
       or v_item.entity_id is null
       or v_item.field_name not in (
         'leased_area_sqm', 'monthly_rent_amount', 'monthly_common_charge_amount',
         'deposit_amount', 'security_deposit_amount', 'key_money_amount',
         'renewal_fee_amount', 'lease_start_date', 'lease_end_date'
       )
       or jsonb_typeof(v_item.proposed_value) not in ('number', 'string', 'null') then
      raise exception 'Unsupported change request item %', v_item.change_request_item_id;
    end if;

    perform 1 from public.lease_contract_unit
      where lease_contract_unit_id = v_item.entity_id for update;
    if not found then
      raise exception 'Lease contract unit % was not found', v_item.entity_id;
    end if;

    v_domain_item_count := v_domain_item_count + 1;
    if v_item.field_name = 'leased_area_sqm' then
      update public.lease_contract_unit set leased_area_sqm = (v_item.proposed_value #>> '{}')::numeric where lease_contract_unit_id = v_item.entity_id;
    elsif v_item.field_name = 'monthly_rent_amount' then
      update public.lease_contract_unit set monthly_rent_amount = (v_item.proposed_value #>> '{}')::numeric where lease_contract_unit_id = v_item.entity_id;
    elsif v_item.field_name = 'monthly_common_charge_amount' then
      update public.lease_contract_unit set monthly_common_charge_amount = (v_item.proposed_value #>> '{}')::numeric where lease_contract_unit_id = v_item.entity_id;
    elsif v_item.field_name = 'deposit_amount' then
      update public.lease_contract_unit set deposit_amount = (v_item.proposed_value #>> '{}')::numeric where lease_contract_unit_id = v_item.entity_id;
    elsif v_item.field_name = 'security_deposit_amount' then
      update public.lease_contract_unit set security_deposit_amount = (v_item.proposed_value #>> '{}')::numeric where lease_contract_unit_id = v_item.entity_id;
    elsif v_item.field_name = 'key_money_amount' then
      update public.lease_contract_unit set key_money_amount = (v_item.proposed_value #>> '{}')::numeric where lease_contract_unit_id = v_item.entity_id;
    elsif v_item.field_name = 'renewal_fee_amount' then
      update public.lease_contract_unit set renewal_fee_amount = (v_item.proposed_value #>> '{}')::numeric where lease_contract_unit_id = v_item.entity_id;
    elsif v_item.field_name = 'lease_start_date' then
      update public.lease_contract_unit set lease_start_date = (v_item.proposed_value #>> '{}')::date where lease_contract_unit_id = v_item.entity_id;
    elsif v_item.field_name = 'lease_end_date' then
      update public.lease_contract_unit set lease_end_date = (v_item.proposed_value #>> '{}')::date where lease_contract_unit_id = v_item.entity_id;
    end if;
  end loop;

  if v_item_count = 0 then
    raise exception 'A change request requires at least one item before applying';
  end if;
  if v_domain_item_count = 0 and not (
    v_request.source_type = 'initial_import'
    and v_request.request_type = 'rent_roll_correction'
    and not exists (
      select 1 from public.change_request_item
       where change_request_id = p_change_request_id
         and entity_type <> 'rent_roll_import_issue'
    )
  ) then
    raise exception 'A change request requires at least one supported rent-roll field change before applying';
  end if;

  update public.change_request_item
     set validation_status = 'valid', validation_message = null
   where change_request_id = p_change_request_id
     and entity_type = 'rent_roll_import_issue';

  update public.change_request
     set status = 'applied', applied_at = now(), applied_by = auth.uid()
   where change_request_id = p_change_request_id
  returning * into v_request;

  update public.rent_roll_import_issue as issue
     set resolved_at = now(), resolved_by = auth.uid()
   where issue.rent_roll_import_issue_id in (
     select item.rent_roll_import_issue_id
       from public.change_request_item as item
      where item.change_request_id = v_request.change_request_id
        and item.rent_roll_import_issue_id is not null
   ) and issue.resolved_at is null;

  insert into public.change_request_action_log(
    change_request_id, action_type, previous_status, next_status, details, performed_by
  ) values (
    v_request.change_request_id, 'applied', 'resolved', 'applied',
    jsonb_build_object('domain_item_count', v_domain_item_count), auth.uid()
  );
  return v_request;
end;
$$;

revoke all on function public.apply_change_request(uuid, integer) from public;
grant execute on function public.apply_change_request(uuid, integer) to authenticated;
