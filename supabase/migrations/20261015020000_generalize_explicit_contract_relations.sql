create table if not exists public.lease_contract_relation (
  lease_contract_relation_id uuid primary key default gen_random_uuid(),
  main_lease_contract_id uuid not null references public.lease_contract(lease_contract_id) on delete restrict,
  related_lease_contract_id uuid not null references public.lease_contract(lease_contract_id) on delete restrict,
  relation_type text not null default 'ancillary',
  source_system text,
  source_record_key text,
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  constraint ck_lease_contract_relation_not_self check (main_lease_contract_id <> related_lease_contract_id),
  constraint ck_lease_contract_relation_type check (relation_type in ('ancillary', 'related')),
  constraint uq_lease_contract_relation unique (main_lease_contract_id, related_lease_contract_id)
);

create index if not exists ix_lease_contract_relation_related
  on public.lease_contract_relation(related_lease_contract_id);

alter table public.lease_contract_relation enable row level security;
revoke all on table public.lease_contract_relation from public, anon;
grant select, insert, update, delete on table public.lease_contract_relation to authenticated;

drop policy if exists "active users read contract relations" on public.lease_contract_relation;
create policy "active users read contract relations"
  on public.lease_contract_relation for select to authenticated
  using (public.current_account_is_active());

drop policy if exists "managers insert contract relations" on public.lease_contract_relation;
create policy "managers insert contract relations"
  on public.lease_contract_relation for insert to authenticated
  with check (public.current_account_is_active() and public.current_account_role() in ('admin', 'manager'));

drop policy if exists "managers update contract relations" on public.lease_contract_relation;
create policy "managers update contract relations"
  on public.lease_contract_relation for update to authenticated
  using (public.current_account_is_active() and public.current_account_role() in ('admin', 'manager'))
  with check (public.current_account_is_active() and public.current_account_role() in ('admin', 'manager'));

drop policy if exists "managers delete contract relations" on public.lease_contract_relation;
create policy "managers delete contract relations"
  on public.lease_contract_relation for delete to authenticated
  using (public.current_account_is_active() and public.current_account_role() in ('admin', 'manager'));

create or replace function public.contract_term_detail_for_audit(
  p_lease_contract_unit_id uuid,
  p_as_of_date date default current_date
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with context as (
    select contract_unit.lease_contract_id as target_contract_id,
           contract.row_version as contract_row_version,
           contract.lease_term_type,
           contract.renewal_due_date,
           contract.actual_end_date,
           contract.renewed_from_contract_id,
           unit.row_version as unit_row_version,
           public.contract_detail_for_audit(p_lease_contract_unit_id, p_as_of_date) as base_detail
      from public.lease_contract_unit contract_unit
      join public.lease_contract contract using (lease_contract_id)
      join public.unit_master unit using (unit_id)
     where contract_unit.lease_contract_unit_id = p_lease_contract_unit_id
  ), parking_relations as (
    select parking_item
      || jsonb_build_object(
           'unit_type', 'parking',
           'monthly_amount', parking_item -> 'monthly_parking_fee',
           'relationship_direction', 'related'
         ) as item
      from context
      cross join lateral jsonb_array_elements(coalesce(context.base_detail -> 'related_parking_contracts', '[]'::jsonb)) parking_item
  ), general_relations as (
    select jsonb_build_object(
      'lease_contract_relation_id', relation.lease_contract_relation_id,
      'lease_contract_unit_id', related_unit.lease_contract_unit_id,
      'lease_contract_id', related_contract.lease_contract_id,
      'contract_status', related_contract.contract_status,
      'contract_start_date', related_contract.contract_start_date,
      'contract_end_date', related_contract.contract_end_date,
      'lease_start_date', related_unit.lease_start_date,
      'lease_end_date', related_unit.lease_end_date,
      'unit_id', unit.unit_id,
      'unit_code', unit.unit_code,
      'unit_name', unit.unit_name,
      'floor_label', unit.floor_label,
      'unit_type', unit.unit_type,
      'monthly_amount', related_unit.monthly_rent_amount,
      'monthly_common_charge_amount', related_unit.monthly_common_charge_amount,
      'relation_type', relation.relation_type,
      'relationship_source', 'contract_relation',
      'relationship_direction', case
        when relation.main_lease_contract_id = context.target_contract_id then 'related'
        else 'main'
      end
    ) as item
      from context
      join public.lease_contract_relation relation
        on relation.main_lease_contract_id = context.target_contract_id
        or relation.related_lease_contract_id = context.target_contract_id
      join public.lease_contract related_contract
        on related_contract.lease_contract_id = case
          when relation.main_lease_contract_id = context.target_contract_id then relation.related_lease_contract_id
          else relation.main_lease_contract_id
        end
      join public.lease_contract_unit related_unit
        on related_unit.lease_contract_id = related_contract.lease_contract_id
      join public.unit_master unit on unit.unit_id = related_unit.unit_id
  ), related_items as (
    select item from parking_relations
    union all
    select item from general_relations
  ), related_contracts as (
    select coalesce(
      jsonb_agg(item order by item ->> 'unit_type', item ->> 'unit_code', item ->> 'lease_contract_unit_id'),
      '[]'::jsonb
    ) as items
    from related_items
  )
  select jsonb_set(
    jsonb_set(
      jsonb_set(
        context.base_detail,
        '{contract}',
        context.base_detail -> 'contract' || jsonb_build_object(
          'lease_term_type', context.lease_term_type,
          'renewal_due_date', context.renewal_due_date,
          'actual_end_date', context.actual_end_date,
          'renewed_from_contract_id', context.renewed_from_contract_id
        )
      ),
      '{contract,unit_row_version}', to_jsonb(context.unit_row_version), true
    ),
    '{related_contracts}', related_contracts.items, true
  )
  from context cross join related_contracts;
$$;

revoke all on function public.contract_term_detail_for_audit(uuid, date) from public, anon;
grant execute on function public.contract_term_detail_for_audit(uuid, date) to authenticated;

comment on table public.lease_contract_relation is
  '事務所契約と看板・アンテナ・駐輪場・その他等の別契約を明示的に関連付ける。';
comment on function public.contract_term_detail_for_audit(uuid, date) is
  '契約詳細に、既存の駐車場関係と汎用契約関係を商品区分付きで返す。';
