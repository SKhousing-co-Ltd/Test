-- リーシング図面画面からの区画新規登録
create or replace function public.create_map_unit(
  p_property_id uuid,
  p_floor_label varchar,
  p_unit_code varchar,
  p_unit_name varchar default null,
  p_rentable_area_sqm numeric default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_unit_id uuid;
begin
  if not public.current_account_is_active() then
    raise exception '有効なアカウントが必要です';
  end if;
  if nullif(trim(p_unit_code), '') is null or nullif(trim(p_floor_label), '') is null then
    raise exception '区画コードとフロアを入力してください';
  end if;
  if p_rentable_area_sqm is not null and p_rentable_area_sqm < 0 then
    raise exception '面積は0以上で入力してください';
  end if;

  insert into public.unit_master(property_id, unit_code, unit_name, floor_label, unit_type, rentable_area_sqm)
  values (p_property_id, trim(p_unit_code), nullif(trim(p_unit_name), ''), trim(p_floor_label), 'office', p_rentable_area_sqm)
  returning unit_id into v_unit_id;

  insert into public.unit_leasing_status(unit_id, leasing_status, updated_by)
  values (v_unit_id, 'vacant', auth.uid());
  return v_unit_id;
end;
$$;

grant execute on function public.create_map_unit(uuid, varchar, varchar, varchar, numeric) to authenticated;
