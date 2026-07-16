begin;

insert into public.property_master (property_name)
values ('契約管理テスト物件')
on conflict (property_name) do nothing;

do $$
declare
  property_uuid uuid;
  unit_a uuid;
  unit_b uuid;
  tenant_uuid uuid;
  first_contract uuid;
  second_contract uuid;
begin
  select property_id into property_uuid from public.property_master where property_name = '契約管理テスト物件';

  insert into public.unit_master (property_id, unit_code, floor_label, unit_type, rentable_area_sqm)
  values (property_uuid, '101', '1F', 'office', 100.00)
  returning unit_id into unit_a;
  insert into public.unit_master (property_id, unit_code, floor_label, unit_type, rentable_area_sqm)
  values (property_uuid, '倉庫1', 'B1F', 'storage', 10.00)
  returning unit_id into unit_b;
  insert into public.tenant_master (external_tenant_code, tenant_name, normalized_tenant_name)
  values ('TEST-001', 'テストテナント', 'テストテナント')
  returning tenant_id into tenant_uuid;

  insert into public.lease_contract (tenant_id, contract_status, contract_start_date, contract_end_date)
  values (tenant_uuid, 'terminated', date '2024-01-01', date '2024-12-31')
  returning lease_contract_id into first_contract;
  insert into public.lease_contract_unit (lease_contract_id, unit_id, monthly_rent_amount, monthly_common_charge_amount)
  values
    (first_contract, unit_a, 100000, 10000),
    (first_contract, unit_b, 10000, 0);

  insert into public.lease_contract (tenant_id, contract_status, contract_start_date)
  values (tenant_uuid, 'active', date '2025-01-01')
  returning lease_contract_id into second_contract;
  insert into public.lease_contract_unit (lease_contract_id, unit_id, monthly_rent_amount, monthly_common_charge_amount)
  values (second_contract, unit_a, 110000, 11000);

  if (select monthly_total_amount from public.lease_contract_unit where lease_contract_id = second_contract and unit_id = unit_a) <> 121000 then
    raise exception '月額合計が正しく計算されていません';
  end if;
  if not (select is_occupied from public.unit_current_lease_status where unit_id = unit_a) then
    raise exception '有効な契約を持つ区画が入居中になっていません';
  end if;
  if (select is_occupied from public.unit_current_lease_status where unit_id = unit_b) then
    raise exception '終了契約だけの区画が入居中になっています';
  end if;
end $$;

rollback;
