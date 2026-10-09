-- 単価の持ち方の既定を「分類で共通」にし、分類共通の単価をレントロールに載せるかの設定を追加する。
-- 設定行が無い物件・分類も、アプリでは「分類で共通」として扱う。
alter table public.asset_utility_price_setting
  alter column price_scope set default 'category',
  add column if not exists show_in_rent_roll boolean not null default true;
comment on column public.asset_utility_price_setting.show_in_rent_roll is '分類で共通にした単価をレントロールに表示するか';
