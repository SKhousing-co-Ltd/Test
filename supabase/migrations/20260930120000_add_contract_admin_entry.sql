-- 管理者・業務管理者向けの契約台帳登録API。
-- 契約本体、対象区画、テナントを1トランザクションで整備する。
create or replace function public.admin_upsert_lease_contract(p_payload jsonb)
returns table (lease_contract_id uuid, lease_contract_unit_id uuid)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_contract_id uuid := nullif(p_payload->>'lease_contract_id', '')::uuid;
  v_contract_unit_id uuid;
  v_property_id uuid := nullif(p_payload->>'property_id', '')::uuid;
  v_unit_id uuid := nullif(p_payload->>'unit_id', '')::uuid;
  v_tenant_id uuid := nullif(p_payload->>'tenant_id', '')::uuid;
  v_tenant_name text := nullif(trim(p_payload->>'tenant_name'), '');
  v_normalized_name text;
  v_unit_code text := nullif(trim(p_payload->>'unit_code'), '');
  v_unit_name text := nullif(trim(p_payload->>'unit_name'), '');
  v_unit_type text := coalesce(nullif(p_payload->>'unit_type', ''), 'other');
  v_source_system text := coalesce(nullif(p_payload->>'source_system', ''), 'manual');
  v_source_record_key text := nullif(trim(p_payload->>'source_record_key'), '');
begin
  if not public.current_account_is_active() or public.current_account_role() not in ('admin', 'manager') then
    raise exception '契約台帳を変更する権限がありません';
  end if;
  if v_property_id is null or v_unit_code is null or v_tenant_name is null then
    raise exception '物件、対象区画、契約先は必須です';
  end if;
  if v_unit_type not in ('office', 'retail', 'residential', 'storage', 'parking', 'equipment', 'other') then
    raise exception '対象区画種別が不正です';
  end if;
  v_normalized_name := lower(regexp_replace(trim(v_tenant_name), '[[:space:]]+', '', 'g'));

  if v_tenant_id is null then
    select tenant_master.tenant_id into v_tenant_id
      from public.tenant_master
      where normalized_tenant_name = v_normalized_name
      limit 1;
  end if;
  if v_tenant_id is null then
    insert into public.tenant_master(tenant_name, normalized_tenant_name)
    values (v_tenant_name, v_normalized_name)
    returning tenant_master.tenant_id into v_tenant_id;
  else
    update public.tenant_master
      set tenant_name = v_tenant_name, normalized_tenant_name = v_normalized_name, updated_at = now()
      where tenant_id = v_tenant_id;
  end if;

  if v_unit_id is null then
    select unit_master.unit_id into v_unit_id
      from public.unit_master
      where property_id = v_property_id and unit_code = v_unit_code and building_wing_id is null
      limit 1;
  end if;
  if v_unit_id is null then
    insert into public.unit_master(property_id, unit_code, unit_name, unit_type, rentable_area_sqm)
    values (v_property_id, v_unit_code, v_unit_name, v_unit_type, nullif(p_payload->>'leased_area_sqm', '')::numeric)
    returning unit_master.unit_id into v_unit_id;
  else
    update public.unit_master
      set unit_name = coalesce(v_unit_name, unit_name), unit_type = v_unit_type,
          rentable_area_sqm = coalesce(nullif(p_payload->>'leased_area_sqm', '')::numeric, rentable_area_sqm), updated_at = now()
      where unit_id = v_unit_id;
  end if;

  if v_contract_id is null then
    insert into public.lease_contract(tenant_id, contract_status, contract_type, contract_start_date, contract_end_date, renewal_terms, payment_terms, notes, source_system, source_record_key)
    values (v_tenant_id, coalesce(nullif(p_payload->>'contract_status', ''), 'active'), nullif(p_payload->>'contract_type', ''), nullif(p_payload->>'contract_start_date', '')::date, nullif(p_payload->>'contract_end_date', '')::date, nullif(p_payload->>'renewal_terms', ''), nullif(p_payload->>'payment_terms', ''), nullif(p_payload->>'notes', ''), v_source_system, v_source_record_key)
    returning lease_contract.lease_contract_id into v_contract_id;
  else
    update public.lease_contract
      set tenant_id = v_tenant_id, contract_status = coalesce(nullif(p_payload->>'contract_status', ''), contract_status), contract_type = nullif(p_payload->>'contract_type', ''), contract_start_date = nullif(p_payload->>'contract_start_date', '')::date, contract_end_date = nullif(p_payload->>'contract_end_date', '')::date, renewal_terms = nullif(p_payload->>'renewal_terms', ''), payment_terms = nullif(p_payload->>'payment_terms', ''), notes = nullif(p_payload->>'notes', ''), source_system = v_source_system, source_record_key = v_source_record_key, updated_at = now()
      where lease_contract.lease_contract_id = v_contract_id;
    if not found then raise exception '指定された契約が見つかりません'; end if;
  end if;

  select lease_contract_unit.lease_contract_unit_id into v_contract_unit_id
    from public.lease_contract_unit
    where lease_contract_id = v_contract_id and unit_id = v_unit_id;
  if v_contract_unit_id is null then
    insert into public.lease_contract_unit(lease_contract_id, unit_id, leased_area_sqm, monthly_rent_amount, monthly_common_charge_amount, deposit_amount, security_deposit_amount, key_money_amount, renewal_fee_amount)
    values (v_contract_id, v_unit_id, nullif(p_payload->>'leased_area_sqm', '')::numeric, nullif(p_payload->>'monthly_rent_amount', '')::numeric, nullif(p_payload->>'monthly_common_charge_amount', '')::numeric, nullif(p_payload->>'deposit_amount', '')::numeric, nullif(p_payload->>'security_deposit_amount', '')::numeric, nullif(p_payload->>'key_money_amount', '')::numeric, nullif(p_payload->>'renewal_fee_amount', '')::numeric)
    returning lease_contract_unit.lease_contract_unit_id into v_contract_unit_id;
  else
    update public.lease_contract_unit
      set leased_area_sqm = nullif(p_payload->>'leased_area_sqm', '')::numeric, monthly_rent_amount = nullif(p_payload->>'monthly_rent_amount', '')::numeric, monthly_common_charge_amount = nullif(p_payload->>'monthly_common_charge_amount', '')::numeric, deposit_amount = nullif(p_payload->>'deposit_amount', '')::numeric, security_deposit_amount = nullif(p_payload->>'security_deposit_amount', '')::numeric, key_money_amount = nullif(p_payload->>'key_money_amount', '')::numeric, renewal_fee_amount = nullif(p_payload->>'renewal_fee_amount', '')::numeric, updated_at = now()
      where lease_contract_unit_id = v_contract_unit_id;
  end if;
  return query select v_contract_id, v_contract_unit_id;
end;
$$;

revoke all on function public.admin_upsert_lease_contract(jsonb) from public, anon;
grant execute on function public.admin_upsert_lease_contract(jsonb) to authenticated;
