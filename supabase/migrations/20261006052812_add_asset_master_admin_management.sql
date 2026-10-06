-- 管理者向けアセット登録・基本情報更新を許可する。
-- フロア・区画マスタはリーシング図面側で後続整備する。
grant insert, update on public.asset_master to authenticated;

drop policy if exists "admins insert assets" on public.asset_master;
create policy "admins insert assets" on public.asset_master for insert to authenticated
  with check (public.current_account_is_admin());

drop policy if exists "admins update asset master details" on public.asset_master;
create policy "admins update asset master details" on public.asset_master for update to authenticated
  using (public.current_account_is_admin()) with check (public.current_account_is_admin());
