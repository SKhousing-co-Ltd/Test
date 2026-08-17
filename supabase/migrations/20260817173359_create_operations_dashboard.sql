-- 契約・レントロール・発注支払・LCC・外部連携を横断する運用ダッシュボード。
-- すべてsecurity_invokerで、基礎テーブルのRLSをそのまま適用する。

create or replace view public.operations_dashboard_summary
with (security_invoker = true)
as
select
  now() as generated_at,
  (select count(*)::integer from public.asset_master) as property_count,
  (select count(*)::integer from public.unit_master where is_active) as active_unit_count,
  (select count(distinct contract_unit.unit_id)::integer
     from public.lease_contract_unit as contract_unit
     join public.lease_contract as contract using (lease_contract_id)
    where contract.contract_status = 'active'
      and coalesce(contract_unit.lease_start_date, contract.contract_start_date, '-infinity'::date) <= current_date
      and coalesce(contract_unit.lease_end_date, contract.contract_end_date, 'infinity'::date) >= current_date) as occupied_unit_count,
  (select count(*)::integer from public.lease_contract where contract_status = 'active') as active_contract_count,
  (select count(*)::integer
     from public.lease_contract
    where contract_status = 'active'
      and contract_end_date between current_date and current_date + 90) as expiring_contract_90d_count,
  (select coalesce(sum(contract_unit.monthly_total_amount), 0)::numeric(16, 0)
     from public.lease_contract_unit as contract_unit
     join public.lease_contract as contract using (lease_contract_id)
    where contract.contract_status = 'active'
      and coalesce(contract_unit.lease_start_date, contract.contract_start_date, '-infinity'::date) <= current_date
      and coalesce(contract_unit.lease_end_date, contract.contract_end_date, 'infinity'::date) >= current_date) as monthly_contract_income,
  (select count(*)::integer
     from public.change_request
    where status not in ('applied', 'rejected', 'cancelled')) as open_change_request_count,
  ((select count(*) from public.appsuite_procurement_inbox where match_status = 'action_required')
    + (select count(*) from public.billone_invoice_inbox where match_status = 'action_required'))::integer as integration_issue_count,
  (select count(*)::integer
     from public.appsuite_application
    where is_sync_enabled
      and (last_synced_at is null or last_synced_at < now() - interval '36 hours')) as stale_sync_count,
  (select coalesce(sum(gross_amount), 0)::numeric(16, 0)
     from public.procurement_order
    where status not in ('completed', 'cancelled')) as open_order_amount,
  (select coalesce(sum(amount), 0)::numeric(16, 0)
     from public.payment_schedule
    where status not in ('paid', 'cancelled')) as unpaid_amount,
  (select count(*)::integer
     from public.payment_schedule
    where status not in ('paid', 'cancelled') and scheduled_date < current_date) as overdue_payment_count,
  (select coalesce(sum(planned_amount), 0)::numeric(16, 0)
     from public.lcc_plan_item
    where status not in ('completed', 'cancelled')
      and next_planned_date between current_date and current_date + 365) as lcc_12m_amount,
  (select count(*)::integer from public.financial_scenario where status = 'published') as published_scenario_count,
  (select max(accounting_month) from public.property_monthly_financial_entry) as latest_actual_month;

create or replace view public.operations_property_snapshot
with (security_invoker = true)
as
select
  asset.asset_id as property_id,
  asset.asset_code as property_code,
  asset.asset_name as property_name,
  asset.short_name,
  coalesce(unit_stats.active_unit_count, 0)::integer as active_unit_count,
  coalesce(occupancy.occupied_unit_count, 0)::integer as occupied_unit_count,
  case when coalesce(unit_stats.active_unit_count, 0) = 0 then 0
       else round(100.0 * coalesce(occupancy.occupied_unit_count, 0) / unit_stats.active_unit_count, 1)
  end as occupancy_rate,
  coalesce(occupancy.monthly_contract_income, 0)::numeric(16, 0) as monthly_contract_income,
  coalesce(order_totals.open_order_amount, 0)::numeric(16, 0) as open_order_amount,
  coalesce(payment_totals.unpaid_amount, 0)::numeric(16, 0) as unpaid_amount,
  coalesce(lcc_totals.lcc_12m_amount, 0)::numeric(16, 0) as lcc_12m_amount,
  coalesce(actual_totals.fiscal_ytd_net, 0)::numeric(16, 0) as fiscal_ytd_net
