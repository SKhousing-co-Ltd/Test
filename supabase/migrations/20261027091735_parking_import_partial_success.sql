do $$
declare
  v_definition text;
  v_old text;
  v_new text;
begin
  select pg_get_functiondef('public.commit_parking_import_without_fee(uuid)'::regprocedure)
    into v_definition;
  v_definition := replace(v_definition, E'\r\n', E'\n');

  v_old := $old$  committed_count integer := 0;
  row_status text;$old$;
  v_new := $new$  committed_count integer := 0;
  failed_count integer := 0;
  row_status text;$new$;
  if position(v_old in v_definition) = 0 then
    raise exception 'commit_parking_import_without_fee declaration changed; refusing partial-import patch';
  end if;
  v_definition := replace(v_definition, v_old, v_new);

  v_old := $old$  if exists (
    select 1 from public.parking_import_row r
    where r.parking_import_batch_id = p_batch_id
      and coalesce(
        nullif(trim(r.raw_payload->>'parking_status'), ''),
        case when coalesce((r.raw_payload->>'is_vacant')::boolean, false) then 'vacant' else 'occupied' end
      ) = 'occupied'
      and (r.matched_tenant_id is null or r.parking_scope is null
        or (r.parking_scope = 'internal' and r.main_lease_contract_id is null)
        or (r.parking_scope = 'external' and r.main_lease_contract_id is not null))
  ) then raise exception '契約中の行はテナント、内部・外部、主契約の選択を完了してください'; end if;
  if exists (
    select 1 from public.parking_import_row where parking_import_batch_id = p_batch_id
    group by space_number having count(*) > 1
  ) then raise exception '同じ枠番が複数行あります'; end if;
$old$;
  if position(v_old in v_definition) = 0 then
    raise exception 'commit_parking_import_without_fee validation changed; refusing partial-import patch';
  end if;
  v_definition := replace(v_definition, v_old, '');

  v_old := $old$  for import_row in
    select * from public.parking_import_row where parking_import_batch_id = p_batch_id order by source_row_number
  loop
    target_unit_id := null;$old$;
  v_new := $new$  for import_row in
    select * from public.parking_import_row
    where parking_import_batch_id = p_batch_id and validation_status <> 'committed'
    order by source_row_number
  loop
    begin
    target_unit_id := null;$new$;
  if position(v_old in v_definition) = 0 then
    raise exception 'commit_parking_import_without_fee row loop changed; refusing partial-import patch';
  end if;
  v_definition := replace(v_definition, v_old, v_new);

  v_old := $old$    if row_status not in ('occupied', 'vacant', 'unavailable') then
      raise exception '枠%の状態が不正です', import_row.space_number;
    end if;$old$;
  v_new := $new$    if row_status not in ('occupied', 'vacant', 'unavailable') then
      raise exception '枠%の状態が不正です', import_row.space_number;
    end if;
    if row_status = 'occupied' and (
      import_row.matched_tenant_id is null or import_row.parking_scope is null
      or (import_row.parking_scope = 'internal' and import_row.main_lease_contract_id is null)
      or (import_row.parking_scope = 'external' and import_row.main_lease_contract_id is not null)
    ) then
      raise exception '契約中の行はテナント、内外区分、主契約の選択を完了してください';
    end if;
    if (select count(*) from public.parking_import_row duplicate_row
        where duplicate_row.parking_import_batch_id = p_batch_id
          and duplicate_row.space_number = import_row.space_number) > 1 then
      raise exception '枠番が重複しています: %', import_row.space_number;
    end if;$new$;
  if position(v_old in v_definition) = 0 then
    raise exception 'commit_parking_import_without_fee row validation changed; refusing partial-import patch';
  end if;
  v_definition := replace(v_definition, v_old, v_new);

  v_old := $old$  end loop;

  update public.parking_import_batch set status = 'committed', committed_at = now()
  where parking_import_batch_id = p_batch_id;$old$;
  v_new := $new$    exception when others then
      update public.parking_import_row
      set validation_status = 'error', validation_messages = array[sqlerrm], updated_at = now()
      where parking_import_row_id = import_row.parking_import_row_id;
      failed_count := failed_count + 1;
    end;
  end loop;

  if not exists (
    select 1 from public.parking_import_row
    where parking_import_batch_id = p_batch_id and validation_status <> 'committed'
  ) then
    update public.parking_import_batch set status = 'committed', committed_at = now()
    where parking_import_batch_id = p_batch_id;
  end if;$new$;
  if position(v_old in v_definition) = 0 then
    raise exception 'commit_parking_import_without_fee row completion changed; refusing partial-import patch';
  end if;
  v_definition := replace(v_definition, v_old, v_new);

  v_old := $old$return jsonb_build_object('batch_id', p_batch_id, 'committed_count', committed_count, 'already_committed', false);$old$;
  v_new := $new$return jsonb_build_object(
    'batch_id', p_batch_id,
    'committed_count', committed_count,
    'failed_count', (select count(*) from public.parking_import_row where parking_import_batch_id = p_batch_id and validation_status = 'error'),
    'already_committed', false
  );$new$;
  if position(v_old in v_definition) = 0 then
    raise exception 'commit_parking_import_without_fee return changed; refusing partial-import patch';
  end if;
  v_definition := replace(v_definition, v_old, v_new);

  execute v_definition;
end;
$$;

do $$
declare
  v_definition text;
  v_old text := $old$select * from public.parking_import_row where parking_import_batch_id = p_batch_id order by source_row_number$old$;
  v_new text := $new$select * from public.parking_import_row
    where parking_import_batch_id = p_batch_id and validation_status = 'committed'
    order by source_row_number$new$;
begin
  select pg_get_functiondef('public.commit_parking_import(uuid)'::regprocedure) into v_definition;
  v_definition := replace(v_definition, E'\r\n', E'\n');
  if position(v_old in v_definition) = 0 then
    raise exception 'commit_parking_import fee loop changed; refusing partial-import patch';
  end if;
  execute replace(v_definition, v_old, v_new);
end;
$$;
