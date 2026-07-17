-- リーシング図面: 図面原本、版、区画ポリゴンおよび変更履歴
create extension if not exists postgis;

create table public.floor_plan (
  floor_plan_id uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.property_master(property_id) on delete cascade,
  building_wing_id uuid references public.building_wing_master(building_wing_id) on delete restrict,
  floor_label varchar(50) not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index uq_floor_plan_scope on public.floor_plan(property_id, coalesce(building_wing_id, '00000000-0000-0000-0000-000000000000'::uuid), floor_label);

create table public.floor_plan_revision (
  floor_plan_revision_id uuid primary key default gen_random_uuid(),
  floor_plan_id uuid not null references public.floor_plan(floor_plan_id) on delete cascade,
  revision_no integer not null,
  original_file_path text not null,
  preview_file_path text not null,
  file_type varchar(10) not null check (file_type in ('png', 'jpeg', 'svg', 'pdf')),
  pdf_page_number integer,
  is_current boolean not null default true,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  constraint ck_floor_plan_revision_page check ((file_type = 'pdf' and pdf_page_number is not null and pdf_page_number > 0) or (file_type <> 'pdf' and pdf_page_number is null)),
  constraint uq_floor_plan_revision_number unique (floor_plan_id, revision_no)
);
create unique index uq_floor_plan_current_revision on public.floor_plan_revision(floor_plan_id) where is_current;

create table public.plan_change_set (
  plan_change_set_id uuid primary key default gen_random_uuid(),
  floor_plan_revision_id uuid not null references public.floor_plan_revision(floor_plan_revision_id) on delete restrict,
  change_type varchar(20) not null check (change_type in ('drawing_upload', 'geometry_edit', 'split', 'merge', 'status_update')),
  note text,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create table public.unit_plan_geometry (
  unit_plan_geometry_id uuid primary key default gen_random_uuid(),
  floor_plan_revision_id uuid not null references public.floor_plan_revision(floor_plan_revision_id) on delete cascade,
  unit_id uuid not null references public.unit_master(unit_id) on delete restrict,
  plan_change_set_id uuid references public.plan_change_set(plan_change_set_id) on delete set null,
  geometry geometry(MultiPolygon, 0) not null,
  created_at timestamptz not null default now(),
  constraint uq_unit_plan_geometry unique(floor_plan_revision_id, unit_id),
  constraint ck_unit_plan_geometry_valid check (st_isvalid(geometry) and st_isvalidreason(geometry) = 'Valid Geometry' and st_xmin(geometry) >= 0 and st_ymin(geometry) >= 0 and st_xmax(geometry) <= 1 and st_ymax(geometry) <= 1)
);
create index ix_unit_plan_geometry_shape on public.unit_plan_geometry using gist(geometry);

create table public.unit_leasing_status (
  unit_id uuid primary key references public.unit_master(unit_id) on delete cascade,
  leasing_status varchar(20) not null default 'vacant' check (leasing_status in ('vacant', 'applied', 'unavailable')),
  updated_by uuid not null references auth.users(id),
  updated_at timestamptz not null default now()
);

create table public.unit_lineage (
  unit_lineage_id uuid primary key default gen_random_uuid(),
  plan_change_set_id uuid not null references public.plan_change_set(plan_change_set_id) on delete cascade,
  source_unit_id uuid not null references public.unit_master(unit_id) on delete restrict,
  target_unit_id uuid not null references public.unit_master(unit_id) on delete restrict,
  relation_type varchar(10) not null check (relation_type in ('split', 'merge')),
  created_at timestamptz not null default now(),
  constraint uq_unit_lineage unique(plan_change_set_id, source_unit_id, target_unit_id)
);

create or replace function public.create_floor_plan_revision(
  p_property_id uuid, p_building_wing_id uuid, p_floor_label varchar,
  p_original_file_path text, p_preview_file_path text, p_file_type varchar, p_pdf_page_number integer default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_plan_id uuid; v_previous_revision uuid; v_revision_id uuid; v_change_id uuid; v_next_no integer;
begin
  if not public.current_account_is_active() then raise exception '有効なアカウントが必要です'; end if;
  select floor_plan_id into v_plan_id from public.floor_plan
   where property_id = p_property_id and building_wing_id is not distinct from p_building_wing_id and floor_label = p_floor_label for update;
  if v_plan_id is null then
    insert into public.floor_plan(property_id, building_wing_id, floor_label) values (p_property_id, p_building_wing_id, p_floor_label) returning floor_plan_id into v_plan_id;
  end if;
  select floor_plan_revision_id into v_previous_revision from public.floor_plan_revision where floor_plan_id = v_plan_id and is_current for update;
  select coalesce(max(revision_no), 0) + 1 into v_next_no from public.floor_plan_revision where floor_plan_id = v_plan_id;
  update public.floor_plan_revision set is_current = false where floor_plan_id = v_plan_id and is_current;
  insert into public.floor_plan_revision(floor_plan_id, revision_no, original_file_path, preview_file_path, file_type, pdf_page_number, created_by)
  values (v_plan_id, v_next_no, p_original_file_path, p_preview_file_path, p_file_type, p_pdf_page_number, auth.uid()) returning floor_plan_revision_id into v_revision_id;
  insert into public.plan_change_set(floor_plan_revision_id, change_type, created_by) values (v_revision_id, 'drawing_upload', auth.uid()) returning plan_change_set_id into v_change_id;
  if v_previous_revision is not null then
    insert into public.unit_plan_geometry(floor_plan_revision_id, unit_id, plan_change_set_id, geometry)
    select v_revision_id, unit_id, v_change_id, geometry from public.unit_plan_geometry where floor_plan_revision_id = v_previous_revision;
  end if;
  return v_revision_id;
end;
$$;

create or replace function public.assert_floor_geometry_has_no_overlap(p_revision_id uuid, p_unit_id uuid, p_geometry geometry)
returns void language plpgsql set search_path = public as $$
begin
  if exists (
    select 1 from public.unit_plan_geometry g
    join public.unit_master u on u.unit_id = g.unit_id and u.is_active
    where g.floor_plan_revision_id = p_revision_id
      and g.unit_id <> p_unit_id
      and st_area(st_intersection(g.geometry, p_geometry)) > 0.00000001
  ) then
    raise exception '区画形状が他の有効区画と重複しています';
  end if;
end;
$$;

create or replace function public.save_unit_plan_geometry(p_revision_id uuid, p_unit_id uuid, p_geometry_geojson jsonb, p_note text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_geometry geometry(MultiPolygon, 0); v_change_id uuid; v_result uuid;
begin
  if not public.current_account_is_active() then raise exception '有効なアカウントが必要です'; end if;
  select st_multi(st_setsrid(st_geomfromgeojson(p_geometry_geojson::text), 0))::geometry(MultiPolygon, 0) into v_geometry;
  if v_geometry is null or not st_isvalid(v_geometry) then raise exception '無効な区画形状です'; end if;
  perform public.assert_floor_geometry_has_no_overlap(p_revision_id, p_unit_id, v_geometry);
  insert into public.plan_change_set(floor_plan_revision_id, change_type, note, created_by) values (p_revision_id, 'geometry_edit', p_note, auth.uid()) returning plan_change_set_id into v_change_id;
  insert into public.unit_plan_geometry(floor_plan_revision_id, unit_id, plan_change_set_id, geometry)
  values (p_revision_id, p_unit_id, v_change_id, v_geometry)
  on conflict (floor_plan_revision_id, unit_id) do update set geometry = excluded.geometry, plan_change_set_id = excluded.plan_change_set_id, created_at = now()
  returning unit_plan_geometry_id into v_result;
  return v_result;
end;
$$;

create or replace function public.set_unit_leasing_status(p_unit_id uuid, p_status varchar)
returns void language plpgsql security definer set search_path = public as $$
declare v_revision_id uuid;
begin
  if not public.current_account_is_active() then raise exception '有効なアカウントが必要です'; end if;
  insert into public.unit_leasing_status(unit_id, leasing_status, updated_by) values (p_unit_id, p_status, auth.uid())
  on conflict (unit_id) do update set leasing_status = excluded.leasing_status, updated_by = excluded.updated_by, updated_at = now();
  select g.floor_plan_revision_id into v_revision_id from public.unit_plan_geometry g join public.floor_plan_revision r on r.floor_plan_revision_id = g.floor_plan_revision_id and r.is_current where g.unit_id = p_unit_id limit 1;
  if v_revision_id is not null then insert into public.plan_change_set(floor_plan_revision_id, change_type, note, created_by) values (v_revision_id, 'status_update', p_status, auth.uid()); end if;
end;
$$;

-- p_targets: [{"unit_code":"A-1","unit_name":"A-1区画","rentable_area_sqm":50,"geometry":{GeoJSON MultiPolygon}}]
create or replace function public.restructure_floor_plan_units(p_revision_id uuid, p_source_unit_ids uuid[], p_relation_type varchar, p_targets jsonb, p_note text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_source_count integer; v_plan_id uuid; v_property_id uuid; v_wing_id uuid; v_next_no integer; v_new_revision uuid; v_change_id uuid; v_target jsonb; v_target_id uuid; v_geometry geometry(MultiPolygon, 0); v_source uuid;
begin
  if not public.current_account_is_active() then raise exception '有効なアカウントが必要です'; end if;
  if p_relation_type not in ('split', 'merge') or coalesce(array_length(p_source_unit_ids, 1), 0) = 0 or jsonb_array_length(coalesce(p_targets, '[]'::jsonb)) = 0 then raise exception '分割・結合の入力が不正です'; end if;
  if (p_relation_type = 'split' and array_length(p_source_unit_ids, 1) <> 1) or (p_relation_type = 'merge' and array_length(p_source_unit_ids, 1) < 2) then raise exception '分割・結合の対象区画数が不正です'; end if;
  select r.floor_plan_id, f.property_id, f.building_wing_id into v_plan_id, v_property_id, v_wing_id
  from public.floor_plan_revision r join public.floor_plan f on f.floor_plan_id = r.floor_plan_id where r.floor_plan_revision_id = p_revision_id and r.is_current for update;
  if v_plan_id is null then raise exception '現行の図面版のみ変更できます'; end if;
  select count(*) into v_source_count from public.unit_master where unit_id = any(p_source_unit_ids) and is_active and property_id = v_property_id;
  if v_source_count <> array_length(p_source_unit_ids, 1) then raise exception '対象区画は同一物件の有効区画である必要があります'; end if;
  if exists (select 1 from public.lease_contract_unit cu join public.lease_contract c on c.lease_contract_id = cu.lease_contract_id where cu.unit_id = any(p_source_unit_ids) and c.contract_status = 'active' and (c.contract_start_date is null or c.contract_start_date <= current_date) and (c.contract_end_date is null or c.contract_end_date >= current_date)) then raise exception '有効な契約が紐づく区画は分割・結合できません'; end if;
  select coalesce(max(revision_no), 0) + 1 into v_next_no from public.floor_plan_revision where floor_plan_id = v_plan_id;
  update public.floor_plan_revision set is_current = false where floor_plan_revision_id = p_revision_id;
  insert into public.floor_plan_revision(floor_plan_id, revision_no, original_file_path, preview_file_path, file_type, pdf_page_number, created_by)
  select floor_plan_id, v_next_no, original_file_path, preview_file_path, file_type, pdf_page_number, auth.uid() from public.floor_plan_revision where floor_plan_revision_id = p_revision_id returning floor_plan_revision_id into v_new_revision;
  insert into public.plan_change_set(floor_plan_revision_id, change_type, note, created_by) values (v_new_revision, p_relation_type, p_note, auth.uid()) returning plan_change_set_id into v_change_id;
  insert into public.unit_plan_geometry(floor_plan_revision_id, unit_id, plan_change_set_id, geometry)
  select v_new_revision, unit_id, v_change_id, geometry from public.unit_plan_geometry where floor_plan_revision_id = p_revision_id and not (unit_id = any(p_source_unit_ids));
  update public.unit_master set is_active = false, updated_at = now() where unit_id = any(p_source_unit_ids);
  for v_target in select value from jsonb_array_elements(p_targets) loop
    select st_multi(st_setsrid(st_geomfromgeojson((v_target -> 'geometry')::text), 0))::geometry(MultiPolygon, 0) into v_geometry;
    if v_geometry is null or not st_isvalid(v_geometry) then raise exception '新規区画の形状が無効です'; end if;
    perform public.assert_floor_geometry_has_no_overlap(v_new_revision, gen_random_uuid(), v_geometry);
    insert into public.unit_master(property_id, building_wing_id, unit_code, unit_name, floor_label, unit_type, rentable_area_sqm)
    select v_property_id, v_wing_id, v_target ->> 'unit_code', nullif(v_target ->> 'unit_name', ''), floor_label, 'office', nullif(v_target ->> 'rentable_area_sqm', '')::numeric from public.floor_plan where floor_plan_id = v_plan_id returning unit_id into v_target_id;
    insert into public.unit_plan_geometry(floor_plan_revision_id, unit_id, plan_change_set_id, geometry) values (v_new_revision, v_target_id, v_change_id, v_geometry);
    insert into public.unit_leasing_status(unit_id, leasing_status, updated_by) values (v_target_id, coalesce(v_target ->> 'leasing_status', 'vacant'), auth.uid());
    foreach v_source in array p_source_unit_ids loop insert into public.unit_lineage(plan_change_set_id, source_unit_id, target_unit_id, relation_type) values (v_change_id, v_source, v_target_id, p_relation_type); end loop;
  end loop;
  return v_new_revision;
end;
$$;

create or replace view public.floor_plan_map_features with (security_invoker = true) as
select g.floor_plan_revision_id, g.unit_id, u.unit_code, coalesce(u.unit_name, u.unit_code) as unit_name,
  u.rentable_area_sqm, st_asgeojson(g.geometry)::jsonb as geometry_geojson,
  case when lease.is_occupied then 'occupied' else coalesce(status.leasing_status, 'vacant') end as display_status
from public.unit_plan_geometry g
join public.unit_master u on u.unit_id = g.unit_id
join public.unit_current_lease_status lease on lease.unit_id = u.unit_id
left join public.unit_leasing_status status on status.unit_id = u.unit_id;

alter table public.floor_plan enable row level security;
alter table public.floor_plan_revision enable row level security;
alter table public.plan_change_set enable row level security;
alter table public.unit_plan_geometry enable row level security;
alter table public.unit_leasing_status enable row level security;
alter table public.unit_lineage enable row level security;
grant select, insert, update, delete on public.floor_plan, public.floor_plan_revision, public.plan_change_set, public.unit_plan_geometry, public.unit_leasing_status, public.unit_lineage to authenticated;
grant select on public.floor_plan_map_features to authenticated;
grant execute on function public.save_unit_plan_geometry(uuid, uuid, jsonb, text), public.set_unit_leasing_status(uuid, varchar) to authenticated;
grant execute on function public.create_floor_plan_revision(uuid, uuid, varchar, text, text, varchar, integer) to authenticated;
grant execute on function public.restructure_floor_plan_units(uuid, uuid[], varchar, jsonb, text) to authenticated;
create policy "active users manage floor plans" on public.floor_plan for all to authenticated using (public.current_account_is_active()) with check (public.current_account_is_active());
create policy "active users manage floor plan revisions" on public.floor_plan_revision for all to authenticated using (public.current_account_is_active()) with check (public.current_account_is_active());
create policy "active users read plan changes" on public.plan_change_set for select to authenticated using (public.current_account_is_active());
create policy "active users manage plan geometry" on public.unit_plan_geometry for all to authenticated using (public.current_account_is_active()) with check (public.current_account_is_active());
create policy "active users manage leasing status" on public.unit_leasing_status for all to authenticated using (public.current_account_is_active()) with check (public.current_account_is_active());
create policy "active users read unit lineage" on public.unit_lineage for select to authenticated using (public.current_account_is_active());

insert into storage.buckets(id, name, public) values ('floor-plans', 'floor-plans', false) on conflict (id) do update set public = false;
create policy "active users read floor plan files" on storage.objects for select to authenticated using (bucket_id = 'floor-plans' and public.current_account_is_active());
create policy "active users upload floor plan files" on storage.objects for insert to authenticated with check (bucket_id = 'floor-plans' and public.current_account_is_active());
create policy "active users update floor plan files" on storage.objects for update to authenticated using (bucket_id = 'floor-plans' and public.current_account_is_active()) with check (bucket_id = 'floor-plans' and public.current_account_is_active());
