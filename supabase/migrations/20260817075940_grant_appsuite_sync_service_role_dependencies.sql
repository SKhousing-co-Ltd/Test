-- Edge sync uses service_role, while appsuite_record triggers intentionally run
-- as the invoker. Grant only the read and workflow-write dependencies required
-- by those triggers; no browser role or business-master write access is added.

grant select on table
  public.asset_master,
  public.tenant_master,
  public.lease_contract,
  public.lease_contract_unit,
  public.unit_master,
  public.vendor_master,
  public.income_expense_account_master,
  public.procurement_order
to service_role;

grant select, insert, update on table
  public.change_request,
  public.change_request_item
to service_role;

grant select, insert on table
  public.change_request_action_log
to service_role;

grant execute on function
  public.normalize_contract_workflow_key(text),
  public.reconcile_appsuite_contract_workflow(uuid),
  public.reconcile_appsuite_contract_workflow_for_contract(uuid)
to service_role;

comment on function public.reconcile_appsuite_contract_workflow(uuid) is
  'AppSuite同期レコードを既存契約へ照合する。Edge同期のservice_roleには実行と参照のみを許可する。';
