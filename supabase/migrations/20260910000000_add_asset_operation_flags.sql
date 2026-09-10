-- アセットごとの業務対象設定。既存のレントロール表示は維持し、
-- テナント請求は明示的に有効化されるまで対象外とする。
alter table public.asset_master
  add column if not exists is_rent_roll_visible boolean not null default true,
  add column if not exists is_tenant_billing_enabled boolean not null default false;

comment on column public.asset_master.is_rent_roll_visible is 'レントロール画面の物件選択肢・一覧に表示するか。';
comment on column public.asset_master.is_tenant_billing_enabled is 'テナント請求および発行コード管理の対象にするか。';

grant update (is_rent_roll_visible, is_tenant_billing_enabled) on public.asset_master to authenticated;

drop policy if exists "admins update asset operation flags" on public.asset_master;
create policy "admins update asset operation flags"
  on public.asset_master
  for update
  to authenticated
  using (public.current_account_is_admin())
  with check (public.current_account_is_admin());

-- 発行コードを新規作成・更新する場合は、請求対象アセットだけを許可する。
-- 既存コードの参照・削除は維持し、設定変更後の履歴確認を妨げない。
drop policy if exists "active users manage billing codes" on public.billing_code;
drop policy if exists "active users read billing codes" on public.billing_code;
drop policy if exists "active users insert billing codes for enabled assets" on public.billing_code;
drop policy if exists "active users update billing codes for enabled assets" on public.billing_code;
drop policy if exists "active users delete billing codes" on public.billing_code;

create policy "active users read billing codes" on public.billing_code
  for select to authenticated using (public.current_account_is_active());
create policy "active users insert billing codes for enabled assets" on public.billing_code
  for insert to authenticated with check (
    public.current_account_is_active()
    and exists (
      select 1 from public.asset_master asset
      where asset.asset_id = property_id
        and asset.is_tenant_billing_enabled
    )
  );
create policy "active users update billing codes for enabled assets" on public.billing_code
  for update to authenticated
  using (public.current_account_is_active())
  with check (
    public.current_account_is_active()
    and exists (
      select 1 from public.asset_master asset
      where asset.asset_id = property_id
        and asset.is_tenant_billing_enabled
    )
  );
create policy "active users delete billing codes" on public.billing_code
  for delete to authenticated using (public.current_account_is_active());
