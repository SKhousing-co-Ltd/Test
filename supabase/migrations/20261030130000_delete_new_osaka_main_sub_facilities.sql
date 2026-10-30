do $$
declare
  v_property_id uuid;
  v_property_count integer;
  target record;
  v_facility_count integer;
  v_space_count integer;
  v_batch_count integer;
  v_batch_status text;
  v_committed_at timestamptz;
  v_committed_row_count integer;
  v_fee_history_count integer;
  v_deleted_count integer;
begin
  select count(*), min(a.asset_id::text)::uuid
    into v_property_count, v_property_id
  from public.asset_master a
  where a.asset_name = U&'\4E09\5171\65B0\5927\962A\30D3\30EB';

  if v_property_count > 1 then
    raise exception '三共新大阪ビルのアセットが一意ではありません';
  end if;

  if v_property_count = 1 then
    select count(*) into v_facility_count
    from public.parking_facility_master f
    where f.property_id = v_property_id
      and f.facility_code in ('MAIN', 'SUB');

    if v_facility_count = 1 then
      raise exception 'MAIN/SUB施設が両方そろっていません';
    end if;

    for target in
      select f.parking_facility_id, f.facility_code
      from public.parking_facility_master f
      where f.property_id = v_property_id
        and f.facility_code in ('MAIN', 'SUB')
      order by f.facility_code
    loop
    select count(*) into v_space_count
    from public.parking_space_master s
    where s.parking_facility_id = target.parking_facility_id;

    if v_space_count <> 0 then
      raise exception '台帳区画が存在するため削除を中止します: %', target.facility_code;
    end if;

    select count(*), min(b.status), min(b.committed_at)
      into v_batch_count, v_batch_status, v_committed_at
    from public.parking_import_batch b
    where b.parking_facility_id = target.parking_facility_id;

    if v_batch_count <> 1 then
      raise exception '取込バッチ件数が想定と異なります: %', target.facility_code;
    end if;

    if (target.facility_code = 'MAIN' and v_batch_status <> 'cancelled')
       or (target.facility_code = 'SUB' and v_batch_status <> 'draft')
       or v_committed_at is not null then
      raise exception '取込バッチ状態が想定と異なります: %', target.facility_code;
    end if;

    select count(*) into v_committed_row_count
    from public.parking_import_row r
    join public.parking_import_batch b using (parking_import_batch_id)
    where b.parking_facility_id = target.parking_facility_id
      and (r.committed_unit_id is not null
        or r.committed_lease_contract_id is not null
        or r.committed_lease_contract_unit_id is not null);

    if v_committed_row_count <> 0 then
      raise exception '確定済み取込行が存在するため削除を中止します: %', target.facility_code;
    end if;

    select count(*) into v_fee_history_count
    from public.parking_fee_history h
    join public.parking_import_batch b
      on b.parking_import_batch_id = h.source_import_batch_id
    where b.parking_facility_id = target.parking_facility_id;

    if v_fee_history_count <> 0 then
      raise exception '駐車料履歴が取込バッチを参照しているため削除を中止します: %', target.facility_code;
    end if;

    delete from public.parking_import_batch b
    where b.parking_facility_id = target.parking_facility_id;

    delete from public.parking_facility_master f
    where f.parking_facility_id = target.parking_facility_id;

    get diagnostics v_deleted_count = row_count;
    if v_deleted_count <> 1 then
      raise exception '施設削除件数が想定と異なります: %', target.facility_code;
    end if;
    end loop;
  end if;
end;
$$;
