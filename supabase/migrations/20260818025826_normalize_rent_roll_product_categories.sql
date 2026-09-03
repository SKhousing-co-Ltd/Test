alter table public.unit_master
  drop constraint if exists ck_unit_master_type;

update public.unit_master
set unit_type = case
  when coalesce(unit_name, unit_code, '') ~ '(駐輪|自転車|バイク)' then 'bicycle_parking'
  when coalesce(unit_name, unit_code, '') ~ '(駐車|車庫|パーキング)' then 'parking'
  when coalesce(unit_name, unit_code, '') ~ '(看板|サイン)' then 'signage'
  when coalesce(unit_name, unit_code, '') ~ '(アンテナ|基地局)' then 'antenna'
  when coalesce(unit_name, unit_code, '') ~ '(倉庫|物置)' or unit_type = 'storage' then 'warehouse'
  when coalesce(unit_name, unit_code, '') ~ '(住居|住宅|居室)' or unit_type = 'residential' then 'residential'
  when unit_type = 'parking' then 'parking'
  when unit_type = 'office' then 'office'
  else 'other'
end;

alter table public.unit_master
  add constraint ck_unit_master_type check (
    unit_type in (
      'office',
      'residential',
      'parking',
      'bicycle_parking',
      'signage',
      'warehouse',
      'antenna',
      'other'
    )
  );

comment on column public.unit_master.unit_type is
  'レントロール商品区分: office, residential, parking, bicycle_parking, signage, warehouse, antenna, other';
