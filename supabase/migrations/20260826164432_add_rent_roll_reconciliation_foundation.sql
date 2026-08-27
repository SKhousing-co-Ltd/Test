-- レントロール整合性確認の比較元と、契約詳細閲覧の安全な取得基盤を追加する。
-- 契約正本の金額はこのマイグレーションでは変更しない。

alter table public.lease_contract
  add column if not exists row_version integer not null default 1;
alter table public.lease_contract
  drop constraint if exists ck_lease_contract_row_version;
alter table public.lease_contract
  add constraint ck_lease_contract_row_version check (row_version > 0);

alter table public.lease_contract_unit
  add column if not exists row_version integer not null default 1;
alter table public.lease_contract_unit
  drop constraint if exists ck_lease_contract_unit_row_version;
alter table public.lease_contract_unit
  add constraint ck_lease_contract_unit_row_version check (row_version > 0);

create or replace function public.bump_contract_row_version()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  new.row_version := old.row_version + 1;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists bump_lease_contract_row_version on public.lease_contract;
create trigger bump_lease_contract_row_version
before update on public.lease_contract
for each row execute procedure public.bump_contract_row_version();

drop trigger if exists bump_lease_contract_unit_row_version on public.lease_contract_unit;
create trigger bump_lease_contract_unit_row_version
before update on public.lease_contract_unit
for each row execute procedure public.bump_contract_row_version();

-- 既存の「認証済みなら全更新可能」なポリシーを、閲覧と管理者更新に分離する。
drop policy if exists "authenticated employees can manage lease contracts" on public.lease_contract;
drop policy if exists "active users read lease contracts" on public.lease_contract;
drop policy if exists "managers insert lease contracts" on public.lease_contract;
drop policy if exists "managers update lease contracts" on public.lease_contract;
drop policy if exists "managers delete lease contracts" on public.lease_contract;
create policy "active users read lease contracts"
  on public.lease_contract for select to authenticated
  using ((select public.current_account_is_active()));
create policy "managers insert lease contracts"
  on public.lease_contract for insert to authenticated
  with check (
    (select public.current_account_is_active())
    and (select public.current_account_role()) in ('admin', 'manager')
  );
create policy "managers update lease contracts"
  on public.lease_contract for update to authenticated
  using (
    (select public.current_account_is_active())
    and (select public.current_account_role()) in ('admin', 'manager')
  )
  with check (
    (select public.current_account_is_active())
    and (select public.current_account_role()) in ('admin', 'manager')
  );
create policy "managers delete lease contracts"
  on public.lease_contract for delete to authenticated
  using (
    (select public.current_account_is_active())
    and (select public.current_account_role()) in ('admin', 'manager')
  );

drop policy if exists "authenticated employees can manage lease contract units" on public.lease_contract_unit;
drop policy if exists "active users read lease contract units" on public.lease_contract_unit;
drop policy if exists "managers insert lease contract units" on public.lease_contract_unit;
drop policy if exists "managers update lease contract units" on public.lease_contract_unit;
drop policy if exists "managers delete lease contract units" on public.lease_contract_unit;
create policy "active users read lease contract units"
  on public.lease_contract_unit for select to authenticated
  using ((select public.current_account_is_active()));
create policy "managers insert lease contract units"
  on public.lease_contract_unit for insert to authenticated
  with check (
    (select public.current_account_is_active())
    and (select public.current_account_role()) in ('admin', 'manager')
  );
create policy "managers update lease contract units"
  on public.lease_contract_unit for update to authenticated
  using (
    (select public.current_account_is_active())
    and (select public.current_account_role()) in ('admin', 'manager')
  )
  with check (
    (select public.current_account_is_active())
    and (select public.current_account_role()) in ('admin', 'manager')
  );
create policy "managers delete lease contract units"
  on public.lease_contract_unit for delete to authenticated
  using (
    (select public.current_account_is_active())
    and (select public.current_account_role()) in ('admin', 'manager')
  );