from public.asset_master as asset
left join lateral (
  select count(*) as active_unit_count
  from public.unit_master as unit
  where unit.property_id = asset.asset_id and unit.is_active
) as unit_stats on true
left join lateral (
  select
    count(distinct contract_unit.unit_id) as occupied_unit_count,
    coalesce(sum(contract_unit.monthly_total_amount), 0) as monthly_contract_income
  from public.lease_contract_unit as contract_unit
  join public.lease_contract as contract using (lease_contract_id)
  join public.unit_master as unit on unit.unit_id = contract_unit.unit_id
  where unit.property_id = asset.asset_id
    and contract.contract_status = 'active'
    and coalesce(contract_unit.lease_start_date, contract.contract_start_date, '-infinity'::date) <= current_date
    and coalesce(contract_unit.lease_end_date, contract.contract_end_date, 'infinity'::date) >= current_date
) as occupancy on true
left join lateral (
  select coalesce(sum(gross_amount), 0) as open_order_amount
  from public.procurement_order as orders
  where orders.property_id = asset.asset_id and orders.status not in ('completed', 'cancelled')
) as order_totals on true
left join lateral (
  select coalesce(sum(schedule.amount), 0) as unpaid_amount
  from public.payment_schedule as schedule
  join public.vendor_invoice as invoice using (vendor_invoice_id)
  where invoice.property_id = asset.asset_id and schedule.status not in ('paid', 'cancelled')
) as payment_totals on true
left join lateral (
  select coalesce(sum(item.planned_amount), 0) as lcc_12m_amount
  from public.lcc_plan_item as item
  where item.property_id = asset.asset_id
    and item.status not in ('completed', 'cancelled')
    and item.next_planned_date between current_date and current_date + 365
) as lcc_totals on true
left join lateral (
  select coalesce(sum(case when account.income_expense_type = '収入' then entry.amount else -entry.amount end), 0) as fiscal_ytd_net
  from public.property_monthly_financial_entry as entry
  join public.income_expense_account_master as account using (account_id)
  where entry.property_id = asset.asset_id
    and entry.accounting_month >= case when extract(month from current_date) >= 4
      then make_date(extract(year from current_date)::integer, 4, 1)
      else make_date(extract(year from current_date)::integer - 1, 4, 1)
    end
    and entry.accounting_month <= date_trunc('month', current_date)::date
) as actual_totals on true;

create or replace view public.operations_cashflow_monthly
with (security_invoker = true)
as
with months as (
  select generate_series(
    date_trunc('month', current_date) - interval '5 months',
    date_trunc('month', current_date) + interval '11 months',
    interval '1 month'
  )::date as accounting_month
)
select
  months.accounting_month,
  case when months.accounting_month < date_trunc('month', current_date)::date then 'actual'
       when months.accounting_month = date_trunc('month', current_date)::date then 'current'
       else 'forecast' end as period_type,
  coalesce(contract_income.amount, 0)::numeric(16, 0) as contract_income,
  coalesce(scheduled_payment.amount, 0)::numeric(16, 0) as scheduled_payment,
  coalesce(planned_lcc.amount, 0)::numeric(16, 0) as planned_lcc,
  coalesce(actual.amount, 0)::numeric(16, 0) as actual_net_cashflow,
  case when months.accounting_month < date_trunc('month', current_date)::date
       then coalesce(actual.amount, 0)
       else coalesce(contract_income.amount, 0) - coalesce(scheduled_payment.amount, 0) - coalesce(planned_lcc.amount, 0)
  end::numeric(16, 0) as known_net_cashflow
