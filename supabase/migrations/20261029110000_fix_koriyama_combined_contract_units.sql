-- 郡山南館の結合契約は賃料等を代表区画へまとめたまま、物理区画ごとの入居状態を保持する。
with targets(source_unit_code, target_unit_code) as (
  values ('402', '403'), ('603', '604')
), source_contracts as (
  select
    source_unit.property_id,
    target_unit.unit_id as target_unit_id,
    target_unit.rentable_area_sqm as target_area_sqm,
    source_contract_unit.lease_contract_id,
    source_contract_unit.lease_start_date,
    source_contract_unit.lease_end_date,
    source_contract_unit.utility_amount_rounding_mode
  from targets
  join public.asset_master asset
    on asset.asset_name = '三共ビル郡山南館'
  join public.unit_master source_unit
    on source_unit.property_id = asset.asset_id
   and source_unit.unit_code = targets.source_unit_code
  join public.unit_master target_unit
    on target_unit.property_id = source_unit.property_id
   and target_unit.unit_code = targets.target_unit_code
  join public.lease_contract_unit source_contract_unit
    on source_contract_unit.unit_id = source_unit.unit_id
  join public.lease_contract contract
    on contract.lease_contract_id = source_contract_unit.lease_contract_id
   and contract.contract_status = 'active'
)
insert into public.lease_contract_unit (
  lease_contract_id,
  unit_id,
  leased_area_sqm,
  monthly_rent_amount,
  monthly_common_charge_amount,
  deposit_amount,
  security_deposit_amount,
  key_money_amount,
  renewal_fee_amount,
  lease_start_date,
  lease_end_date,
  utility_amount_rounding_mode
)
select
  lease_contract_id,
  target_unit_id,
  target_area_sqm,
  0,
  0,
  0,
  0,
  0,
  0,
  lease_start_date,
  lease_end_date,
  utility_amount_rounding_mode
from source_contracts
on conflict (lease_contract_id, unit_id) do nothing;

with targets(source_unit_code, target_unit_code) as (
  values ('402', '403'), ('603', '604')
), paired_contract_units as (
  select
    target_contract_unit.lease_contract_unit_id as target_contract_unit_id,
    source_term.effective_from,
    source_term.effective_to
  from targets
  join public.asset_master asset
    on asset.asset_name = '三共ビル郡山南館'
  join public.unit_master source_unit
    on source_unit.property_id = asset.asset_id
   and source_unit.unit_code = targets.source_unit_code
  join public.unit_master target_unit
    on target_unit.property_id = asset.asset_id
   and target_unit.unit_code = targets.target_unit_code
  join public.lease_contract_unit source_contract_unit
    on source_contract_unit.unit_id = source_unit.unit_id
  join public.lease_contract contract
    on contract.lease_contract_id = source_contract_unit.lease_contract_id
   and contract.contract_status = 'active'
  join public.lease_contract_unit target_contract_unit
    on target_contract_unit.lease_contract_id = source_contract_unit.lease_contract_id
   and target_contract_unit.unit_id = target_unit.unit_id
  join public.lease_contract_unit_term source_term
    on source_term.lease_contract_unit_id = source_contract_unit.lease_contract_unit_id
)
insert into public.lease_contract_unit_term (
  lease_contract_unit_id,
  effective_from,
  effective_to,
  monthly_rent_amount,
  monthly_common_charge_amount,
  deposit_amount,
  security_deposit_amount,
  key_money_amount,
  renewal_fee_amount
)
select
  target_contract_unit_id,
  effective_from,
  effective_to,
  0,
  0,
  0,
  0,
  0,
  0
from paired_contract_units
on conflict (lease_contract_unit_id, effective_from) do nothing;
