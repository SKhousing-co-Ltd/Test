-- Fix permission denied issues for reconcile_appsuite_contract_workflow_for_contract
-- and reconcile_appsuite_contract_workflow by running the triggers with security definer.

alter function public.trg_reconcile_appsuite_contract_workflow_record()
  security definer
  set search_path = public;

alter function public.trg_reconcile_appsuite_contract_workflow_contract()
  security definer
  set search_path = public;

alter function public.trg_reconcile_appsuite_contract_workflow_unit()
  security definer
  set search_path = public;
