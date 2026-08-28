begin;

insert into public.asset_master(asset_code, asset_name)
values (990099, '契約期限テスト物件')
on conflict (asset_code) do update set asset_name = excluded.asset_name;

do $$
declare
  property_uuid uuid;
  ordinary_unit uuid;
  fixed_unit uuid;
  tenant_uuid uuid;
  ordinary_contract uuid;
  fixed_contract uuid;
  successor_contract uuid;
  ordinary_count integer;
  fixed_count integer;
begin
  if to_regprocedure('public.lease_contract_is_effective_at_date(text,text,date,date,date,date)') is null
     or to_regprocedure('public.rent_roll_list_with_terms_at_date(uuid,date)') is null
     or to_regprocedure('public.sync_contract_deadline_change_requests(date)') is null
     or to_regprocedure('public.confirm_contract_term_type(uuid,integer,integer,text,date,date)') is null
     or to_regprocedure('public.set_next_ordinary_renewal_due_date(uuid,integer,integer,date)') is null
     or to_regprocedure('public.resolve_fixed_term_contract_end(uuid,integer,integer,text,date,date,date,jsonb,text)') is null then
    raise exception '契約期限管理RPCが不足しています';
  end if;
  if has_function_privilege('anon', 'public.sync_contract_deadline_change_requests(date)', 'EXECUTE')
     or has_function_privilege('anon', 'public.resolve_fixed_term_contract_end(uuid,integer,integer,text,date,date,date,jsonb,text)', 'EXECUTE') then
    raise exception '匿名ユーザーが契約期限書込RPCを実行できます';
  end if;
  if not has_function_privilege('authenticated', 'public.sync_contract_deadline_change_requests(date)', 'EXECUTE') then
    raise exception '認証ユーザーへ契約期限同期RPCが公開されていません';
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'contract_deadline_notification_setting'
      and policyname = 'managers update contract deadline settings'
  ) then raise exception '期限通知設定の管理者RLSがありません'; end if;
  if (select lead_days from public.contract_deadline_notification_setting where issue_type = 'ordinary_renewal') <> 180
     or (select lead_days from public.contract_deadline_notification_setting where issue_type = 'fixed_term_end') <> 180 then
    raise exception '期限通知の初期値が180日ではありません';
  end if;

  if not public.lease_contract_is_effective_at_date('active', 'ordinary', date '2024-01-01', null, null, date '2030-01-01') then
    raise exception '普通賃貸借が更新予定日相当の経過で終了しています';
  end if;
  if public.lease_contract_is_effective_at_date('active', 'ordinary', date '2024-01-01', null, date '2026-03-31', date '2026-04-01') then
    raise exception '普通賃貸借が実終了日の翌日も有効です';
  end if;
  if not public.lease_contract_is_effective_at_date('active', 'fixed_term', date '2024-01-01', date '2026-03-31', null, date '2026-03-31')
     or public.lease_contract_is_effective_at_date('active', 'fixed_term', date '2024-01-01', date '2026-03-31', null, date '2026-04-01') then
    raise exception '定期賃貸借の終了日境界が正しくありません';
  end if;
  if public.lease_contract_is_effective_at_date('scheduled', 'fixed_term', date '2027-01-01', date '2028-12-31', null, date '2026-12-31')
     or not public.lease_contract_is_effective_at_date('scheduled', 'fixed_term', date '2027-01-01', date '2028-12-31', null, date '2027-01-01') then
    raise exception 'scheduled契約の開始日境界が正しくありません';
  end if;

  select asset_id into property_uuid from public.asset_master where asset_code = 990099;
  insert into public.unit_master(property_id, unit_code, floor_label, unit_type, rentable_area_sqm)
  values (property_uuid, 'TERM-ORD', '1F', 'office', 30),
         (property_uuid, 'TERM-FIX', '2F', 'office', 40);
  select unit_id into fixed_unit from public.unit_master
  where property_id = property_uuid and unit_code = 'TERM-FIX';
  select unit_id into ordinary_unit from public.unit_master
  where property_id = property_uuid and unit_code = 'TERM-ORD';

  insert into public.tenant_master(external_tenant_code, tenant_name, normalized_tenant_name)
  values ('TERM-TEST', '契約期限テストテナント', '契約期限テストテナント')
  returning tenant_id into tenant_uuid;

  insert into public.lease_contract(
    tenant_id, contract_status, contract_type, lease_term_type,
    contract_start_date, renewal_due_date
  ) values (
    tenant_uuid, 'active', 'lease', 'ordinary', date '2024-01-01', date '2026-09-30'
  ) returning lease_contract_id into ordinary_contract;
  insert into public.lease_contract_unit(
    lease_contract_id, unit_id, lease_start_date, monthly_rent_amount
  ) values (ordinary_contract, ordinary_unit, date '2024-01-01', 100000);

  insert into public.lease_contract(
    tenant_id, contract_status, contract_type, lease_term_type,
    contract_start_date, contract_end_date
  ) values (
    tenant_uuid, 'active', 'lease', 'fixed_term', date '2024-04-01', date '2026-09-30'
  ) returning lease_contract_id into fixed_contract;
  insert into public.lease_contract_unit(
    lease_contract_id, unit_id, lease_start_date, lease_end_date, monthly_rent_amount
  ) values (fixed_contract, fixed_unit, date '2024-04-01', date '2026-09-30', 120000);

  if not exists (
    select 1 from public.lease_contract_unit_snapshot_at_date(property_uuid, date '2026-09-30')
    where lease_contract_id = fixed_contract
  ) or exists (
    select 1 from public.lease_contract_unit_snapshot_at_date(property_uuid, date '2026-10-01')
    where lease_contract_id = fixed_contract
  ) then raise exception 'Snapshotが定期賃貸借の終了日境界を守っていません'; end if;
  if not exists (
    select 1 from public.lease_contract_unit_snapshot_at_date(property_uuid, date '2030-01-01')
    where lease_contract_id = ordinary_contract
  ) then raise exception 'Snapshotが普通賃貸借を無期限掲載していません'; end if;

  perform private.sync_contract_deadline_change_requests_internal(date '2026-04-03', null);
  select count(*) into ordinary_count from public.change_request
  where request_type = 'contract_renewal_due' and lease_contract_id = ordinary_contract;
  select count(*) into fixed_count from public.change_request
  where request_type = 'fixed_term_contract_end' and lease_contract_id = fixed_contract;
  if ordinary_count <> 1 or fixed_count <> 1 then
    raise exception '180日前の契約期限依頼が生成されません';
  end if;
  perform private.sync_contract_deadline_change_requests_internal(date '2026-04-03', null);
  if (select count(*) from public.change_request where request_type = 'contract_renewal_due' and lease_contract_id = ordinary_contract) <> 1
     or (select count(*) from public.change_request where request_type = 'fixed_term_contract_end' and lease_contract_id = fixed_contract) <> 1 then
    raise exception '契約期限依頼が重複生成されました';
  end if;

  insert into public.lease_contract(
    tenant_id, contract_status, contract_type, lease_term_type,
    contract_start_date, contract_end_date, renewed_from_contract_id
  ) values (
    tenant_uuid, 'scheduled', 'lease', 'fixed_term', date '2026-10-01', date '2028-09-30', fixed_contract
  ) returning lease_contract_id into successor_contract;
  if (select tenant_id from public.lease_contract where lease_contract_id = successor_contract) <> tenant_uuid then
    raise exception '再契約が同じTenantを保持していません';
  end if;
  begin
    insert into public.lease_contract(
      tenant_id, contract_status, contract_type, lease_term_type,
      contract_start_date, contract_end_date, renewed_from_contract_id
    ) values (
      tenant_uuid, 'scheduled', 'lease', 'fixed_term', date '2026-10-01', date '2027-09-30', fixed_contract
    );
    raise exception '同じ旧契約から二重に再契約できました';
  exception when unique_violation then null;
  end;

  begin
    update public.lease_contract set contract_end_date = date '2027-01-01'
    where lease_contract_id = ordinary_contract;
    raise exception '普通賃貸借へ契約終了日を設定できました';
  exception when check_violation then null;
  end;
end;
$$;

rollback;
