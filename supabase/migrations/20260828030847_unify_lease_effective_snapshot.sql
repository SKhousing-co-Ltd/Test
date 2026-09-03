-- 契約形態別の基準日判定を一か所へ集約する。

create or replace function public.lease_contract_is_effective_at_date(
  p_contract_status text,
  p_lease_term_type text,
  p_contract_start_date date,
  p_contract_end_date date,
  p_actual_end_date date,
  p_as_of_date date
)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $$
  select
    p_as_of_date is not null
    and p_contract_status in ('scheduled', 'active', 'terminated', 'expired')
    and (p_contract_start_date is null or p_contract_start_date <= p_as_of_date)
    and (p_actual_end_date is null or p_actual_end_date >= p_as_of_date)
    and case p_lease_term_type
      when 'ordinary' then true
      when 'fixed_term' then p_contract_end_date is not null
        and p_contract_end_date >= p_as_of_date
      else p_contract_end_date is null or p_contract_end_date >= p_as_of_date
    end;
$$;

revoke all on function public.lease_contract_is_effective_at_date(text, text, date, date, date, date)
  from public, anon;
grant execute on function public.lease_contract_is_effective_at_date(text, text, date, date, date, date)
  to authenticated;

create or replace function public.lease_contract_unit_snapshot_at_date(
  p_property_id uuid,
  p_as_of_date date
)
returns table (
  unit_id uuid,
  lease_contract_unit_id uuid,
  lease_contract_id uuid,
  contract_type text,
  contract_status text,
  contract_start_date date,
  contract_end_date date,
  lease_start_date date,
  lease_end_date date,
  tenant_id uuid,
  external_tenant_code text,
  tenant_name text,
  contract_notes text,
  leased_area_sqm numeric,
  monthly_rent_amount numeric,
  monthly_common_charge_amount numeric,
  monthly_total_amount numeric,
  deposit_amount numeric,
  security_deposit_amount numeric,
  key_money_amount numeric,
  renewal_fee_amount numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    unit.unit_id,
    current_allocation.lease_contract_unit_id,
    current_allocation.lease_contract_id,
    current_allocation.contract_type,
    current_allocation.contract_status,
    current_allocation.contract_start_date,
    current_allocation.contract_end_date,
    current_allocation.lease_start_date,
    current_allocation.lease_end_date,
    current_allocation.tenant_id,
    current_allocation.external_tenant_code,
    current_allocation.tenant_name,
    current_allocation.contract_notes,
    current_allocation.leased_area_sqm,
    current_allocation.monthly_rent_amount,
    current_allocation.monthly_common_charge_amount,
    current_allocation.monthly_rent_amount + current_allocation.monthly_common_charge_amount,
    current_allocation.deposit_amount,
    current_allocation.security_deposit_amount,
    current_allocation.key_money_amount,
    current_allocation.renewal_fee_amount
  from public.unit_master unit
  join lateral (
    select
      contract_unit.lease_contract_unit_id,
      contract.lease_contract_id,
      contract.contract_type::text as contract_type,
      contract.contract_status::text as contract_status,
      contract.contract_start_date,
      contract.contract_end_date,
      contract_unit.lease_start_date,
      contract_unit.lease_end_date,
      contract.tenant_id,
      tenant.external_tenant_code::text as external_tenant_code,
      tenant.tenant_name::text as tenant_name,
      contract.notes as contract_notes,
      contract_unit.leased_area_sqm,
      coalesce(term.monthly_rent_amount, contract_unit.monthly_rent_amount, 0::numeric) as monthly_rent_amount,
      coalesce(term.monthly_common_charge_amount, contract_unit.monthly_common_charge_amount, 0::numeric) as monthly_common_charge_amount,
      coalesce(term.deposit_amount, contract_unit.deposit_amount, 0::numeric) as deposit_amount,
      coalesce(term.security_deposit_amount, contract_unit.security_deposit_amount, 0::numeric) as security_deposit_amount,
      coalesce(term.key_money_amount, contract_unit.key_money_amount, 0::numeric) as key_money_amount,
      coalesce(term.renewal_fee_amount, contract_unit.renewal_fee_amount, 0::numeric) as renewal_fee_amount
    from public.lease_contract_unit contract_unit
    join public.lease_contract contract
      on contract.lease_contract_id = contract_unit.lease_contract_id
    join public.tenant_master tenant on tenant.tenant_id = contract.tenant_id
    left join public.lease_contract_amendment origin_amendment
      on origin_amendment.lease_contract_amendment_id = contract_unit.created_by_amendment_id
    left join lateral (
      select unit_term.*
      from public.lease_contract_unit_term unit_term
      left join public.lease_contract_amendment term_amendment
        on term_amendment.lease_contract_amendment_id = unit_term.lease_contract_amendment_id
      where unit_term.lease_contract_unit_id = contract_unit.lease_contract_unit_id
        and unit_term.effective_from <= p_as_of_date
        and (unit_term.effective_to is null or unit_term.effective_to >= p_as_of_date)
        and (unit_term.lease_contract_amendment_id is null or term_amendment.status = 'executed')
      order by unit_term.effective_from desc, unit_term.created_at desc
      limit 1
    ) term on true
    where contract_unit.unit_id = unit.unit_id
      and public.lease_contract_is_effective_at_date(
        contract.contract_status, contract.lease_term_type,
        contract.contract_start_date, contract.contract_end_date,
        contract.actual_end_date, p_as_of_date
      )
      and (
        contract.contract_status not in ('terminated', 'expired')
        or coalesce(contract.actual_end_date, contract_unit.lease_end_date, contract.contract_end_date) is not null
      )
      and (contract_unit.lease_start_date is null or contract_unit.lease_start_date <= p_as_of_date)
      and (contract_unit.lease_end_date is null or contract_unit.lease_end_date >= p_as_of_date)
      and (contract_unit.created_by_amendment_id is null or origin_amendment.status = 'executed')
    order by coalesce(contract_unit.lease_start_date, contract.contract_start_date) desc nulls last,
      contract_unit.created_at desc
    limit 1
  ) current_allocation on true
  where unit.property_id = p_property_id and unit.is_active;
$$;

create or replace function public.rent_roll_list_with_terms_at_date(
  p_property_id uuid,
  p_as_of_date date
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(
    source_row || jsonb_build_object(
      'lease_term_type', contract.lease_term_type,
      'renewal_due_date', contract.renewal_due_date,
      'actual_end_date', contract.actual_end_date,
      'renewed_from_contract_id', contract.renewed_from_contract_id
    ) order by source_row ->> 'floor_label', source_row ->> 'unit_code'
  ), '[]'::jsonb)
  from jsonb_array_elements(public.rent_roll_list_at_date(p_property_id, p_as_of_date)) source_row
  left join public.lease_contract contract
    on contract.lease_contract_id = nullif(source_row ->> 'lease_contract_id', '')::uuid;
$$;

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
  select jsonb_set(
    detail.base_detail,
    '{contract}',
    detail.base_detail -> 'contract' || jsonb_build_object(
        'lease_term_type', contract.lease_term_type,
        'renewal_due_date', contract.renewal_due_date,
        'actual_end_date', contract.actual_end_date,
        'renewed_from_contract_id', contract.renewed_from_contract_id
      )
  )
  from public.lease_contract_unit contract_unit
  join public.lease_contract contract
    on contract.lease_contract_id = contract_unit.lease_contract_id
  cross join lateral (
    select public.contract_detail_for_audit(p_lease_contract_unit_id, p_as_of_date) base_detail
  ) detail
  where contract_unit.lease_contract_unit_id = p_lease_contract_unit_id;
$$;

revoke all on function public.rent_roll_list_with_terms_at_date(uuid, date) from public, anon;
revoke all on function public.contract_term_detail_for_audit(uuid, date) from public, anon;
grant execute on function public.rent_roll_list_with_terms_at_date(uuid, date) to authenticated;
grant execute on function public.contract_term_detail_for_audit(uuid, date) to authenticated;

comment on function public.lease_contract_is_effective_at_date(text, text, date, date, date, date)
  is '普通・定期・未分類契約の基準日時点有効性を共通判定する。更新予定日は判定に使用しない。';
comment on function public.rent_roll_list_with_terms_at_date(uuid, date)
  is '既存レントロール結果へ法的契約形態・更新予定日・実終了日を付加する。';

create or replace function private.match_rent_roll_import_batch(p_batch_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  matched_count integer;
  ambiguous_count integer;
  unmatched_count integer;
begin
  if auth.uid() is null
     or not (select public.current_account_is_active())
     or (select public.current_account_role()) not in ('admin', 'manager') then
    raise exception 'レントロール照合は管理者またはマネージャーだけが実行できます';
  end if;
  perform 1 from public.rent_roll_import_batch
  where rent_roll_import_batch_id = p_batch_id for update;
  if not found then raise exception '比較バッチが見つかりません'; end if;

  with candidate_counts as (
    select source.rent_roll_import_row_id,
           count(snapshot.lease_contract_unit_id) filter (
             where source.tenant_code is null
                or snapshot.external_tenant_code = source.tenant_code
                or exists (
                  select 1 from public.tenant_billing_code code
                  where code.tenant_id = snapshot.tenant_id
                    and code.billing_code = source.tenant_code
                    and code.is_active
                )
           )::integer as candidate_count,
           (array_agg(snapshot.lease_contract_unit_id) filter (
             where source.tenant_code is null
                or snapshot.external_tenant_code = source.tenant_code
                or exists (
                  select 1 from public.tenant_billing_code code
                  where code.tenant_id = snapshot.tenant_id
                    and code.billing_code = source.tenant_code
                    and code.is_active
                )
           ))[1] as candidate_id
    from public.rent_roll_import_row source
    join public.rent_roll_import_batch batch
      on batch.rent_roll_import_batch_id = source.rent_roll_import_batch_id
    left join public.asset_master asset on asset.asset_name = source.property_name
    left join public.unit_master unit
      on unit.property_id = asset.asset_id
     and unit.unit_code = source.unit_code
     and (source.floor_label is null or unit.floor_label = source.floor_label)
    left join public.lease_contract_unit_snapshot_at_date(asset.asset_id, batch.as_of_date) snapshot
      on snapshot.unit_id = unit.unit_id
    where source.rent_roll_import_batch_id = p_batch_id
    group by source.rent_roll_import_row_id
  )
  update public.rent_roll_import_row source
  set matched_lease_contract_unit_id = case when candidates.candidate_count = 1 then candidates.candidate_id else null end,
      match_status = case when candidates.candidate_count = 1 then 'matched'
                          when candidates.candidate_count > 1 then 'ambiguous' else 'unmatched' end,
      match_note = case when candidates.candidate_count = 1 then null
                        when candidates.candidate_count > 1 then concat('候補が', candidates.candidate_count, '件あります')
                        else '物件・区画・請求コードに一致する契約区画がありません' end,
      updated_at = now()
  from candidate_counts candidates
  where source.rent_roll_import_row_id = candidates.rent_roll_import_row_id;

  select count(*) filter (where match_status = 'matched'),
         count(*) filter (where match_status = 'ambiguous'),
         count(*) filter (where match_status = 'unmatched')
  into matched_count, ambiguous_count, unmatched_count
  from public.rent_roll_import_row where rent_roll_import_batch_id = p_batch_id;

  update public.rent_roll_import_batch
  set status = case when ambiguous_count + unmatched_count = 0 then 'matched' else 'reviewing' end,
      updated_at = now()
  where rent_roll_import_batch_id = p_batch_id;

  return jsonb_build_object(
    'matched', matched_count, 'ambiguous', ambiguous_count, 'unmatched', unmatched_count
  );
end;
$$;

revoke all on function private.match_rent_roll_import_batch(uuid) from public, anon;
grant execute on function private.match_rent_roll_import_batch(uuid) to authenticated;
