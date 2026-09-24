-- Keep the candidate RPC aligned with the actual property master table.
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
  definition := replace(definition, 'public.property_master property', 'public.asset_master property');
  definition := replace(definition, 'property.property_name', 'property.asset_name');
  execute definition;
end;
$$;
