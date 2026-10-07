alter table public.unit_master drop constraint if exists ck_unit_master_type;
alter table public.unit_master add constraint ck_unit_master_type check (unit_type in ('office', 'retail', 'residential', 'storage', 'warehouse', 'parking', 'bicycle_parking', 'equipment', 'signage', 'antenna', 'other'));

create or replace function public.create_map_unit(
  p_property_id uuid,
  p_floor_label varchar,
  p_unit_code varchar,
  p_unit_name varchar default null,
  p_rentable_area_sqm numeric default null,
  p_unit_type varchar default 'office'
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_unit_id uuid;
begin
  if not public.current_account_is_active() then raise exception 'Active account required'; end if;
  if nullif(trim(p_unit_code), '') is null or nullif(trim(p_floor_label), '') is null then raise exception '区画コードとフロアを入力してください'; end if;
  if p_rentable_area_sqm is not null and p_rentable_area_sqm < 0 then raise exception '面積は0以上で入力してください'; end if;
  if p_unit_type not in ('office', 'retail', 'residential', 'storage', 'warehouse', 'parking', 'bicycle_parking', 'equipment', 'signage', 'antenna', 'other') then raise exception '区画種別が不正です'; end if;
  insert into public.unit_master(property_id, unit_code, unit_name, floor_label, unit_type, rentable_area_sqm)
  values (p_property_id, trim(p_unit_code), nullif(trim(p_unit_name), ''), trim(p_floor_label), p_unit_type, p_rentable_area_sqm)
  returning unit_id into v_unit_id;
  insert into public.unit_leasing_status(unit_id, leasing_status, updated_by) values (v_unit_id, 'vacant', auth.uid());
  return v_unit_id;
end;
$$;
grant execute on function public.create_map_unit(uuid, varchar, varchar, varchar, numeric, varchar) to authenticated;

create or replace view public.floor_plan_map_features with (security_invoker = true) as
select g.floor_plan_revision_id, g.unit_id, u.unit_code, coalesce(u.unit_name, u.unit_code) as unit_name,
  u.rentable_area_sqm, st_asgeojson(g.geometry)::jsonb as geometry_geojson,
  case when lease.is_occupied then 'occupied' else coalesce(status.leasing_status, 'vacant') end as display_status,
  u.unit_type
from public.unit_plan_geometry g
join public.unit_master u on u.unit_id = g.unit_id
join public.unit_current_lease_status lease on lease.unit_id = u.unit_id
left join public.unit_leasing_status status on status.unit_id = u.unit_id;
