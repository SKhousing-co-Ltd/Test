-- Ensure the representative applications exist in a freshly bootstrapped
-- database as well as classifying the corresponding production definitions.
insert into public.appsuite_application (
  app_id, app_name, app_status, is_sync_enabled,
  business_domain, processing_type, workflow_start_at
)
values
  ('62', '【BM】＜BU＞物品購入稟議書', 'running', true, 'procurement', 'purchase_order', now()),
  ('87', '【BM】＜SHU＞修繕発注稟議書', 'running', true, 'procurement', 'repair_order', null),
  ('71', '＜BCA＞ビル貸室解約報告書', 'running', true, 'lease_contract', 'contract_terminate', now()),
  ('75', '＜CCA＞駐車場・駐輪場解約報告書', 'running', true, 'lease_contract', 'contract_terminate', now()),
  ('76', '＜ICA＞設置物（看板・アンテナ等）解約報告書', 'running', true, 'lease_contract', 'contract_terminate', now()),
  ('110', '＜RCA＞レジデンス貸室解約報告書', 'running', true, 'lease_contract', 'contract_terminate', now())
on conflict (app_id) do update
set business_domain = excluded.business_domain,
    processing_type = excluded.processing_type,
    workflow_start_at = coalesce(public.appsuite_application.workflow_start_at, excluded.workflow_start_at),
    is_sync_enabled = true;
