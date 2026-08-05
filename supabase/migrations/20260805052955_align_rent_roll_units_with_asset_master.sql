-- 現行の物件親マスタは asset_master。区画は階を含めて一意にする。
alter table public.unit_master
  add column if not exists source_discriminator varchar(150) not null default '';

drop index if exists public.uq_unit_master_without_wing;
drop index if exists public.uq_unit_master_with_wing;

create unique index if not exists uq_unit_master_without_wing_scope
  on public.unit_master (property_id, coalesce(floor_label, ''), unit_code, source_discriminator)
  where building_wing_id is null;

create unique index if not exists uq_unit_master_with_wing_scope
  on public.unit_master (property_id, building_wing_id, coalesce(floor_label, ''), unit_code, source_discriminator)
  where building_wing_id is not null;

comment on column public.unit_master.source_discriminator is
  '同一物件・棟・階・区画コードが複数ある暫定取込区画を区別する補助キー。通常は空文字。';
