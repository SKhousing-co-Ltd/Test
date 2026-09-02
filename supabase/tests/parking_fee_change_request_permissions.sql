begin;

do $$
declare
  trigger_function regprocedure;
  commit_function_is_definer boolean;
begin
  if has_table_privilege('authenticated', 'public.change_request', 'update') then
    raise exception 'change_request must remain read-only through the Data API';
  end if;
  if has_table_privilege('authenticated', 'public.change_request_item', 'update') then
    raise exception 'change_request_item must remain read-only through the Data API';
  end if;
  if not has_function_privilege(
    'authenticated',
    'public.apply_parking_fee_change_request(uuid,integer,numeric,date,date,uuid)',
    'execute'
  ) then raise exception 'authenticated cannot execute the parking fee RPC'; end if;

  select function.prosecdef into commit_function_is_definer
  from pg_proc function
  where function.oid = 'public.commit_parking_import(uuid)'::regprocedure;
  if not coalesce(commit_function_is_definer, false) then
    raise exception 'parking import must execute its authorized change-request workflow with definer privileges';
  end if;

  select trigger.tgfoid::regprocedure into trigger_function
  from pg_trigger trigger
  where trigger.tgrelid = 'public.parking_fee_history'::regclass
    and trigger.tgname = 'close_parking_fee_change_request_after_write'
    and not trigger.tgisinternal;
  if trigger_function::text <> 'private.close_parking_fee_change_request()' then
    raise exception 'parking fee close trigger does not use the private handler';
  end if;

  if not exists (
    select 1 from pg_proc function
    join pg_namespace namespace on namespace.oid = function.pronamespace
    where namespace.nspname = 'private'
      and function.proname = 'apply_parking_fee_change_request'
      and function.prosecdef
  ) then raise exception 'private parking fee handler is not security definer'; end if;
end;
$$;

rollback;
