-- Preserve the RPC output names after switching to asset_master.
do $$
declare
  definition text;
begin
  select pg_get_functiondef(p.oid)
    into definition
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'list_workflow_contract_candidates'
     and pg_get_function_identity_arguments(p.oid) = 'p_appsuite_record_id uuid';
  if definition is null then
    raise exception 'Candidate function not found';
  end if;
  definition := replace(definition, 'property.asset_id, property.asset_name::text, contract_unit.lease_contract_unit_id',
                                  'property.asset_id as property_id, property.asset_name::text as property_name, contract_unit.lease_contract_unit_id');
  execute definition;
end;
$$;
