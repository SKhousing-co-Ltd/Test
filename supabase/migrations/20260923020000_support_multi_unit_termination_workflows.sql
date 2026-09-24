alter table public.workflow_contract_link
  drop constraint if exists uq_workflow_contract_link_record_contract;

create unique index if not exists uq_workflow_contract_link_record_contract_unit
  on public.workflow_contract_link (
    appsuite_record_id,
    lease_contract_id,
    coalesce(lease_contract_unit_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

comment on table public.workflow_contract_link is
  'AppSuite workflowと契約・契約区画の関係。複数区画案件は同一workflow/contractに区画ごとの行を持つ。';

create or replace function public.confirm_workflow_contract_links(
  p_appsuite_record_id uuid,
  p_lease_contract_id uuid,
  p_lease_contract_unit_ids uuid[],
  p_link_role varchar default 'primary',
  p_effective_date date default null,
  p_target_scope varchar default 'unit'
)
returns setof public.workflow_contract_link
language plpgsql
security definer
set search_path = public
as $$
declare
  v_unit_id uuid;
  v_link public.workflow_contract_link;
begin
  if coalesce(array_length(p_lease_contract_unit_ids, 1), 0) = 0 then
    raise exception 'At least one contract unit is required';
  end if;
  foreach v_unit_id in array p_lease_contract_unit_ids loop
    select * into v_link from public.confirm_workflow_contract_link(
      p_appsuite_record_id, p_lease_contract_id, p_link_role, p_effective_date,
      v_unit_id, p_target_scope
    );
    return next v_link;
  end loop;
end;
$$;

revoke all on function public.confirm_workflow_contract_links(uuid, uuid, uuid[], varchar, date, varchar) from public, anon;
grant execute on function public.confirm_workflow_contract_links(uuid, uuid, uuid[], varchar, date, varchar) to authenticated;
