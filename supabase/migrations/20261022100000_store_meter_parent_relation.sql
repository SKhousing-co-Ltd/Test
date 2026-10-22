-- 差引計算に使うメーターの親子関係を、ブラウザではなく共通DBに保存します。
-- 水道料金の段階計算に使う「大元メーター」とは別の関係です。
alter table public.asset_meter
  add column if not exists parent_asset_meter_id uuid
    references public.asset_meter(asset_meter_id) on delete set null;

alter table public.asset_meter
  drop constraint if exists ck_asset_meter_not_own_parent;

alter table public.asset_meter
  add constraint ck_asset_meter_not_own_parent
  check (parent_asset_meter_id is null or parent_asset_meter_id <> asset_meter_id);

create index if not exists ix_asset_meter_parent
  on public.asset_meter(parent_asset_meter_id);

comment on column public.asset_meter.parent_asset_meter_id is
  '差引使用量の計算に使う親メーター。水道料金計算用の大元メーターとは別。';
