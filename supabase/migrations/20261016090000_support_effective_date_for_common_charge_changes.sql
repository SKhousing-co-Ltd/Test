create or replace function public.apply_change_request_with_terms(
  p_change_request_id uuid,
  p_expected_row_version integer
) returns public.change_request
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before public.change_request;
  v_result public.change_request;
  v_operation jsonb;
  v_unit_id uuid;
  v_effective_date date;
  v_amount_field text;
  v_new_amount numeric;
  v_old_term public.lease_contract_unit_term;
  v_unit public.lease_contract_unit;
begin
  select * into v_before
  from public.change_request
  where change_request_id = p_change_request_id
    and row_version = p_expected_row_version
    and status = 'resolved'
  for update;
  if not found then
    raise exception 'Only a resolved change request with the expected version can be applied';
  end if;

  if v_before.request_type in ('contract_update', 'contract_cancellation_review') then
    for v_operation in select value from jsonb_array_elements(v_before.proposed_payload -> 'operations') loop
      if v_operation ->> 'action' = 'set_field'
         and v_operation ->> 'entity_type' = 'lease_contract_unit'
         and v_operation ->> 'field_name' in ('monthly_rent_amount', 'monthly_common_charge_amount') then
        if nullif(v_operation ->> 'effective_date', '') is null then
          raise exception '賃料・共益費の変更には適用開始日が必要です';
        end if;
        v_effective_date := (v_operation ->> 'effective_date')::date;
        v_unit_id := (v_operation ->> 'entity_id')::uuid;
        select * into v_unit from public.lease_contract_unit where lease_contract_unit_id = v_unit_id for update;
        if not found then raise exception '変更対象の契約区画が見つかりません'; end if;
        if v_effective_date < coalesce(v_unit.lease_start_date, v_effective_date) then
          raise exception '適用開始日は契約区画の開始日以降にしてください';
        end if;
      end if;
    end loop;
  end if;

  select * into v_result from public.apply_change_request(p_change_request_id, p_expected_row_version);

  if v_before.request_type in ('contract_update', 'contract_cancellation_review') then
    for v_operation in select value from jsonb_array_elements(v_before.proposed_payload -> 'operations') loop
      v_amount_field := v_operation ->> 'field_name';
      if v_operation ->> 'action' = 'set_field'
         and v_operation ->> 'entity_type' = 'lease_contract_unit'
         and v_amount_field in ('monthly_rent_amount', 'monthly_common_charge_amount') then
        v_effective_date := (v_operation ->> 'effective_date')::date;
        v_unit_id := (v_operation ->> 'entity_id')::uuid;
        v_new_amount := nullif(v_operation ->> 'value', '')::numeric;
        select * into v_old_term
        from public.lease_contract_unit_term
        where lease_contract_unit_id = v_unit_id
          and effective_from <= v_effective_date
          and (effective_to is null or effective_to >= v_effective_date)
        order by effective_from desc
        limit 1
        for update;
        if not found then raise exception '変更前の契約条件履歴が見つかりません'; end if;

        if v_old_term.effective_from = v_effective_date then
          update public.lease_contract_unit_term
             set monthly_rent_amount = case when v_amount_field = 'monthly_rent_amount' then v_new_amount else monthly_rent_amount end,
                 monthly_common_charge_amount = case when v_amount_field = 'monthly_common_charge_amount' then v_new_amount else monthly_common_charge_amount end,
                 effective_to = null, updated_at = now()
           where lease_contract_unit_term_id = v_old_term.lease_contract_unit_term_id;
        else
          update public.lease_contract_unit_term
             set effective_to = v_effective_date - 1, updated_at = now()
           where lease_contract_unit_term_id = v_old_term.lease_contract_unit_term_id;
          select * into v_unit from public.lease_contract_unit where lease_contract_unit_id = v_unit_id;
          insert into public.lease_contract_unit_term(
            lease_contract_unit_id, lease_contract_amendment_id, effective_from, effective_to,
            monthly_rent_amount, monthly_common_charge_amount, deposit_amount,
            security_deposit_amount, key_money_amount, renewal_fee_amount
          ) values (
            v_unit_id, null, v_effective_date, null,
            case when v_amount_field = 'monthly_rent_amount' then v_new_amount else v_old_term.monthly_rent_amount end,
            case when v_amount_field = 'monthly_common_charge_amount' then v_new_amount else v_old_term.monthly_common_charge_amount end,
            v_old_term.deposit_amount, v_old_term.security_deposit_amount,
            v_old_term.key_money_amount, v_old_term.renewal_fee_amount
          );
        end if;
      end if;
    end loop;
  end if;
  return v_result;
end;
$$;

revoke all on function public.apply_change_request_with_terms(uuid, integer) from public, anon;
grant execute on function public.apply_change_request_with_terms(uuid, integer) to authenticated;
