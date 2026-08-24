do $$
declare
  v_definition text;
  v_original text;
begin
  select pg_get_functiondef('public.commit_parking_import(uuid)'::regprocedure)
    into v_definition;
  v_original := v_definition;

  v_definition := replace(v_definition, E'  reusable_unit_id uuid;\n', '');
  v_definition := replace(v_definition, E'  reusable_unit_count integer;\n', '');
  v_definition := replace(v_definition, E'    reusable_unit_id := null;\n', '');
  v_definition := replace(v_definition, E'    reusable_unit_count := 0;\n', '');

  v_definition := regexp_replace(
    v_definition,
    E'\\n    if target_unit_id is null and row_status = ''occupied'' then\\n      select count\\(distinct unit\\.unit_id\\), min\\(unit\\.unit_id::text\\)::uuid into reusable_unit_count, reusable_unit_id\\n      from public\\.unit_master unit\\n      join public\\.lease_contract_unit existing_contract_unit on existing_contract_unit\\.unit_id = unit\\.unit_id\\n      join public\\.lease_contract contract on contract\\.lease_contract_id = existing_contract_unit\\.lease_contract_id\\n      where unit\\.property_id = batch\\.property_id and unit\\.unit_type = ''parking''\\n        and contract\\.tenant_id = import_row\\.matched_tenant_id\\n        and contract\\.contract_status = ''active''\\n        and not exists \\(select 1 from public\\.parking_space_master existing where existing\\.unit_id = unit\\.unit_id\\);\\n      if reusable_unit_count = 1 then\\n        target_unit_id := reusable_unit_id;\\n        update public\\.unit_master set\\n          unit_code = left\\(''PK-'' \\|\\| facility\\.facility_code \\|\\| ''-'' \\|\\| import_row\\.space_number, 100\\),\\n          unit_name = ''駐車枠 '' \\|\\| import_row\\.space_number,\\n          floor_label = ''駐車場'', unit_type = ''parking'', is_active = true, updated_at = now\\(\\)\\n        where unit_id = target_unit_id;\\n      end if;\\n    end if;\\n',
    E'\n',
    's'
  );

  if v_definition = v_original
     or position('reusable_unit_id' in v_definition) > 0
     or position('reusable_unit_count' in v_definition) > 0
     or position('if target_unit_id is null and row_status = ''occupied'' then' in v_definition) > 0 then
    raise exception 'commit_parking_import の再利用ロジックを安全に除去できませんでした';
  end if;

  execute v_definition;
end;
$$;
