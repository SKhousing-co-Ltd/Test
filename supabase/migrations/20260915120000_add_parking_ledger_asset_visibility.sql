-- 駐車場台帳に表示するアセットを管理する。
-- 既存アセットは従来どおり表示し、管理者がアセット設定から除外できるようにする。
alter table public.asset_master
  add column if not exists is_parking_ledger_visible boolean not null default true;

comment on column public.asset_master.is_parking_ledger_visible is '駐車場台帳画面の物件選択肢・一覧に表示するか。';

grant update (is_parking_ledger_visible) on public.asset_master to authenticated;
