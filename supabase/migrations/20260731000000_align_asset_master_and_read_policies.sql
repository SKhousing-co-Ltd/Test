-- property_master から asset_master への統合後も、既存の property_id 列を
-- 外部キーとして使う業務テーブルとの互換性を維持する。
--
-- 本番環境では asset_master.asset_id への統合が完了している。
-- ローカルで過去のマイグレーションを再実行する場合は、旧 property_master の
-- property_id を asset_master.asset_id へ引き継いでから外部キーを付け替える。

do $$
begin
  if exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'asset_master'
       and column_name = 'uid'
  ) and not exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'asset_master'
       and column_name = 'asset_id'
  ) then
    alter table public.asset_master add column asset_id uuid;

    if to_regclass('public.property_master') is not null then
      update public.asset_master as asset
         set asset_id = coalesce(
           (
             select property.property_id
               from public.property_master as property
              where property.asset_code = asset.asset_code
           ),
           asset.uid
         );
    else
      update public.asset_master set asset_id = uid;
    end if;

    alter table public.asset_master alter column asset_id set not null;
    alter table public.asset_master
      add constraint uq_asset_master_asset_id unique (asset_id);
  end if;
end
$$;

do $$
begin
  if to_regclass('public.property_master') is not null then
    alter table public.building_wing_master
      drop constraint if exists building_wing_master_property_id_fkey;
    alter table public.building_wing_master
      add constraint building_wing_master_property_id_fkey
      foreign key (property_id) references public.asset_master (asset_id) on delete cascade;

    alter table public.unit_master
      drop constraint if exists unit_master_property_id_fkey;
    alter table public.unit_master
      add constraint unit_master_property_id_fkey
      foreign key (property_id) references public.asset_master (asset_id) on delete cascade;

    alter table public.property_recurring_financial_item
      drop constraint if exists property_recurring_financial_item_property_id_fkey;
    alter table public.property_recurring_financial_item
      add constraint property_recurring_financial_item_property_id_fkey
      foreign key (property_id) references public.asset_master (asset_id) on delete cascade;

    alter table public.property_monthly_financial_entry
      drop constraint if exists property_monthly_financial_entry_property_id_fkey;
    alter table public.property_monthly_financial_entry
      add constraint property_monthly_financial_entry_property_id_fkey
      foreign key (property_id) references public.asset_master (asset_id) on delete cascade;

    alter table public.floor_plan
      drop constraint if exists floor_plan_property_id_fkey;
    alter table public.floor_plan
      add constraint floor_plan_property_id_fkey
      foreign key (property_id) references public.asset_master (asset_id) on delete cascade;
  end if;
end
$$;

alter table public.asset_master enable row level security;

grant select on public.asset_master, public.department_master to authenticated;

drop policy if exists "active users read assets" on public.asset_master;
create policy "active users read assets"
  on public.asset_master
  for select
  to authenticated
  using (public.current_account_is_active());

drop policy if exists "departments: active user reads departments" on public.department_master;
create policy "departments: active user reads departments"
  on public.department_master
  for select
  to authenticated
  using (public.current_account_is_active());
