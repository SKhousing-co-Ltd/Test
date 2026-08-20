-- Remote migration version: 20260820061420
-- 文字列を text[] へ連結すると配列リテラルとして解釈されるため、array_appendを使用する。
create or replace function public.prepare_parking_import(
  p_property_id uuid,
  p_parking_facility_id uuid,
  p_as_of_date date,
  p_source_file_name text,
  p_source_sheet_name text,
  p_source_file_hash text,
  p_rows jsonb
) returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  batch_id uuid;
  source_row jsonb;
  tenant_matches integer;
  tenant_id uuid;
  messages text[];
begin
  if not (select public.current_account_is_active()) or (select public.current_account_role()) not in ('admin', 'manager') then
    raise exception '駐車場取込は管理者またはマネージャーだけが実行できます';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception '取込明細がありません';
  end if;
  if not exists (
    select 1
    from public.parking_facility_master
    where parking_facility_id = p_parking_facility_id
      and property_id = p_property_id
      and is_active
  ) then
    raise exception '物件に紐づく有効な駐車場施設を指定してください';
  end if;

  select parking_import_batch_id
  into batch_id
  from public.parking_import_batch
  where property_id = p_property_id
    and source_file_hash = p_source_file_hash;

  if batch_id is not null then
    return batch_id;
  end if;

  insert into public.parking_import_batch (
    property_id,
    parking_facility_id,
    source_file_name,
    source_sheet_name,
    source_file_hash,
    as_of_date
  ) values (
    p_property_id,
    p_parking_facility_id,
    left(p_source_file_name, 255),
    left(p_source_sheet_name, 100),
    lower(p_source_file_hash),
    p_as_of_date
  )
  returning parking_import_batch_id into batch_id;

  for source_row in select value from jsonb_array_elements(p_rows) loop
    if nullif(trim(source_row->>'space_number'), '') is null then
      raise exception '枠番が空の行があります';
    end if;
    if nullif(trim(source_row->>'tenant_name'), '') is null then
      raise exception 'テナント名が空の行があります';
    end if;

    select count(*), min(tenant.tenant_id::text)::uuid
    into tenant_matches, tenant_id
    from public.tenant_master tenant
    where public.normalize_parking_tenant_name(tenant.tenant_name)
      = public.normalize_parking_tenant_name(source_row->>'tenant_name');

    messages := array['内部・外部を選択してください'];
    if tenant_matches = 0 then
      messages := array_append(messages, 'テナント候補が見つかりません');
    end if;
    if tenant_matches > 1 then
      messages := array_append(messages, 'テナント候補が複数あります');
    end if;

    insert into public.parking_import_row (
      parking_import_batch_id,
      source_row_number,
      space_number,
      access_code,
      tenant_location_label,
      tenant_name,
      normalized_tenant_name,
      matched_tenant_id,
      contract_start_date,
      vehicle_model,
      registration_number,
      chassis_number,
      notes,
      validation_messages,
      raw_payload
    ) values (
      batch_id,
      (source_row->>'source_row_number')::integer,
      trim(source_row->>'space_number'),
      nullif(trim(source_row->>'access_code'), ''),
      nullif(trim(source_row->>'tenant_location_label'), ''),
      trim(source_row->>'tenant_name'),
      public.normalize_parking_tenant_name(source_row->>'tenant_name'),
      case when tenant_matches = 1 then tenant_id end,
      nullif(source_row->>'contract_start_date', '')::date,
      nullif(trim(source_row->>'vehicle_model'), ''),
      nullif(trim(source_row->>'registration_number'), ''),
      nullif(trim(source_row->>'chassis_number'), ''),
      nullif(trim(source_row->>'notes'), ''),
      messages,
      source_row
    );
  end loop;

  return batch_id;
end;
$$;

revoke all on function public.prepare_parking_import(uuid, uuid, date, text, text, text, jsonb) from public, anon;
grant execute on function public.prepare_parking_import(uuid, uuid, date, text, text, text, jsonb) to authenticated;
