-- 福岡ビルの契約台帳で「1F B」として誤作成された区画を既存の1F/Bへ統合する。
do $$
declare
  v_property_id uuid;
  v_duplicate_unit_id uuid;
  v_canonical_unit_id uuid;
  v_lease_contract_unit_id uuid;
  v_lease_contract_id uuid;
  v_updated integer;
  v_deleted integer;
begin
  select asset_id
    into strict v_property_id
    from public.asset_master
   where asset_name = '三共福岡ビル';

  select unit_id
    into strict v_duplicate_unit_id
    from public.unit_master
   where property_id = v_property_id
     and unit_code = '1F B'
     and floor_label is null
     and unit_type = 'office'
     and is_active;

  select unit_id
    into strict v_canonical_unit_id
    from public.unit_master
   where property_id = v_property_id
     and unit_code = 'B'
     and floor_label = '1F'
     and unit_type = 'office'
     and is_active;

  select lcu.lease_contract_unit_id, c.lease_contract_id
    into strict v_lease_contract_unit_id, v_lease_contract_id
    from public.lease_contract_unit lcu
    join public.lease_contract c on c.lease_contract_id = lcu.lease_contract_id
    join public.tenant_master t on t.tenant_id = c.tenant_id
   where lcu.unit_id = v_duplicate_unit_id
     and c.contract_status = 'active'
     and c.contract_type = 'ordinary_lease'
     and c.contract_start_date = date '2025-07-01'
     and lcu.monthly_rent_amount = 1118005
     and lcu.deposit_amount = 11180050
     and t.tenant_name = '(株)アースコーポレーション';

  if exists (
    select 1 from public.lease_contract_unit
     where lease_contract_id = v_lease_contract_id
       and unit_id = v_canonical_unit_id
  ) then
    raise exception '1F/Bに同一契約の区画紐付けがすでにあります';
  end if;

  if exists (select 1 from public.asset_meter_unit_assignment where unit_id = v_duplicate_unit_id)
     or exists (select 1 from public.meter_reading_contract_unit where unit_id = v_duplicate_unit_id)
     or exists (select 1 from public.parking_import_row where committed_unit_id = v_duplicate_unit_id)
     or exists (select 1 from public.parking_space_master where unit_id = v_duplicate_unit_id)
     or exists (select 1 from public.rent_roll_snapshot_parking_allocation where unit_id = v_duplicate_unit_id)
     or exists (select 1 from public.unit_leasing_status where unit_id = v_duplicate_unit_id)
     or exists (select 1 from public.unit_lineage where source_unit_id = v_duplicate_unit_id or target_unit_id = v_duplicate_unit_id)
     or exists (select 1 from public.unit_plan_geometry where unit_id = v_duplicate_unit_id) then
    raise exception '誤作成された1F B区画に他の関連データがあるため統合を中止します';
  end if;

  update public.lease_contract_unit
     set unit_id = v_canonical_unit_id,
         updated_at = now()
   where lease_contract_unit_id = v_lease_contract_unit_id;
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    raise exception '契約区画の付け替え件数が想定と異なります: %', v_updated;
  end if;

  update public.lease_contract
     set lease_term_type = 'ordinary', updated_at = now()
   where lease_contract_id = v_lease_contract_id
     and contract_type = 'ordinary_lease'
     and lease_term_type is null;
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    raise exception '普通賃貸借の契約期間種別を更新できませんでした';
  end if;

  delete from public.unit_master
   where unit_id = v_duplicate_unit_id;
  get diagnostics v_deleted = row_count;
  if v_deleted <> 1 then
    raise exception '誤作成された区画レコードを統合できませんでした';
  end if;
end;
$$;