from months
left join lateral (
  select coalesce(sum(contract_unit.monthly_total_amount), 0) as amount
  from public.lease_contract_unit as contract_unit
  join public.lease_contract as contract using (lease_contract_id)
  where contract.contract_status = 'active'
    and coalesce(contract_unit.lease_start_date, contract.contract_start_date, '-infinity'::date) < (months.accounting_month + interval '1 month')::date
    and coalesce(contract_unit.lease_end_date, contract.contract_end_date, 'infinity'::date) >= months.accounting_month
) as contract_income on true
left join lateral (
  select coalesce(sum(schedule.amount), 0) as amount
  from public.payment_schedule as schedule
  where schedule.status not in ('paid', 'cancelled')
    and schedule.scheduled_date >= months.accounting_month
    and schedule.scheduled_date < (months.accounting_month + interval '1 month')::date
) as scheduled_payment on true
left join lateral (
  select coalesce(sum(item.planned_amount), 0) as amount
  from public.lcc_plan_item as item
  where item.status not in ('completed', 'cancelled')
    and item.next_planned_date >= months.accounting_month
    and item.next_planned_date < (months.accounting_month + interval '1 month')::date
) as planned_lcc on true
left join lateral (
  select coalesce(sum(case when account.income_expense_type = '収入' then entry.amount else -entry.amount end), 0) as amount
  from public.property_monthly_financial_entry as entry
  join public.income_expense_account_master as account using (account_id)
  where entry.accounting_month = months.accounting_month
) as actual on true
order by months.accounting_month;

create or replace view public.operations_dashboard_alert
with (security_invoker = true)
as
select
  'sync-stale:' || app.app_id as alert_id,
  'integration'::text as domain,
  case when app.last_synced_at is null or app.last_synced_at < now() - interval '72 hours' then 'critical' else 'warning' end::text as severity,
  'AppSuite定期同期が停止しています'::text as title,
  app.app_id || '｜' || app.app_name || '（最終成功: ' || coalesce(to_char(app.last_synced_at at time zone 'Asia/Tokyo', 'YYYY/MM/DD HH24:MI'), '未実行') || '）' as detail,
  current_date as alert_date,
  null::numeric(16, 0) as amount,
  '/appsuite-sync'::text as route,
  coalesce(app.last_synced_at, app.created_at) as occurred_at
from public.appsuite_application as app
where app.is_sync_enabled and (app.last_synced_at is null or app.last_synced_at < now() - interval '36 hours')
union all
select
  'sync-failed:' || latest.app_id,
  'integration',
  'critical',
  'AppSuite同期でエラーが発生しました',
  latest.app_id || '｜' || coalesce(latest.error_message, 'エラー詳細なし'),
  latest.started_at::date,
  null::numeric(16, 0),
  '/appsuite-sync',
  latest.started_at
from (
  select distinct on (run.app_id) run.*
  from public.appsuite_sync_run as run
  where run.app_id is not null
  order by run.app_id, run.started_at desc
) as latest
where latest.status = 'failed'
union all
select
  'appsuite-procurement-issues',
  'procurement',
  case when count(*) >= 100 then 'critical' else 'warning' end,
  'AppSuite発注に要確認データがあります',
  count(*) || '件を取引先・物件・金額と照合してください',
  current_date,
  coalesce(sum(gross_amount), 0)::numeric(16, 0),
  '/procurement',
  max(updated_at)
from public.appsuite_procurement_inbox
where match_status = 'action_required'
having count(*) > 0
union all
select
  'billone-invoice-issues',
  'procurement',
  'warning',
  'Bill One請求書に要確認データがあります',
  count(*) || '件を発注・取引先・支払期日と照合してください',
  current_date,
  coalesce(sum(gross_amount), 0)::numeric(16, 0),
  '/procurement',
  max(updated_at)
