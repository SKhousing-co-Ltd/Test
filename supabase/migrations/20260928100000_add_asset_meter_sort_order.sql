-- メーターの並び順です。検針表（Excel）と同じ順番で画面に並べるために持ちます。
-- 画面で保存すると、表示している順番で振り直します。
alter table public.asset_meter
  add column if not exists sort_order integer not null default 0;

comment on column public.asset_meter.sort_order is 'メーターの表示順（小さいほど上）';
