-- 対応依頼テーブルはData APIから読取専用のまま維持し、駐車料確定に必要な
-- 更新だけを非公開スキーマの権限付き関数へ閉じ込める。

create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

create or replace function private.close_parking_fee_change_request()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  closed_request record;
begin
  if auth.uid() is null
     or not (select public.current_account_is_active())
     or (select public.current_account_role()) not in ('admin', 'manager') then
    raise exception '駐車料対応依頼の確定は管理者またはマネージャーだけが実行できます';
  end if;

  update public.change_request_item item
  set proposed_value = to_jsonb(new.monthly_parking_fee),
      validation_status = 'valid', validation_message = null, updated_at = now()
  from public.change_request request
  where request.change_request_id = item.change_request_id
    and request.source_type = 'manual'
    and request.source_record_key = concat('parking-fee:', new.parking_lease_contract_unit_id)
    and request.request_type = 'parking_fee_setup'
    and request.status not in ('applied', 'excluded');

  for closed_request in
    update public.change_request request
    set status = 'applied',
        resolved_at = now(), resolved_by = auth.uid(),
        applied_at = now(), applied_by = auth.uid(),
        resolution_payload = jsonb_build_object(
          'parking_fee_history_id', new.parking_fee_history_id,
          'monthly_parking_fee', new.monthly_parking_fee,
          'effective_from', new.effective_from,
          'main_lease_contract_unit_id', new.main_lease_contract_unit_id
        ),
        row_version = row_version + 1,
        updated_by = auth.uid(), updated_at = now()
    where request.source_type = 'manual'
      and request.source_record_key = concat('parking-fee:', new.parking_lease_contract_unit_id)
      and request.request_type = 'parking_fee_setup'
      and request.status not in ('applied', 'excluded')
    returning request.change_request_id
  loop
    insert into public.change_request_action_log (
      change_request_id, action_type, previous_status, next_status, details, performed_by
    ) values (
      closed_request.change_request_id, 'applied', 'open', 'applied',
      jsonb_build_object('parking_fee_history_id', new.parking_fee_history_id), auth.uid()
    );
  end loop;
  return new;
end;
$$;

revoke all on function private.close_parking_fee_change_request() from public, anon, authenticated;

drop trigger if exists close_parking_fee_change_request_after_write on public.parking_fee_history;
create trigger close_parking_fee_change_request_after_write
after insert or update of monthly_parking_fee, effective_from, main_lease_contract_unit_id
on public.parking_fee_history
for each row execute procedure private.close_parking_fee_change_request();

drop function if exists public.close_parking_fee_change_request();

create or replace function private.apply_parking_fee_change_request(
  p_change_request_id uuid,
  p_expected_row_version integer,
  p_monthly_parking_fee numeric,
  p_effective_from date,
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
  main_lcu_id uuid;
  candidate_count integer;
  parking_record record;
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

  select * into request_record from public.change_request
  where change_request_id = p_change_request_id
    and request_type = 'parking_fee_setup'
    and status in ('open', 'in_review', 'on_hold')
    and row_version = p_expected_row_version
  for update;
  if not found then raise exception '対応依頼が更新済みか、確定できない状態です'; end if;

  select item.entity_id into parking_lcu_id
  from public.change_request_item item
  where item.change_request_id = p_change_request_id
    and item.entity_type = 'parking_fee_history'
  order by item.sort_order, item.created_at limit 1;
  if parking_lcu_id is null then raise exception '対象の駐車場契約区画が見つかりません'; end if;

  select detail.parking_scope, contract.tenant_id, unit.property_id,
         contract_unit.lease_start_date, contract_unit.lease_end_date
  into parking_record
  from public.lease_contract_unit contract_unit
  join public.lease_contract contract on contract.lease_contract_id = contract_unit.lease_contract_id
  join public.unit_master unit on unit.unit_id = contract_unit.unit_id
  join public.parking_contract_detail detail on detail.lease_contract_id = contract.lease_contract_id
  where contract_unit.lease_contract_unit_id = parking_lcu_id;
  if not found then raise exception '駐車場契約情報が見つかりません'; end if;
  parking_scope := parking_record.parking_scope;

  if parking_scope = 'internal' then
    main_lcu_id := p_main_lease_contract_unit_id;
    if main_lcu_id is null then
      select count(*), min(candidate.lease_contract_unit_id)
      into candidate_count, main_lcu_id
      from public.lease_contract_unit candidate
      join public.lease_contract main_contract on main_contract.lease_contract_id = candidate.lease_contract_id
      join public.unit_master main_unit on main_unit.unit_id = candidate.unit_id
      where main_contract.tenant_id = parking_record.tenant_id
        and main_unit.property_id = parking_record.property_id
        and main_unit.unit_type <> 'parking'
        and coalesce(candidate.lease_start_date, main_contract.contract_start_date) <= p_effective_from
        and coalesce(candidate.lease_end_date, main_contract.contract_end_date, 'infinity'::date)
          >= coalesce(parking_record.lease_end_date, 'infinity'::date);
      if candidate_count <> 1 then
        raise exception '控除対象の主契約区画を1件選択してください（候補%件）', candidate_count;
      end if;
    end if;
  else
    main_lcu_id := null;
  end if;

  perform public.set_parking_fee_history(
    parking_lcu_id, parking_scope, main_lcu_id, p_monthly_parking_fee,
    p_effective_from, null, null, '対応依頼', null, null
  );

  select * into request_record from public.change_request
  where change_request_id = p_change_request_id;
  return to_jsonb(request_record);
end;
$$;

revoke all on function private.apply_parking_fee_change_request(uuid, integer, numeric, date, uuid)
  from public, anon;
grant execute on function private.apply_parking_fee_change_request(uuid, integer, numeric, date, uuid)
  to authenticated;

create or replace function public.apply_parking_fee_change_request(
  p_change_request_id uuid,
  p_expected_row_version integer,
  p_monthly_parking_fee numeric,
  p_effective_from date,
  p_main_lease_contract_unit_id uuid default null
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog, public, private
as $$
  select private.apply_parking_fee_change_request(
    p_change_request_id, p_expected_row_version, p_monthly_parking_fee,
    p_effective_from, p_main_lease_contract_unit_id
  );
$$;

revoke all on function public.apply_parking_fee_change_request(uuid, integer, numeric, date, uuid)
  from public, anon;
grant execute on function public.apply_parking_fee_change_request(uuid, integer, numeric, date, uuid)
  to authenticated;

comment on function public.apply_parking_fee_change_request(uuid, integer, numeric, date, uuid)
is '管理者・マネージャーを再検証する非公開関数を介し、対応依頼テーブルを直接公開せず駐車料を確定する。';