create table if not exists public.rent_roll_import_batch (
  rent_roll_import_batch_id uuid primary key default gen_random_uuid(),
  source_file_name text not null,
  source_sha256 varchar(64) not null,
  as_of_date date not null,
  status varchar(20) not null default 'uploaded',
  row_count integer not null default 0,
  issue_count integer not null default 0,
  imported_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_rent_roll_import_batch_source unique (source_sha256, as_of_date),
  constraint ck_rent_roll_import_batch_sha256 check (source_sha256 ~ '^[0-9a-f]{64}$'),
  constraint ck_rent_roll_import_batch_status check (status in ('uploaded', 'matched', 'reviewing', 'completed', 'void')),
  constraint ck_rent_roll_import_batch_counts check (row_count >= 0 and issue_count >= 0)
);

create table if not exists public.rent_roll_import_row (
  rent_roll_import_row_id uuid primary key default gen_random_uuid(),
  rent_roll_import_batch_id uuid not null references public.rent_roll_import_batch(rent_roll_import_batch_id) on delete cascade,
  source_sheet_name text not null,
  source_row_number integer not null,
  property_name text not null,
  wing_code text,
  floor_label text,
  unit_code text not null,
  unit_type text not null,
  tenant_code text,
  tenant_name text,
  source_status text not null,
  source_record_key text not null,
  source_area_sqm numeric(12, 2),
  source_monthly_rent_amount numeric(14, 0),
  source_monthly_common_charge_amount numeric(14, 0),
  source_other_monthly_amount numeric(14, 0),
  source_monthly_total_amount numeric(14, 0),
  contract_start_date date,
  contract_end_date date,
  matched_lease_contract_unit_id uuid references public.lease_contract_unit(lease_contract_unit_id) on delete set null,
  match_status varchar(20) not null default 'unmatched',
  match_note text,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_rent_roll_import_row_source unique (rent_roll_import_batch_id, source_sheet_name, source_row_number),
  constraint ck_rent_roll_import_row_number check (source_row_number > 0),
  constraint ck_rent_roll_import_row_match_status check (match_status in ('unmatched', 'matched', 'ambiguous', 'ignored')),
  constraint ck_rent_roll_import_row_payload check (jsonb_typeof(raw_payload) = 'object'),
  constraint ck_rent_roll_import_row_amounts check (
    (source_area_sqm is null or source_area_sqm >= 0)
    and (source_monthly_rent_amount is null or source_monthly_rent_amount >= 0)
    and (source_monthly_common_charge_amount is null or source_monthly_common_charge_amount >= 0)
    and (source_other_monthly_amount is null or source_other_monthly_amount >= 0)
    and (source_monthly_total_amount is null or source_monthly_total_amount >= 0)
  )
);

create index if not exists ix_rent_roll_import_batch_as_of
  on public.rent_roll_import_batch(as_of_date desc, created_at desc);
create index if not exists ix_rent_roll_import_row_batch_match
  on public.rent_roll_import_row(rent_roll_import_batch_id, match_status);
create index if not exists ix_rent_roll_import_row_contract_unit
  on public.rent_roll_import_row(matched_lease_contract_unit_id)
  where matched_lease_contract_unit_id is not null;

drop trigger if exists set_rent_roll_import_batch_updated_at on public.rent_roll_import_batch;
create trigger set_rent_roll_import_batch_updated_at
before update on public.rent_roll_import_batch
for each row execute procedure public.set_updated_at();
drop trigger if exists set_rent_roll_import_row_updated_at on public.rent_roll_import_row;
create trigger set_rent_roll_import_row_updated_at
before update on public.rent_roll_import_row
for each row execute procedure public.set_updated_at();

alter table public.rent_roll_import_batch enable row level security;
alter table public.rent_roll_import_row enable row level security;
revoke all on table public.rent_roll_import_batch, public.rent_roll_import_row from public, anon;
grant select, insert, update, delete on table public.rent_roll_import_batch, public.rent_roll_import_row to authenticated;

create policy "audit users read rent roll import batches"
  on public.rent_roll_import_batch for select to authenticated
  using (
    (select public.current_account_is_active())
    and (select public.current_account_role()) in ('admin', 'manager', 'staff')
  );
create policy "managers insert rent roll import batches"
  on public.rent_roll_import_batch for insert to authenticated
  with check (
    (select public.current_account_is_active())
    and (select public.current_account_role()) in ('admin', 'manager')
  );
