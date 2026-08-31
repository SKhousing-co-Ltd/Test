-- 内部駐車場契約が主契約より先行する場合、主契約開始前の駐車料は控除しない外部扱いで保持する。
-- 20260831052108 の同一開始日直接更新版を基底関数として残し、既存の呼び出しシグネチャを維持する。

alter function public.set_parking_fee_history(uuid, text, uuid, numeric, date, uuid, uuid, text, text, integer)
  rename to set_parking_fee_history_base;

create function public.set_parking_fee_history(
  p_parking_lease_contract_unit_id uuid,
  p_parking_scope text,
  p_main_lease_contract_id uuid,
  p_monthly_parking_fee numeric,
  p_effective_from date,
  p_source_import_batch_id uuid default null,
  p_source_import_row_id uuid default null,
  p_source_file_name text default null,
  p_source_sheet_name text default null,
  p_source_row_number integer default null
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  main_start date;
  external_result jsonb;
  internal_result jsonb;
  external_end date;
begin
  if p_parking_scope <> 'internal' or p_main_lease_contract_id is null then
    return public.set_parking_fee_history_base(
      p_parking_lease_contract_unit_id, p_parking_scope, p_main_lease_contract_id,
      p_monthly_parking_fee, p_effective_from, p_source_import_batch_id,
      p_source_import_row_id, p_source_file_name, p_source_sheet_name, p_source_row_number
    );
  end if;

  select min(coalesce(main_unit.lease_start_date, main_contract.contract_start_date))
    into main_start
  from public.lease_contract main_contract
  join public.lease_contract_unit main_unit
    on main_unit.lease_contract_id = main_contract.lease_contract_id
  join public.unit_master main_unit_master on main_unit_master.unit_id = main_unit.unit_id
  where main_contract.lease_contract_id = p_main_lease_contract_id
    and main_unit_master.unit_type <> 'parking';

  -- 主契約の存在・同一テナント／物件の検証は基底関数に委ねる。
  if main_start is null or p_effective_from >= main_start then
    return public.set_parking_fee_history_base(
      p_parking_lease_contract_unit_id, p_parking_scope, p_main_lease_contract_id,
      p_monthly_parking_fee, p_effective_from, p_source_import_batch_id,
      p_source_import_row_id, p_source_file_name, p_source_sheet_name, p_source_row_number
    );
  end if;

  -- 先行期間は控除先を持たない外部扱いとして保存する。
  external_result := public.set_parking_fee_history_base(
    p_parking_lease_contract_unit_id, 'external', null,
    p_monthly_parking_fee, p_effective_from, p_source_import_batch_id,
    p_source_import_row_id, p_source_file_name, p_source_sheet_name, p_source_row_number
  );
  external_end := nullif(external_result ->> 'effective_to', '')::date;

  -- 駐車場契約が主契約開始日まで継続する場合だけ、以後を内部扱いとして追加する。
  if external_end is null or main_start <= external_end then
    internal_result := public.set_parking_fee_history_base(
      p_parking_lease_contract_unit_id, 'internal', p_main_lease_contract_id,
      p_monthly_parking_fee, main_start, p_source_import_batch_id,
      p_source_import_row_id, p_source_file_name, p_source_sheet_name, p_source_row_number
    );
  end if;

  return jsonb_build_object(
    'pre_main_period_as_external', true,
    'external_history', external_result,
    'internal_history', internal_result
  );
end;
$$;

revoke all on function public.set_parking_fee_history(uuid, text, uuid, numeric, date, uuid, uuid, text, text, integer)
  from public, anon;
grant execute on function public.set_parking_fee_history(uuid, text, uuid, numeric, date, uuid, uuid, text, text, integer)
  to authenticated;

comment on function public.set_parking_fee_history(uuid, text, uuid, numeric, date, uuid, uuid, text, text, integer)
  is '主契約より前の内部駐車料は外部扱いで保存し、主契約開始日以降を内部扱いとして保存する。';
