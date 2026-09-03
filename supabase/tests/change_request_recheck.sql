begin;

do $$
declare
  internal_definition text;
  parking_trigger_function regprocedure;
  contract_trigger_function regprocedure;
  contract_unit_trigger_function regprocedure;
  tenant_trigger_function regprocedure;
begin
  if to_regprocedure('public.recheck_change_request(uuid,integer)') is null then
    raise exception 'individual change request recheck RPC is missing';
  end if;
  if to_regprocedure('public.recheck_open_change_requests()') is null then
    raise exception 'batch change request recheck RPC is missing';
  end if;
  if to_regprocedure('private.recheck_change_request_internal(uuid,integer)') is null then
    raise exception 'private change request recheck handler is missing';
  end if;

  if not has_function_privilege(
    'authenticated', 'public.recheck_change_request(uuid,integer)', 'execute'
  ) then raise exception 'authenticated cannot execute individual recheck'; end if;
  if not has_function_privilege(
    'authenticated', 'public.recheck_open_change_requests()', 'execute'
  ) then raise exception 'authenticated cannot execute batch recheck'; end if;
  if has_function_privilege(
    'anon', 'public.recheck_change_request(uuid,integer)', 'execute'
  ) then raise exception 'anon can execute individual recheck'; end if;
  if has_function_privilege(
    'anon', 'public.recheck_open_change_requests()', 'execute'
  ) then raise exception 'anon can execute batch recheck'; end if;

  if exists (
    select 1
    from pg_proc function
    join pg_namespace namespace on namespace.oid = function.pronamespace
    where namespace.nspname = 'public'
      and function.proname in ('recheck_change_request', 'recheck_open_change_requests')
      and function.prosecdef
  ) then raise exception 'public recheck RPC must remain security invoker'; end if;

  if not exists (
    select 1
    from pg_proc function
    join pg_namespace namespace on namespace.oid = function.pronamespace
    where namespace.nspname = 'private'
      and function.proname = 'recheck_change_request_internal'
      and function.prosecdef
      and exists (
        select 1 from unnest(coalesce(function.proconfig, array[]::text[])) setting
        where setting in ('search_path=', 'search_path=""')
      )
  ) then raise exception 'private recheck handler must be a pinned security definer'; end if;

  select pg_get_functiondef(
    'private.recheck_change_request_internal(uuid,integer)'::regprocedure
  ) into internal_definition;
  if internal_definition not like '%parking_fee_setup%'
     or internal_definition not like '%multiple_tenant_codes%'
     or internal_definition not like '%contract_fields%'
     or internal_definition not like '%parking_fee_setup_state%'
     or internal_definition not like '%current_business_data_recheck%'
     or internal_definition not like '%status = ''applied''%'
     or internal_definition not like '%rent_roll_import_issue%' then
    raise exception 'recheck handler is missing a supported domain or audit update';
  end if;

  if internal_definition not like '%v_validation_message%'
     or internal_definition like '%else validation_message end%' then
    raise exception 'parking recheck validation message reference is ambiguous';
  end if;

  if pg_get_functiondef(
    'public.enqueue_parking_fee_change_request(uuid,uuid,uuid)'::regprocedure
  ) not like '%private.parking_fee_setup_state%' then
    raise exception 'parking request creation and recheck do not share the same evaluator';
  end if;

  select trigger.tgfoid::regprocedure into parking_trigger_function
  from pg_trigger trigger
  where trigger.tgrelid = 'public.parking_fee_history'::regclass
    and trigger.tgname = 'close_parking_fee_change_request_after_write'
    and not trigger.tgisinternal;
  if parking_trigger_function::text <> 'private.close_parking_fee_change_request()' then
    raise exception 'parking fee writes do not use the private recheck bridge';
  end if;

  select trigger.tgfoid::regprocedure into contract_trigger_function
  from pg_trigger trigger
  where trigger.tgrelid = 'public.lease_contract'::regclass
    and trigger.tgname = 'recheck_change_requests_after_contract_update'
    and not trigger.tgisinternal;
  select trigger.tgfoid::regprocedure into contract_unit_trigger_function
  from pg_trigger trigger
  where trigger.tgrelid = 'public.lease_contract_unit'::regclass
    and trigger.tgname = 'recheck_change_requests_after_contract_unit_update'
    and not trigger.tgisinternal;
  if contract_trigger_function::text <> 'private.recheck_contract_change_requests_after_update()'
     or contract_unit_trigger_function::text <> 'private.recheck_contract_change_requests_after_update()' then
    raise exception 'rent-roll contract writes do not use the common recheck bridge';
  end if;
  if exists (
    select 1
    from pg_trigger trigger
    where trigger.tgname in (
      'recheck_change_requests_after_contract_update',
      'recheck_change_requests_after_contract_unit_update'
    )
      and (not trigger.tgdeferrable or not trigger.tginitdeferred)
  ) then
    raise exception 'contract rechecks must run against final transaction values';
  end if;

  select trigger.tgfoid::regprocedure into tenant_trigger_function
  from pg_trigger trigger
  where trigger.tgrelid = 'public.tenant_master'::regclass
    and trigger.tgname = 'recheck_tenant_billing_requests_after_update'
    and not trigger.tgisinternal;
  if tenant_trigger_function::text <> 'private.recheck_tenant_billing_requests_after_update()' then
    raise exception 'tenant billing code writes do not use the common recheck bridge';
  end if;

  if has_table_privilege('authenticated', 'public.change_request', 'update')
     or has_table_privilege('authenticated', 'public.change_request_item', 'update') then
    raise exception 'change request tables must remain read-only through the Data API';
  end if;

  if not private.change_request_values_equal(
    'monthly_rent_amount', '33000'::jsonb, '"33000"'::jsonb
  ) then raise exception 'numeric recheck comparison must normalize JSON strings'; end if;
  if not private.change_request_values_equal(
    'lease_end_date', '"2027-06-30"'::jsonb, '"2027-06-30"'::jsonb
  ) then raise exception 'date recheck comparison failed'; end if;
end;
$$;

rollback;
