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

  return query
    select * from public.case_progress_migration_verification
    order by source_row_number;
end;
$$;
