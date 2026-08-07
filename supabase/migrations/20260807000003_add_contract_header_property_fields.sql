alter table public.asset_master
  add column if not exists building_structure text,
  add column if not exists lot_address text;

comment on column public.asset_master.building_structure is '契約書頭書に表示する構造規模';
comment on column public.asset_master.lot_address is '契約書頭書に表示する地番';
