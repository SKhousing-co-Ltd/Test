-- 物件ごとのテナントの並び順です。テナント請求の各画面（テナントコード一覧・入金明細・請求明細・
-- 請求書作成・検針データ）は、この順番でテナントを並べます。請求書作成の請求書番号もこの順で採番します。
-- 並び順が無いテナントは、画面側でレントロールの階順の位置に差し込みます。
create table if not exists public.asset_billing_tenant_order (
  asset_id uuid not null references public.asset_master(asset_id) on delete cascade,
  tenant_id uuid not null references public.tenant_master(tenant_id) on delete cascade,
  sort_order integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (asset_id, tenant_id)
);

alter table public.asset_billing_tenant_order enable row level security;

grant select, insert, update, delete on public.asset_billing_tenant_order to authenticated;

drop policy if exists "active users manage billing tenant order" on public.asset_billing_tenant_order;
create policy "active users manage billing tenant order"
  on public.asset_billing_tenant_order for all to authenticated
  using (public.current_account_is_active())
  with check (public.current_account_is_active());

drop trigger if exists set_asset_billing_tenant_order_updated_at on public.asset_billing_tenant_order;
create trigger set_asset_billing_tenant_order_updated_at
before update on public.asset_billing_tenant_order
for each row execute procedure public.set_updated_at();
