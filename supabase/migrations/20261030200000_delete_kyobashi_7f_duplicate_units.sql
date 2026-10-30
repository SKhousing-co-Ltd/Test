-- Remove only the duplicate 7F 7-A / 7-B records in 三共京橋ビル.
-- The valid 7F A / B units are checked and left untouched.
do $$
declare
  v_asset_id uuid;
  v_unit_ids uuid[];
  v_unit_7a uuid;
  v_unit_7b uuid;
  v_contract_id uuid;
  v_contract_unit_id uuid;
  v_count integer;
  v_fk record;
  v_has_reference boolean;
begin
  select asset_id into strict v_asset_id
  from public.asset_master
  where asset_name = '三共京橋ビル';

  select array_agg(unit_id order by unit_code), count(*)
  into v_unit_ids, v_count
  from public.unit_master
  where property_id = v_asset_id
    and floor_label = '7F'
    and unit_code in ('7-A', '7-B')
    and unit_type = 'office'
    and is_active;

  if v_count = 0 then
    return; -- Already removed.
  elsif v_count <> 2 then
    raise exception '三共京橋ビル7Fの重複候補が2件ではありません: %', v_count;
  end if;

  select unit_id into strict v_unit_7a
  from public.unit_master
  where property_id = v_asset_id and floor_label = '7F'
    and unit_code = '7-A' and unit_type = 'office' and is_active;

  select unit_id into strict v_unit_7b
  from public.unit_master
  where property_id = v_asset_id and floor_label = '7F'
    and unit_code = '7-B' and unit_type = 'office' and is_active;

  if v_unit_7a = v_unit_7b or not exists (
    select 1 from public.unit_master
    where property_id = v_asset_id and floor_label = '7'
      and unit_code = 'A' and is_active
  ) or not exists (
    select 1 from public.unit_master
    where property_id = v_asset_id and floor_label = '7'
      and unit_code = 'B' and is_active
  ) then
    raise exception '正規の三共京橋ビル7階A/Bの存在を確認できません';
  end if;

  -- 7-A is known to have exactly one demo draft contract; 7-B has none.
  select count(*) into v_count
  from public.lease_contract_unit lcu
  where lcu.unit_id = v_unit_7a;
  if v_count <> 1 then
    raise exception '7F 7-Aの契約区画件数が想定外です: %', v_count;
  end if;

  select lcu.lease_contract_id, lcu.lease_contract_unit_id
  into strict v_contract_id, v_contract_unit_id
  from public.lease_contract_unit lcu
  join public.lease_contract lc using (lease_contract_id)
  where lcu.unit_id = v_unit_7a
    and lc.contract_status = 'draft'
    and lc.source_system = 'demo'
    and lc.source_record_key = 'ordinary-lease-7-a'
    and lc.contract_start_date = date '2026-08-01'
    and lc.contract_end_date = date '2028-07-31';

  if exists (select 1 from public.lease_contract_unit where unit_id = v_unit_7b) then
    raise exception '7F 7-Bに契約区画が追加されています';
  end if;

  if (select count(*) from public.lease_contract_document
      where lease_contract_id = v_contract_id and document_type = 'ordinary_lease') <> 1 then
    raise exception '7F 7-Aの契約書データが想定外です';
  end if;

  if (select count(*) from public.unit_plan_geometry where unit_id = v_unit_7a) <> 1
     or (select count(*) from public.unit_plan_geometry where unit_id = v_unit_7b) <> 1
     or (select count(*) from public.unit_leasing_status where unit_id = v_unit_7a) <> 1
     or (select count(*) from public.unit_leasing_status where unit_id = v_unit_7b) <> 1 then
    raise exception '7F 7-A/7-Bの図面形状または入居状況件数が想定外です';
  end if;

  -- Refuse removal if additional records have been linked to either duplicate.
  for v_fk in
    select c.conrelid::regclass as table_name, a.attname as column_name,
           c.confrelid::regclass as target_table
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'f'
      and c.confrelid in (
        'public.unit_master'::regclass,
        'public.lease_contract_unit'::regclass,
        'public.lease_contract'::regclass
      )
      and cardinality(c.conkey) = 1
      and not (
        (c.confrelid = 'public.unit_master'::regclass
          and c.conrelid in ('public.unit_plan_geometry'::regclass,
                             'public.unit_leasing_status'::regclass,
                             'public.lease_contract_unit'::regclass))
        or (c.confrelid = 'public.lease_contract_unit'::regclass
          and c.conrelid = 'public.lease_contract_unit_term'::regclass)
        or (c.confrelid = 'public.lease_contract'::regclass
          and c.conrelid in ('public.lease_contract_unit'::regclass,
                             'public.lease_contract_document'::regclass))
      )
  loop
    if v_fk.target_table = 'public.unit_master'::regclass then
      execute format('select exists (select 1 from %s where %I = any($1))',
                     v_fk.table_name, v_fk.column_name)
        into v_has_reference using v_unit_ids;
    elsif v_fk.target_table = 'public.lease_contract_unit'::regclass then
      execute format('select exists (select 1 from %s where %I = $1)',
                     v_fk.table_name, v_fk.column_name)
        into v_has_reference using v_contract_unit_id;
    else
      execute format('select exists (select 1 from %s where %I = $1)',
                     v_fk.table_name, v_fk.column_name)
        into v_has_reference using v_contract_id;
    end if;

    if v_has_reference then
      raise exception '削除対象に想定外の関連データがあります: %.%',
        v_fk.table_name, v_fk.column_name;
    end if;
  end loop;

  delete from public.lease_contract
  where lease_contract_id = v_contract_id
    and contract_status = 'draft'
    and source_system = 'demo'
    and source_record_key = 'ordinary-lease-7-a';
  get diagnostics v_count = row_count;
  if v_count <> 1 then
    raise exception '7F 7-Aの下書き契約を削除できませんでした';
  end if;

  delete from public.unit_plan_geometry where unit_id = any(v_unit_ids);
  get diagnostics v_count = row_count;
  if v_count <> 2 then
    raise exception '図面形状の削除件数が想定外です: %', v_count;
  end if;

  delete from public.unit_leasing_status where unit_id = any(v_unit_ids);
  get diagnostics v_count = row_count;
  if v_count <> 2 then
    raise exception '入居状況の削除件数が想定外です: %', v_count;
  end if;

  delete from public.unit_master where unit_id = any(v_unit_ids);
  get diagnostics v_count = row_count;
  if v_count <> 2 then
    raise exception '重複区画の削除件数が想定外です: %', v_count;
  end if;
end;
$$;
