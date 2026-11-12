create table if not exists public.meter_reading_contract_billing_unit (
  meter_reading_contract_id uuid not null references public.meter_reading_contract(meter_reading_contract_id) on delete cascade,
  lease_contract_billing_unit_id uuid not null references public.lease_contract_billing_unit(lease_contract_billing_unit_id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (meter_reading_contract_id, lease_contract_billing_unit_id)
);

alter table public.meter_reading_contract_billing_unit enable row level security;

grant select, insert, update, delete on public.meter_reading_contract_billing_unit to authenticated;

drop policy if exists "active users manage meter reading contract billing units" on public.meter_reading_contract_billing_unit;
create policy "active users manage meter reading contract billing units"
  on public.meter_reading_contract_billing_unit
  for all to authenticated
  using (public.current_account_is_active())
  with check (public.current_account_is_active());

comment on table public.meter_reading_contract_billing_unit is
  '検針データの分割行に割り当てた請求区画。物理区画の構成が重複する請求区画を独立して扱う';

-- 既存の物理区画割当が請求区画の全構成区画を含む場合は、その請求区画を同じ分割行へ引き継ぐ。
insert into public.meter_reading_contract_billing_unit (
  meter_reading_contract_id,
  lease_contract_billing_unit_id
)
select reading_contract.meter_reading_contract_id, billing_unit.lease_contract_billing_unit_id
from public.meter_reading_contract reading_contract
join public.lease_contract_billing_unit billing_unit
  on billing_unit.lease_contract_id in (
    select lease_contract_id
    from public.lease_contract
    where tenant_id = reading_contract.tenant_id
  )
where exists (
  select 1
  from public.lease_contract_billing_unit_member member
  join public.lease_contract_unit contract_unit
    on contract_unit.lease_contract_unit_id = member.lease_contract_unit_id
  join public.unit_master unit on unit.unit_id = contract_unit.unit_id
  where member.lease_contract_billing_unit_id = billing_unit.lease_contract_billing_unit_id
    and unit.property_id = reading_contract.asset_id
)
and not exists (
  select 1
  from public.lease_contract_billing_unit_member member
  join public.lease_contract_unit contract_unit
    on contract_unit.lease_contract_unit_id = member.lease_contract_unit_id
  join public.unit_master unit on unit.unit_id = contract_unit.unit_id
  where member.lease_contract_billing_unit_id = billing_unit.lease_contract_billing_unit_id
    and unit.property_id = reading_contract.asset_id
    and not exists (
      select 1
      from public.meter_reading_contract_unit reading_unit
      where reading_unit.meter_reading_contract_id = reading_contract.meter_reading_contract_id
        and reading_unit.unit_id = contract_unit.unit_id
    )
)
on conflict do nothing;
