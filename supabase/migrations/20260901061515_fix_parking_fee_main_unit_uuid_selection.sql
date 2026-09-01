-- PostgreSQL does not provide min(uuid). Keep the existing auto-selection
-- behavior, but select the deterministic first UUID through array_agg instead.
create or replace function private.apply_parking_fee_change_request(
  p_change_request_id uuid,
  p_expected_row_version integer,
  p_monthly_parking_fee numeric,
  p_effective_from date,
  p_parking_contract_end_date date,
  p_main_lease_contract_unit_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  request_record public.change_request%rowtype;
  parking_lcu_id uuid;
  parking_scope text;
  parking_contract_id uuid;
  main_lcu_id uuid;
  main_contract_id uuid;
  candidate_count integer;
  parking_record record;
  contract_max_end date;
  all_contract_units_ended boolean;
begin
  if auth.uid() is null
     or not (select public.current_account_is_active())
     or (select public.current_account_role()) not in ('admin', 'manager') then
    raise exception '駐車料対応依頼の確定は管理者またはマネージャーだけが実行できます';
  end if;
  if p_monthly_parking_fee is null or p_monthly_parking_fee < 0
     or trunc(p_monthly_parking_fee) <> p_monthly_parking_fee then
    raise exception '月額駐車料は0以上の整数で指定してください';
  end if;
  if p_effective_from is null then raise exception '適用開始日を指定してください'; end if;
  select * into request_record
  from public.change_request request
  where request.change_request_id = p_change_request_id
    and request.request_type = 'parking_fee_setup'
    and request.status in ('open', 'in_review', 'on_hold')
    and request.row_version = p_expected_row_version
  for update;
  if not found then raise exception '対応依頼が更新済みか、確定できない状態です'; end if;

  select item.entity_id into parking_lcu_id
  from public.change_request_item item
  where item.change_request_id = p_change_request_id
    and item.entity_type = 'parking_fee_history'
  order by item.sort_order, item.created_at
  limit 1;
  if parking_lcu_id is null then raise exception '対象の駐車場契約区画が見つかりません'; end if;

  select detail.parking_scope, contract.lease_contract_id, contract.tenant_id,
         unit.property_id,
         coalesce(contract_unit.lease_start_date, contract.contract_start_date) as lease_start_date,
         contract_unit.lease_end_date
  into parking_record
  from public.lease_contract_unit contract_unit
  join public.lease_contract contract on contract.lease_contract_id = contract_unit.lease_contract_id
  join public.unit_master unit on unit.unit_id = contract_unit.unit_id
  join public.parking_contract_detail detail on detail.lease_contract_id = contract.lease_contract_id
  where contract_unit.lease_contract_unit_id = parking_lcu_id
    and contract.contract_type = 'parking'
    and unit.unit_type = 'parking'
  for update of contract_unit, contract;
  if not found then raise exception '駐車場契約情報が見つかりません'; end if;

  if p_parking_contract_end_date is null then
    raise exception '駐車場契約の終了日が未登録です。契約書を確認し、終了日を入力してください。';
  end if;
  if p_parking_contract_end_date < p_effective_from then
    raise exception '駐車場契約終了日は適用開始日以降を指定してください。';
  end if;
  if parking_record.lease_start_date is not null
     and p_parking_contract_end_date < parking_record.lease_start_date then
    raise exception '駐車場契約終了日は契約開始日以降を指定してください。';
  end if;

  parking_scope := parking_record.parking_scope;
  parking_contract_id := parking_record.lease_contract_id;
  update public.lease_contract_unit contract_unit
  set lease_end_date = p_parking_contract_end_date, updated_at = now()
  where contract_unit.lease_contract_unit_id = parking_lcu_id;

  select max(contract_unit.lease_end_date), bool_and(contract_unit.lease_end_date is not null)
  into contract_max_end, all_contract_units_ended
  from public.lease_contract_unit contract_unit
  where contract_unit.lease_contract_id = parking_contract_id;
  update public.lease_contract contract
  set contract_end_date = case when coalesce(all_contract_units_ended, false) then contract_max_end else null end,
      updated_at = now()
  where contract.lease_contract_id = parking_contract_id and contract.contract_type = 'parking';

  select detail.parking_scope, contract.lease_contract_id, contract.tenant_id,
         unit.property_id,
         coalesce(contract_unit.lease_start_date, contract.contract_start_date) as lease_start_date,
         contract_unit.lease_end_date
  into parking_record
  from public.lease_contract_unit contract_unit
  join public.lease_contract contract on contract.lease_contract_id = contract_unit.lease_contract_id
  join public.unit_master unit on unit.unit_id = contract_unit.unit_id
  join public.parking_contract_detail detail on detail.lease_contract_id = contract.lease_contract_id
  where contract_unit.lease_contract_unit_id = parking_lcu_id
    and contract.contract_type = 'parking'
    and unit.unit_type = 'parking';
  if parking_record.lease_end_date is distinct from p_parking_contract_end_date then
    raise exception '駐車場契約終了日の保存を確認できません';
  end if;

  if parking_scope = 'internal' then
    main_lcu_id := p_main_lease_contract_unit_id;
    if main_lcu_id is null then
      select count(*), (array_agg(candidate.lease_contract_unit_id order by candidate.lease_contract_unit_id))[1]
      into candidate_count, main_lcu_id
      from public.lease_contract_unit candidate
      join public.lease_contract main_contract on main_contract.lease_contract_id = candidate.lease_contract_id
      join public.unit_master main_unit on main_unit.unit_id = candidate.unit_id
      where main_contract.tenant_id = parking_record.tenant_id
        and main_unit.property_id = parking_record.property_id
        and main_unit.unit_type <> 'parking'
        and coalesce(candidate.lease_start_date, main_contract.contract_start_date) <= p_effective_from
        and coalesce(candidate.lease_end_date, main_contract.contract_end_date, 'infinity'::date)
          >= parking_record.lease_end_date;
      if candidate_count <> 1 then
        raise exception '控除対象の主契約区画を1件選択してください（候補%件）', candidate_count;
      end if;
    end if;
    select contract_unit.lease_contract_id into main_contract_id
    from public.lease_contract_unit contract_unit
    where contract_unit.lease_contract_unit_id = main_lcu_id;
    if main_contract_id is null then raise exception '控除対象の主契約区画が見つかりません'; end if;
  else
    main_lcu_id := null;
    main_contract_id := null;
  end if;

  perform public.set_parking_fee_history(
    parking_lcu_id, parking_scope, main_contract_id, p_monthly_parking_fee,
    p_effective_from, null, null, '対応依頼', null, null
  );
  select * into request_record from public.change_request request where request.change_request_id = p_change_request_id;
  return to_jsonb(request_record);
end;
$$;

revoke all on function private.apply_parking_fee_change_request(uuid, integer, numeric, date, date, uuid)
  from public, anon;
grant execute on function private.apply_parking_fee_change_request(uuid, integer, numeric, date, date, uuid)
  to authenticated;
