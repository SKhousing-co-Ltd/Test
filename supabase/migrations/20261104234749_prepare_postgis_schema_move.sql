-- Keep PostGIS lookups working after the extension is moved from public
-- to the non-exposed extensions schema.
alter function public.assert_floor_geometry_has_no_overlap(uuid, uuid, public.geometry)
  set search_path = public, extensions;

alter function public.save_unit_plan_geometry(uuid, uuid, jsonb, text)
  set search_path = public, extensions;

alter function public.restructure_floor_plan_units(uuid, uuid[], character varying, jsonb, text)
  set search_path = public, extensions;