create policy "managers update rent roll import batches"
  on public.rent_roll_import_batch for update to authenticated
  using (
    (select public.current_account_is_active())
    and (select public.current_account_role()) in ('admin', 'manager')
  )
  with check (
    (select public.current_account_is_active())
    and (select public.current_account_role()) in ('admin', 'manager')
  );
create policy "managers delete rent roll import batches"
  on public.rent_roll_import_batch for delete to authenticated
  using (
    (select public.current_account_is_active())
    and (select public.current_account_role()) in ('admin', 'manager')
  );

create policy "audit users read rent roll import rows"
  on public.rent_roll_import_row for select to authenticated
  using (
    (select public.current_account_is_active())
    and (select public.current_account_role()) in ('admin', 'manager', 'staff')
  );
create policy "managers insert rent roll import rows"
  on public.rent_roll_import_row for insert to authenticated
  with check (
    (select public.current_account_is_active())
    and (select public.current_account_role()) in ('admin', 'manager')
  );
create policy "managers update rent roll import rows"
  on public.rent_roll_import_row for update to authenticated
  using (
    (select public.current_account_is_active())
    and (select public.current_account_role()) in ('admin', 'manager')
  )
  with check (
    (select public.current_account_is_active())
    and (select public.current_account_role()) in ('admin', 'manager')
  );
create policy "managers delete rent roll import rows"
  on public.rent_roll_import_row for delete to authenticated
  using (
    (select public.current_account_is_active())
    and (select public.current_account_role()) in ('admin', 'manager')
  );

-- 貸室賃料、駐車場代、その他月額を独立した項目として返す。
-- 駐車場代は貸室賃料から差し引かず、貸室賃料のDB登録額をそのまま使用する。
create or replace function public.rent_roll_list_at_date(p_property_id uuid, p_as_of_date date)
returns jsonb
language sql
stable
security invoker
set search_path to 'public'
as $$
  select coalesce(jsonb_agg(to_jsonb(result_row) order by result_row.floor_label, result_row.unit_code), '[]'::jsonb)
  from (
    select
      unit.unit_id,
      unit.unit_code,
      unit.unit_name,
      unit.floor_label,
      unit.unit_type,
      unit.rentable_area_sqm,
      unit.source_discriminator,
      leasing.leasing_status,
      snapshot.lease_contract_unit_id,
      snapshot.lease_contract_id,
      snapshot.contract_status,
      snapshot.contract_start_date,
      snapshot.contract_end_date,
      snapshot.lease_start_date,
      snapshot.lease_end_date,
      snapshot.tenant_id,
      snapshot.external_tenant_code,
      snapshot.tenant_name,
      snapshot.contract_notes,
      snapshot.leased_area_sqm,
      case
        when unit.unit_type in ('office', 'retail', 'residential', 'storage')
          then coalesce(snapshot.monthly_rent_amount, 0)
        else 0
      end as monthly_rent_amount,
      coalesce(snapshot.monthly_common_charge_amount, 0) as monthly_common_charge_amount,
      case
        when unit.unit_type in ('office', 'retail', 'residential', 'storage')
          then coalesce(snapshot.monthly_rent_amount, 0)
        else 0
      end + coalesce(snapshot.monthly_common_charge_amount, 0) as rent_common_total_amount,
      case
        when unit.unit_type = 'parking' then coalesce(parking_fee.monthly_parking_fee, 0)
        else 0
      end as monthly_parking_amount,
      case
        when unit.unit_type not in ('office', 'retail', 'residential', 'storage', 'parking')
          then coalesce(snapshot.monthly_rent_amount, 0)
        else 0
      end as other_monthly_amount,
      case
        when unit.unit_type in ('office', 'retail', 'residential', 'storage')
          then coalesce(snapshot.monthly_rent_amount, 0)
        else 0
      end
      + coalesce(snapshot.monthly_common_charge_amount, 0)
      + case when unit.unit_type = 'parking' then coalesce(parking_fee.monthly_parking_fee, 0) else 0 end
      + case
          when unit.unit_type not in ('office', 'retail', 'residential', 'storage', 'parking')
            then coalesce(snapshot.monthly_rent_amount, 0)
          else 0
        end as monthly_total_amount,
      coalesce(snapshot.deposit_amount, 0) as deposit_amount,
      coalesce(snapshot.security_deposit_amount, 0) as security_deposit_amount,
      coalesce(snapshot.key_money_amount, 0) as key_money_amount,
      coalesce(snapshot.renewal_fee_amount, 0) as renewal_fee_amount,
      case
        when unit.unit_type <> 'parking' then null
        when coalesce(space_availability.availability_status, 'available') = 'unavailable' then 'unavailable'
        when snapshot.lease_contract_id is not null then 'occupied'
        else 'vacant'
      end as space_status,
      parking_space.space_number,
      coalesce(parking_fee.parking_scope, parking_detail.parking_scope) as parking_scope,
      coalesce(parking_fee.monthly_parking_fee, 0) as monthly_parking_fee,
      parking_fee.effective_from as parking_fee_effective_from,
      assignment.access_code,
      vehicle.vehicle_model,
      vehicle.registration_number
    from public.unit_master unit
    left join public.lease_contract_unit_snapshot_at_date(p_property_id, p_as_of_date) snapshot
      on snapshot.unit_id = unit.unit_id
    left join public.unit_leasing_status leasing on leasing.unit_id = unit.unit_id
    left join public.parking_space_master parking_space on parking_space.unit_id = unit.unit_id
    left join public.parking_contract_detail parking_detail on parking_detail.lease_contract_id = snapshot.lease_contract_id
    left join lateral (
      select history.parking_scope, history.monthly_parking_fee, history.effective_from
      from public.parking_fee_history history
      where history.parking_lease_contract_unit_id = snapshot.lease_contract_unit_id
        and history.effective_from <= p_as_of_date
        and (history.effective_to is null or history.effective_to >= p_as_of_date)
      order by history.effective_from desc limit 1
    ) parking_fee on true
    left join lateral (
      select status_history.availability_status
      from public.parking_space_status_history status_history
      where status_history.unit_id = unit.unit_id and status_history.effective_from <= p_as_of_date
      order by status_history.effective_from desc, status_history.created_at desc limit 1
    ) space_availability on true
    left join public.parking_space_assignment assignment on assignment.lease_contract_unit_id = snapshot.lease_contract_unit_id
    left join lateral (
      select history.vehicle_model, history.registration_number
      from public.parking_vehicle_history history
      where history.lease_contract_unit_id = snapshot.lease_contract_unit_id
        and history.effective_from <= p_as_of_date
        and (history.effective_to is null or history.effective_to >= p_as_of_date)
      order by history.effective_from desc, history.created_at desc limit 1
    ) vehicle on true
    where unit.property_id = p_property_id and unit.is_active
  ) result_row;
