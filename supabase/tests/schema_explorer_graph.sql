begin;

do $$
declare
  v_admin_id uuid;
  v_non_admin_id uuid;
  v_admin_employee_id uuid;
  v_non_admin_employee_id uuid;
  v_graph jsonb;
begin
  if to_regprocedure('public.get_schema_explorer_graph()') is null then
    raise exception 'get_schema_explorer_graph RPC is missing';
  end if;
  if has_function_privilege('anon', 'public.get_schema_explorer_graph()', 'execute') then
    raise exception 'anon must not execute schema explorer RPC';
  end if;
  if not has_function_privilege('authenticated', 'public.get_schema_explorer_graph()', 'execute') then
    raise exception 'authenticated must be granted schema explorer RPC access';
  end if;
  if not (select prosecdef from pg_proc where oid = 'public.get_schema_explorer_graph()'::regprocedure) then
    raise exception 'schema explorer RPC must use controlled definer privileges';
  end if;
  if pg_get_functiondef('public.get_schema_explorer_graph()'::regprocedure) !~ 'current_account_is_admin' then
    raise exception 'schema explorer RPC must verify administrator status';
  end if;
  if pg_get_functiondef('public.get_schema_explorer_graph()'::regprocedure) !~ 'auth\.users' then
    raise exception 'schema explorer RPC must represent auth.users only as an external node';
  end if;
  if not exists (
    select 1 from pg_proc function
    where function.oid = 'public.get_schema_explorer_graph()'::regprocedure
      and function.proconfig @> array['search_path=pg_catalog']
  ) then
    raise exception 'schema explorer RPC search_path must be restricted to pg_catalog';
  end if;

  insert into public.employee_master (employee_name, email)
  values ('Schema Explorer Admin', 'schema-explorer-test-admin@example.invalid')
  returning employee_id into v_admin_employee_id;
  insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values (gen_random_uuid(), 'authenticated', 'authenticated', 'schema-explorer-test-admin@example.invalid', '{}'::jsonb, '{}'::jsonb, now(), now())
  returning id into v_admin_id;
  update public.user_profiles set role = 'admin' where user_id = v_admin_id;

  perform set_config('request.jwt.claim.sub', v_admin_id::text, true);
  select public.get_schema_explorer_graph() into v_graph;
  if not exists (select 1 from jsonb_array_elements(v_graph->'tables') node where node->>'schema' = 'public') then
    raise exception 'schema explorer result must include public tables';
  end if;
  if not exists (select 1 from jsonb_array_elements(v_graph->'relationships') edge where edge->>'target' = 'auth.users') then
    raise exception 'schema explorer result must include auth.users FK as an external relationship';
  end if;
  if exists (select 1 from jsonb_array_elements(v_graph->'tables') node where node->>'id' = 'auth.users' and jsonb_array_length(node->'columns') <> 0) then
    raise exception 'auth.users external node must not expose auth columns';
  end if;

  insert into public.employee_master (employee_name, email)
  values ('Schema Explorer Staff', 'schema-explorer-test-staff@example.invalid')
  returning employee_id into v_non_admin_employee_id;
  insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values (gen_random_uuid(), 'authenticated', 'authenticated', 'schema-explorer-test-staff@example.invalid', '{}'::jsonb, '{}'::jsonb, now(), now())
  returning id into v_non_admin_id;
  perform set_config('request.jwt.claim.sub', v_non_admin_id::text, true);
  begin
    perform public.get_schema_explorer_graph();
    raise exception 'non-admin must not receive schema explorer data';
  exception when raise_exception then
    if sqlerrm = 'non-admin must not receive schema explorer data' then raise; end if;
  end;
end;
$$;

rollback;
