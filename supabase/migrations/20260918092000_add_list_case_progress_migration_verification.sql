-- appsuite_record has RLS enabled ("active users read appsuite records" using
-- current_account_is_active()). Because that policy's function is not
-- LEAKPROOF (only a superuser may mark a function LEAKPROOF, which Supabase
-- does not grant), Postgres refuses to push the lateral join condition in
-- case_progress_migration_verification past the RLS security barrier and
-- into ix_appsuite_record_normalized_ringi. It falls back to a sequential
-- scan of appsuite_record per staging row, which exceeds the authenticated
-- role's 8s statement_timeout ("canceling statement due to statement
-- timeout") once the staging table has a few hundred rows.
--
-- appsuite_record does not have FORCE ROW LEVEL SECURITY set, so a
-- SECURITY DEFINER function (owned by the table owner) bypasses RLS on it
-- entirely -- same pattern already used by list_contract_workflow_queue and
-- complete_contract_workflow. That removes the security barrier, so the
-- planner can use the index again.

create or replace function public.list_case_progress_migration_verification()
returns setof public.case_progress_migration_verification
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.current_account_is_admin() then
    raise exception 'Admin access required';
  end if;

  return query select * from public.case_progress_migration_verification;
end;
$$;

revoke all on function public.list_case_progress_migration_verification() from public, anon, authenticated;
grant execute on function public.list_case_progress_migration_verification() to authenticated;

-- Querying the view directly as `authenticated` still hits the slow RLS
-- path above; force callers through the function instead.
revoke select on public.case_progress_migration_verification from authenticated;
