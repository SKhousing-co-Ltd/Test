create or replace function public.normalize_contract_workflow_key(value text)
returns text
language sql
immutable
parallel safe
set search_path = public
as $$
  select lower(regexp_replace(btrim(coalesce(value, '')), '[[:space:]　]+', '', 'g'));
$$;

revoke all on function public.normalize_contract_workflow_key(text) from public;
