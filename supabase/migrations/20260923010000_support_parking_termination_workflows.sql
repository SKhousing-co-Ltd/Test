alter table public.workflow_contract_link
  add column if not exists lease_contract_unit_id uuid references public.lease_contract_unit(lease_contract_unit_id) on delete restrict,
  add column if not exists target_scope varchar(20) not null default 'contract';

alter table public.workflow_contract_link
  drop constraint if exists ck_workflow_contract_link_scope;
alter table public.workflow_contract_link
  add constraint ck_workflow_contract_link_scope
  check (target_scope in ('contract', 'unit', 'parking'));

create index if not exists ix_workflow_contract_link_unit
  on public.workflow_contract_link(lease_contract_unit_id)
  where lease_contract_unit_id is not null;

create or replace function public.confirm_workflow_contract_link(
  p_appsuite_record_id uuid,
  p_lease_contract_id uuid,
  p_link_role varchar default 'primary',
  p_effective_date date default null,
  p_lease_contract_unit_id uuid default null,
  p_target_scope varchar default 'contract'
)
returns public.workflow_contract_link
language plpgsql
security definer
set search_path = public
as $$
declare
  v_record public.appsuite_record;
  v_link public.workflow_contract_link;
  v_request_id uuid;
begin
  if not public.current_account_is_active() or public.current_account_role() not in ('admin', 'manager', 'staff') then
    raise exception 'Active operator account required';
  end if;
  if p_link_role not in ('primary', 'source', 'target', 'related') then raise exception 'Invalid link role'; end if;
  if p_target_scope not in ('contract', 'unit', 'parking') then raise exception 'Invalid target scope'; end if;
  if p_target_scope = 'parking' and p_lease_contract_unit_id is null then raise exception 'Parking termination requires a contract unit'; end if;
  if p_lease_contract_unit_id is not null and not exists (
    select 1 from public.lease_contract_unit unit
    join public.unit_master master on master.unit_id = unit.unit_id
    where unit.lease_contract_unit_id = p_lease_contract_unit_id
      and unit.lease_contract_id = p_lease_contract_id
      and (p_target_scope <> 'parking' or master.unit_type = 'parking')
  ) then raise exception 'Contract unit does not belong to the contract or is not parking'; end if;

  select * into v_record from public.appsuite_record where appsuite_record_id = p_appsuite_record_id;
  if not found then raise exception 'AppSuite record not found'; end if;

  insert into public.workflow_contract_link (
    appsuite_record_id, lease_contract_id, lease_contract_unit_id, target_scope,
    link_role, effective_date, confirmed_at, confirmed_by, link_source
  ) values (
    p_appsuite_record_id, p_lease_contract_id, p_lease_contract_unit_id, p_target_scope,
    p_link_role, p_effective_date, now(), auth.uid(), 'manual'
  )
  on conflict (appsuite_record_id, lease_contract_id) do update set
    lease_contract_unit_id = excluded.lease_contract_unit_id,
    target_scope = excluded.target_scope,
    link_role = excluded.link_role,
    effective_date = excluded.effective_date,
    confirmed_at = excluded.confirmed_at,
    confirmed_by = excluded.confirmed_by,
    link_source = 'manual'
  returning * into v_link;

  update public.workflow_contract_match_audit
     set confirmed_lease_contract_id = p_lease_contract_id, confirmed_at = now(), confirmed_by = auth.uid()
   where workflow_contract_match_audit_id = (
     select workflow_contract_match_audit_id from public.workflow_contract_match_audit
      where appsuite_record_id = p_appsuite_record_id order by evaluated_at desc limit 1
   );

  select change_request_id into v_request_id
    from public.change_request
   where source_type = 'desknets'
     and source_record_key = concat(v_record.app_id, ':', v_record.data_id)
     and request_type = (select processing_type from public.appsuite_application where app_id = v_record.app_id)
     and status not in ('applied', 'excluded')
   order by created_at desc limit 1;
  if v_request_id is not null then
    update public.change_request
       set proposed_payload = proposed_payload || jsonb_build_object(
         'workflow_contract_link', jsonb_build_object(
           'lease_contract_id', p_lease_contract_id,
           'lease_contract_unit_id', p_lease_contract_unit_id,
           'target_scope', p_target_scope,
           'link_role', p_link_role,
           'effective_date', p_effective_date,
           'confirmed_at', now()
         )
       )
     where change_request_id = v_request_id;
  end if;
  return v_link;
end;
$$;

revoke all on function public.confirm_workflow_contract_link(uuid, uuid, varchar, date, uuid, varchar) from public, anon;
grant execute on function public.confirm_workflow_contract_link(uuid, uuid, varchar, date, uuid, varchar) to authenticated;
