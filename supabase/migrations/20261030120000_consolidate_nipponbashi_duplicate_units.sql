do $$
declare
  target record;
  asset_id uuid;
  asset_count integer;
  old_unit_id uuid;
  current_unit_id uuid;
  old_unit_count integer;
  current_unit_count integer;
  old_contract_count integer;
  current_contract_count integer;
  updated_count integer;
begin
  select count(*), min(a.asset_id::text)::uuid into asset_count, asset_id
  from public.asset_master a
  where a.asset_name = '三共日本橋ビル';

  if asset_count <> 1 then
    raise exception '三共日本橋ビルが一意ではありません';
  end if;

  for target in
    select * from (values
      ('5F'::text, '501'::text, '1417'::text),
      ('6F'::text, '601'::text, '1418'::text)
    ) as pairs(floor_label, unit_code, current_source_discriminator)
  loop
    select count(*), min(u.unit_id::text)::uuid into old_unit_count, old_unit_id
    from public.unit_master u
    where u.property_id = asset_id
      and u.floor_label = target.floor_label
      and u.unit_code = target.unit_code
      and u.source_discriminator = '1405';

    if old_unit_count = 0 then
      continue;
    end if;
    if old_unit_count <> 1 then
      raise exception '旧区画が一意ではありません: % %', target.floor_label, target.unit_code;
    end if;

    select count(*), min(u.unit_id::text)::uuid into current_unit_count, current_unit_id
    from public.unit_master u
    where u.property_id = asset_id
      and u.floor_label = target.floor_label
      and u.unit_code = target.unit_code
      and u.source_discriminator = target.current_source_discriminator;

    if current_unit_count <> 1 then
      raise exception '統合先区画が一意ではありません: % %', target.floor_label, target.unit_code;
    end if;

    select count(*) into current_contract_count
    from public.lease_contract_unit l
    where l.unit_id = current_unit_id
      and l.lease_start_date = date '2026-08-03'
      and l.lease_end_date is null;

    if current_contract_count <> 1 then
      raise exception '現在契約が一意ではありません: % %', target.floor_label, target.unit_code;
    end if;

    select count(*) into old_contract_count
    from public.lease_contract_unit l
    where l.unit_id = old_unit_id
      and l.lease_end_date = date '2026-08-02';

    if old_contract_count <> 1 or exists (
      select 1 from public.lease_contract_unit l
      where l.unit_id = old_unit_id
        and l.lease_end_date is distinct from date '2026-08-02'
    ) then
      raise exception '旧区画の契約履歴が想定と異なります: % %', target.floor_label, target.unit_code;
    end if;

    if exists (
      select 1
      from public.asset_meter_unit_assignment old_assignment
      join public.asset_meter_unit_assignment current_assignment
        on current_assignment.asset_meter_id = old_assignment.asset_meter_id
       and current_assignment.unit_id = current_unit_id
       and current_assignment.effective_from = old_assignment.effective_from
      where old_assignment.unit_id = old_unit_id
    ) then
      raise exception '統合先に重複するメーター割当があります: % %', target.floor_label, target.unit_code;
    end if;

    update public.lease_contract_unit
    set unit_id = current_unit_id,
        updated_at = now()
    where unit_id = old_unit_id;

    get diagnostics updated_count = row_count;
    if updated_count <> 1 then
      raise exception '旧契約履歴の統合件数が想定と異なります: % %', target.floor_label, target.unit_code;
    end if;

    update public.asset_meter_unit_assignment
    set unit_id = current_unit_id,
        updated_at = now()
    where unit_id = old_unit_id;

    delete from public.unit_master
    where unit_id = old_unit_id
      and property_id = asset_id;

    get diagnostics updated_count = row_count;
    if updated_count <> 1 then
      raise exception '重複区画の削除件数が想定と異なります: % %', target.floor_label, target.unit_code;
    end if;
  end loop;
end;
$$;