from public.billone_invoice_inbox
where match_status = 'action_required'
having count(*) > 0
union all
select
  'change-requests-open',
  'change_request',
  case when min(created_at) < now() - interval '7 days' then 'critical' else 'warning' end,
  '未処理の対応依頼があります',
  count(*) || '件（最古 ' || to_char(min(created_at) at time zone 'Asia/Tokyo', 'YYYY/MM/DD') || '）',
  min(created_at)::date,
  null::numeric(16, 0),
  '/change-requests',
  min(created_at)
from public.change_request
where status not in ('applied', 'rejected', 'cancelled')
having count(*) > 0
union all
select
  'payment-overdue:' || schedule.payment_schedule_id,
  'payment',
  'critical',
  '支払予定日を超過しています',
  coalesce(vendor.vendor_name, '取引先未設定') || '｜' || coalesce(invoice.invoice_number, '請求書番号なし'),
  schedule.scheduled_date,
  schedule.amount::numeric(16, 0),
  '/procurement',
  schedule.updated_at
from public.payment_schedule as schedule
join public.vendor_invoice as invoice using (vendor_invoice_id)
left join public.vendor_master as vendor using (vendor_id)
where schedule.status not in ('paid', 'cancelled') and schedule.scheduled_date < current_date
union all
select
  'contract-expiry:' || contract.lease_contract_id,
  'contract',
  case when contract.contract_end_date < current_date + 30 then 'critical' else 'warning' end,
  '契約終了日が近づいています',
  tenant.tenant_name || '｜終了日 ' || to_char(contract.contract_end_date, 'YYYY/MM/DD'),
  contract.contract_end_date,
  null::numeric(16, 0),
  '/contracts',
  contract.updated_at
from public.lease_contract as contract
join public.tenant_master as tenant using (tenant_id)
where contract.contract_status = 'active'
  and contract.contract_end_date between current_date and current_date + 90
union all
select
  'lcc-due:' || item.lcc_plan_item_id,
  'lcc',
  case when item.next_planned_date < current_date or item.priority = 'critical' then 'critical' else 'warning' end,
  'LCC実施時期が近づいています',
  asset.asset_name || '｜' || item.work_name,
  item.next_planned_date,
  item.planned_amount::numeric(16, 0),
  '/financial',
  item.updated_at
from public.lcc_plan_item as item
join public.asset_master as asset on asset.asset_id = item.property_id
where item.status not in ('completed', 'cancelled')
  and item.next_planned_date <= current_date + 180
union all
select
  'financial-scenario-missing',
  'financial',
  'warning',
  '公開済みの収支シナリオがありません',
  '来期以降の資金見通しを作成し、公開してください',
  current_date,
  null::numeric(16, 0),
  '/financial',
  now()
where not exists (select 1 from public.financial_scenario where status = 'published')
union all
select
  'financial-actual-missing',
  'financial',
  'warning',
  '月次収支実績が未登録です',
  '会計実績CSVを取り込み、予算・見通しとの比較を開始してください',
  current_date,
  null::numeric(16, 0),
  '/financial',
  now()
where not exists (select 1 from public.property_monthly_financial_entry);

revoke all on public.operations_dashboard_summary, public.operations_property_snapshot,
  public.operations_cashflow_monthly, public.operations_dashboard_alert from public;
grant select on public.operations_dashboard_summary, public.operations_property_snapshot,
  public.operations_cashflow_monthly, public.operations_dashboard_alert to authenticated;

comment on view public.operations_dashboard_summary is '契約・区画・対応依頼・発注支払・LCC・同期状態を横断する全社運用KPI。';
comment on view public.operations_property_snapshot is '物件別の稼働・契約収入・発注支払・LCC・年度実績スナップショット。';
comment on view public.operations_cashflow_monthly is '過去実績と今後の契約収入・確定支払・LCCを月別に並べた既知資金見通し。';
comment on view public.operations_dashboard_alert is '各業務領域の期限超過・未照合・同期停止・計画未整備を統合したアラート。';