$$;

revoke all on function public.rent_roll_list_at_date(uuid, date) from public, anon;
grant execute on function public.rent_roll_list_at_date(uuid, date) to authenticated;
comment on function public.rent_roll_list_at_date(uuid, date) is '貸室賃料、共益費、駐車場代、その他月額を独立項目として返す。駐車場代を貸室賃料から差し引かない。';

create or replace function public.contract_detail_for_audit(
  p_lease_contract_unit_id uuid,
  p_as_of_date date default current_date
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = pg_catalog, public
as $$
declare
  target_contract_id uuid;
  target_tenant_id uuid;
  target_property_id uuid;
  target_unit_type text;
  contract_detail jsonb;
  contract_units jsonb;
  related_parking jsonb;
  parking_candidates jsonb;
begin
  if auth.uid() is null or not (select public.current_account_is_active()) then
    raise exception '契約情報を閲覧する権限がありません';
  end if;
  if p_lease_contract_unit_id is null or p_as_of_date is null then
    raise exception '契約区画IDと基準日は必須です';
  end if;

  select contract.lease_contract_id, contract.tenant_id, unit.property_id, unit.unit_type,
    jsonb_build_object(
      'lease_contract_id', contract.lease_contract_id,
      'lease_contract_unit_id', contract_unit.lease_contract_unit_id,
      'contract_row_version', contract.row_version,
      'contract_unit_row_version', contract_unit.row_version,
      'tenant_id', tenant.tenant_id,
      'tenant_name', tenant.tenant_name,
      'external_tenant_code', tenant.external_tenant_code,
      'property_id', asset.asset_id,
      'property_name', asset.asset_name,
      'unit_id', unit.unit_id,
      'unit_code', unit.unit_code,
      'unit_name', unit.unit_name,
      'floor_label', unit.floor_label,
      'unit_type', unit.unit_type,
      'contract_status', contract.contract_status,
      'contract_type', contract.contract_type,
      'contract_start_date', contract.contract_start_date,
      'contract_end_date', contract.contract_end_date,
      'lease_start_date', contract_unit.lease_start_date,
      'lease_end_date', contract_unit.lease_end_date,
      'leased_area_sqm', contract_unit.leased_area_sqm,
      'monthly_rent_amount', contract_unit.monthly_rent_amount,
      'monthly_common_charge_amount', contract_unit.monthly_common_charge_amount,
      'monthly_total_amount', contract_unit.monthly_total_amount,
      'deposit_amount', contract_unit.deposit_amount,
      'security_deposit_amount', contract_unit.security_deposit_amount,
      'key_money_amount', contract_unit.key_money_amount,
      'renewal_fee_amount', contract_unit.renewal_fee_amount,
      'renewal_terms', contract.renewal_terms,
      'payment_terms', contract.payment_terms,
      'notes', contract.notes,
      'source_system', contract.source_system,
      'source_record_key', contract.source_record_key,
      'updated_at', greatest(contract.updated_at, contract_unit.updated_at)
    )
  into target_contract_id, target_tenant_id, target_property_id, target_unit_type, contract_detail
  from public.lease_contract_unit contract_unit
  join public.lease_contract contract on contract.lease_contract_id = contract_unit.lease_contract_id
  join public.tenant_master tenant on tenant.tenant_id = contract.tenant_id
  join public.unit_master unit on unit.unit_id = contract_unit.unit_id
  join public.asset_master asset on asset.asset_id = unit.property_id
  where contract_unit.lease_contract_unit_id = p_lease_contract_unit_id;

  if contract_detail is null then
    raise exception '対象の契約区画が見つかりません';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'lease_contract_unit_id', contract_unit.lease_contract_unit_id,
    'row_version', contract_unit.row_version,
    'unit_id', unit.unit_id,
    'unit_code', unit.unit_code,
    'unit_name', unit.unit_name,
    'floor_label', unit.floor_label,
    'unit_type', unit.unit_type,
    'leased_area_sqm', contract_unit.leased_area_sqm,
    'monthly_rent_amount', contract_unit.monthly_rent_amount,
    'monthly_common_charge_amount', contract_unit.monthly_common_charge_amount,
    'monthly_total_amount', contract_unit.monthly_total_amount,
    'lease_start_date', contract_unit.lease_start_date,
    'lease_end_date', contract_unit.lease_end_date
  ) order by unit.floor_label, unit.unit_code), '[]'::jsonb)
  into contract_units
  from public.lease_contract_unit contract_unit
  join public.unit_master unit on unit.unit_id = contract_unit.unit_id
  where contract_unit.lease_contract_id = target_contract_id;

  with related as (
    select
      parking_unit.lease_contract_unit_id,
      parking_contract.lease_contract_id,
      parking_contract.contract_status,
      parking_unit.lease_start_date,
      parking_unit.lease_end_date,
      unit.unit_id,
      unit.unit_code,
      unit.unit_name,
      space.space_number,
      fee.parking_scope,
      fee.monthly_parking_fee,
      fee.effective_from,
      fee.effective_to,
      'fee_history'::text as relationship_source
    from public.parking_fee_history fee
    join public.lease_contract_unit parking_unit
      on parking_unit.lease_contract_unit_id = fee.parking_lease_contract_unit_id
    join public.lease_contract parking_contract
      on parking_contract.lease_contract_id = parking_unit.lease_contract_id
    join public.unit_master unit on unit.unit_id = parking_unit.unit_id
    left join public.parking_space_master space on space.unit_id = unit.unit_id
    where fee.main_lease_contract_unit_id = p_lease_contract_unit_id
      and fee.effective_from <= p_as_of_date
      and (fee.effective_to is null or fee.effective_to >= p_as_of_date)
    union all
    select
      parking_unit.lease_contract_unit_id,
      parking_contract.lease_contract_id,
      parking_contract.contract_status,
      parking_unit.lease_start_date,
      parking_unit.lease_end_date,
      unit.unit_id,
      unit.unit_code,
      unit.unit_name,
      space.space_number,
      detail.parking_scope,
      null::numeric,
      null::date,
      null::date,
      'contract_header'::text
    from public.parking_contract_detail detail
    join public.lease_contract parking_contract
      on parking_contract.lease_contract_id = detail.lease_contract_id
    join public.lease_contract_unit parking_unit
      on parking_unit.lease_contract_id = parking_contract.lease_contract_id
    join public.unit_master unit on unit.unit_id = parking_unit.unit_id and unit.unit_type = 'parking'
    left join public.parking_space_master space on space.unit_id = unit.unit_id
    where detail.main_lease_contract_id = target_contract_id
      and coalesce(parking_unit.lease_start_date, parking_contract.contract_start_date, '-infinity'::date) <= p_as_of_date
      and coalesce(parking_unit.lease_end_date, parking_contract.contract_end_date, 'infinity'::date) >= p_as_of_date
      and not exists (
        select 1 from public.parking_fee_history fee
        where fee.parking_lease_contract_unit_id = parking_unit.lease_contract_unit_id
          and fee.main_lease_contract_unit_id = p_lease_contract_unit_id
          and fee.effective_from <= p_as_of_date
          and (fee.effective_to is null or fee.effective_to >= p_as_of_date)
      )
  )
  select coalesce(jsonb_agg(to_jsonb(related) order by related.space_number, related.unit_code), '[]'::jsonb)
  into related_parking
  from related;

  if target_unit_type = 'parking' then
    parking_candidates := '[]'::jsonb;
  else
    select coalesce(jsonb_agg(jsonb_build_object(
      'lease_contract_unit_id', parking_unit.lease_contract_unit_id,
      'lease_contract_id', parking_contract.lease_contract_id,
      'contract_status', parking_contract.contract_status,
      'lease_start_date', parking_unit.lease_start_date,
      'lease_end_date', parking_unit.lease_end_date,
      'unit_id', unit.unit_id,
      'unit_code', unit.unit_code,
      'unit_name', unit.unit_name,
      'space_number', space.space_number,
      'parking_scope', detail.parking_scope,
      'relationship_source', 'tenant_property_candidate'
    ) order by space.space_number, unit.unit_code), '[]'::jsonb)
    into parking_candidates
    from public.lease_contract parking_contract
    join public.lease_contract_unit parking_unit on parking_unit.lease_contract_id = parking_contract.lease_contract_id
    join public.unit_master unit on unit.unit_id = parking_unit.unit_id and unit.unit_type = 'parking'
    left join public.parking_space_master space on space.unit_id = unit.unit_id
    left join public.parking_contract_detail detail on detail.lease_contract_id = parking_contract.lease_contract_id
    where parking_contract.tenant_id = target_tenant_id
      and unit.property_id = target_property_id
      and coalesce(parking_unit.lease_start_date, parking_contract.contract_start_date, '-infinity'::date) <= p_as_of_date
      and coalesce(parking_unit.lease_end_date, parking_contract.contract_end_date, 'infinity'::date) >= p_as_of_date
      and not exists (
        select 1
        from jsonb_array_elements(related_parking) related_item
        where related_item ->> 'lease_contract_unit_id' = parking_unit.lease_contract_unit_id::text
      );
  end if;

  return jsonb_build_object(
    'as_of_date', p_as_of_date,
    'contract', contract_detail,
    'contract_units', contract_units,
    'related_parking_contracts', related_parking,
    'parking_candidates', parking_candidates
  );
end;
$$;

revoke all on function public.contract_detail_for_audit(uuid, date) from public, anon;
grant execute on function public.contract_detail_for_audit(uuid, date) to authenticated;

comment on table public.rent_roll_import_batch is '旧レントロール原票を比較元として保持する取込単位。契約正本を自動更新しない。';
comment on table public.rent_roll_import_row is '旧レントロールの全行と契約区画の照合状態。DB再構成値は保持せず都度計算する。';
comment on function public.contract_detail_for_audit(uuid, date) is '契約区画IDを起点に、契約詳細・同一契約区画・明示関連駐車場・未紐付け候補を分離して返す。';
