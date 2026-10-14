begin;

do $$
begin
  if has_function_privilege('anon', 'public.merge_contract_unit_into_contract(uuid,uuid)', 'EXECUTE') then raise exception 'anon must not merge contract units'; end if;
  if not has_function_privilege('authenticated', 'public.merge_contract_unit_into_contract(uuid,uuid)', 'EXECUTE') then raise exception 'authenticated role must reach merge RPC role checks'; end if;
  if has_function_privilege('anon', 'public.withdraw_contract_workflow(uuid,text)', 'EXECUTE') then raise exception 'anon must not withdraw workflows'; end if;
  if not has_function_privilege('authenticated', 'public.withdraw_contract_workflow(uuid,text)', 'EXECUTE') then raise exception 'authenticated role must reach withdrawal RPC role checks'; end if;
end $$;

select '1..1';
select 'ok 1 - contract unit merge and workflow withdrawal privileges';
rollback;
