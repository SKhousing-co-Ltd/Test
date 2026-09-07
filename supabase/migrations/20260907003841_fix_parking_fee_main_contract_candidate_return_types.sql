-- varchar を RETURNS TABLE の text 型へ明示変換し、候補取得時の実行時型不一致を解消する。
create or replace function public.list_parking_fee_main_contract_candidates(p_parking_lease_contract_unit_id uuid, p_effective_from date, p_parking_contract_end_date date)
returns table (lease_contract_unit_id uuid, unit_code text, unit_name text, lease_start_date date, lease_end_date date)
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare parking_tenant_id uuid; parking_property_id uuid;
begin
  if auth.uid() is null or not (select public.current_account_is_active()) or (select public.current_account_role()) not in ('admin', 'manager') then raise exception '駐車料金の主契約候補を参照する権限がありません'; end if;
  if p_effective_from is null or p_parking_contract_end_date is null or p_parking_contract_end_date < p_effective_from then raise exception '主契約候補の判定期間が不正です'; end if;
  select contract.tenant_id, unit.property_id into parking_tenant_id, parking_property_id from public.lease_contract_unit contract_unit join public.lease_contract contract on contract.lease_contract_id = contract_unit.lease_contract_id join public.unit_master unit on unit.unit_id = contract_unit.unit_id join public.parking_contract_detail detail on detail.lease_contract_id = contract.lease_contract_id where contract_unit.lease_contract_unit_id = p_parking_lease_contract_unit_id and contract.contract_type = 'parking' and unit.unit_type = 'parking';
  if not found then raise exception '対象の駐車場契約区画が見つかりません'; end if;
  return query select candidate.lease_contract_unit_id, main_unit.unit_code::text, main_unit.unit_name::text, coalesce(candidate.lease_start_date, main_contract.contract_start_date), coalesce(candidate.lease_end_date, main_contract.contract_end_date) from public.lease_contract_unit candidate join public.lease_contract main_contract on main_contract.lease_contract_id = candidate.lease_contract_id join public.unit_master main_unit on main_unit.unit_id = candidate.unit_id where main_contract.tenant_id = parking_tenant_id and main_unit.property_id = parking_property_id and main_unit.unit_type <> 'parking' and coalesce(candidate.lease_start_date, main_contract.contract_start_date) <= p_effective_from and coalesce(candidate.lease_end_date, main_contract.contract_end_date, 'infinity'::date) >= p_parking_contract_end_date order by main_unit.unit_code, candidate.lease_contract_unit_id;
end;
$$;
