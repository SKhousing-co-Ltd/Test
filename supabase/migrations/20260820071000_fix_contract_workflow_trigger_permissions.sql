-- This helper is only reached from contract-table triggers. Keep it revoked
-- from callers while allowing the trigger path to invoke its internal writer.
alter function public.reconcile_appsuite_contract_workflow_for_contract(uuid)
  security definer;
alter function public.reconcile_appsuite_contract_workflow_for_contract(uuid)
  set search_path = public;
revoke all on function public.reconcile_appsuite_contract_workflow_for_contract(uuid) from public;
