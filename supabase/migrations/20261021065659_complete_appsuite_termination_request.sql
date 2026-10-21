create table if not exists public.appsuite_termination_workflow (
  appsuite_record_id uuid primary key references public.appsuite_record(appsuite_record_id) on delete cascade,
  change_request_id uuid not null unique references public.change_request(change_request_id) on delete cascade,
  lease_contract_id uuid not null references public.lease_contract(lease_contract_id),
  termination_date date not null,
  target_scope varchar(20) not null check (target_scope in ('contract', 'unit', 'parking')),
  lease_contract_unit_ids uuid[] not null default '{}'::uuid[],
  status varchar(20) not null default 'in_progress' check (status in ('in_progress', 'completed')),
  started_at timestamptz not null default now(),
  started_by uuid references auth.users(id) on delete set null,
  completed_at timestamptz,
  completed_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ix_appsuite_termination_workflow_contract_status
  on public.appsuite_termination_workflow(lease_contract_id, status, termination_date);
alter table public.appsuite_termination_workflow enable row level security;
revoke all on public.appsuite_termination_workflow from public, anon;
grant select on public.appsuite_termination_workflow to authenticated;
drop policy if exists "Active accounts can read AppSuite termination workflows" on public.appsuite_termination_workflow;
create policy "Active accounts can read AppSuite termination workflows"
  on public.appsuite_termination_workflow for select to authenticated
  using (public.current_account_is_active());

create or replace function public.complete_appsuite_termination_request(
  p_change_request_id uuid,
  p_expected_row_version integer,
  p_lease_contract_id uuid,
  p_termination_date date,
  p_target_scope varchar,
  p_lease_contract_unit_ids uuid[] default '{}'::uuid[]
)
returns public.change_request
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.change_request;
  v_record public.appsuite_record;
  v_previous_status varchar(20);
begin
  if not public.current_account_is_active()
     or public.current_account_role() not in ('admin', 'manager', 'staff') then
    raise exception 'Active operator account required';
  end if;
  if p_termination_date is null then raise exception '解約日を入力してください'; end if;
  if p_target_scope not in ('contract', 'unit', 'parking') then raise exception 'Invalid termination scope'; end if;

  select * into v_request
    from public.change_request
   where change_request_id = p_change_request_id
     and request_type = 'contract_terminate'
     and row_version = p_expected_row_version
     and status in ('open', 'in_review', 'on_hold', 'resolved')
   for update;
  if not found then raise exception '最新の解約依頼が見つかりません'; end if;
  v_previous_status := v_request.status;

  select * into v_record
    from public.appsuite_record
   where appsuite_record_id = v_request.source_appsuite_record_id
   for update;
  if not found or not v_record.is_present or v_record.is_cancelled then
    raise exception '有効なAppSuite解約稟議が見つかりません';
  end if;
  if exists (select 1 from public.appsuite_termination_workflow where appsuite_record_id = v_record.appsuite_record_id and status = 'in_progress') then
    raise exception 'この解約稟議は既に契約業務フローで処理中です';
  end if;

  perform 1 from public.lease_contract where lease_contract_id = p_lease_contract_id for update;
  if not found then raise exception '対象契約が見つかりません'; end if;

  if p_target_scope = 'contract' then
    if coalesce(array_length(p_lease_contract_unit_ids, 1), 0) <> 0 then
      raise exception '契約全体の解約では区画を個別選択できません';
    end if;
    if exists (select 1 from public.lease_contract where lease_contract_id = p_lease_contract_id
      and contract_start_date is not null and contract_start_date > p_termination_date) then
      raise exception '解約日は契約開始日以降にしてください';
    end if;
    perform public.confirm_workflow_contract_link(
      v_record.appsuite_record_id, p_lease_contract_id, 'primary', p_termination_date, null, 'contract'
    );
  else
    if coalesce(array_length(p_lease_contract_unit_ids, 1), 0) = 0 then
      raise exception '解約する区画を選択してください';
    end if;
    if exists (
      select 1
        from unnest(p_lease_contract_unit_ids) selected(unit_id)
        left join public.lease_contract_unit contract_unit
          on contract_unit.lease_contract_unit_id = selected.unit_id
         and contract_unit.lease_contract_id = p_lease_contract_id
        left join public.lease_contract contract on contract.lease_contract_id = p_lease_contract_id
        left join public.unit_master unit on unit.unit_id = contract_unit.unit_id
       where contract_unit.lease_contract_unit_id is null
          or p_termination_date < coalesce(contract_unit.lease_start_date, contract.contract_start_date, p_termination_date)
          or (p_target_scope = 'parking' and unit.unit_type is distinct from 'parking')
    ) then raise exception '選択した区画、種別または解約日を確認してください'; end if;
    perform public.confirm_workflow_contract_links(
      v_record.appsuite_record_id, p_lease_contract_id, p_lease_contract_unit_ids,
      'primary', p_termination_date, p_target_scope
    );
  end if;

  insert into public.appsuite_termination_workflow (
    appsuite_record_id, change_request_id, lease_contract_id, termination_date,
    target_scope, lease_contract_unit_ids, started_by
  ) values (
    v_record.appsuite_record_id, v_request.change_request_id, p_lease_contract_id,
    p_termination_date, p_target_scope, coalesce(p_lease_contract_unit_ids, '{}'::uuid[]), auth.uid()
  );

  update public.change_request_item
     set validation_status = 'valid', validation_message = null
   where change_request_id = p_change_request_id and entity_type = 'other';

  update public.change_request
     set status = 'applied', applied_at = now(), applied_by = auth.uid(),
         resolved_at = coalesce(resolved_at, now()), resolved_by = coalesce(resolved_by, auth.uid()),
         lease_contract_id = p_lease_contract_id,
         proposed_payload = coalesce(proposed_payload, '{}'::jsonb) || jsonb_build_object(
           'termination', jsonb_build_object(
             'lease_contract_id', p_lease_contract_id, 'termination_date', p_termination_date,
             'target_scope', p_target_scope,
             'lease_contract_unit_ids', to_jsonb(coalesce(p_lease_contract_unit_ids, '{}'::uuid[])),
             'workflow_status', 'in_progress'
           )
         )
   where change_request_id = p_change_request_id returning * into v_request;

  update public.appsuite_record
     set workflow_completed_at = coalesce(workflow_completed_at, now()),
         workflow_completed_by = coalesce(workflow_completed_by, auth.uid()),
         workflow_processed_at = coalesce(workflow_processed_at, now()),
         workflow_processed_reason = 'termination_handoff'
   where appsuite_record_id = v_record.appsuite_record_id;

  insert into public.change_request_action_log
    (change_request_id, action_type, previous_status, next_status, details, performed_by)
  values (
    p_change_request_id, 'applied', v_previous_status, 'applied',
    jsonb_build_object('handoff', 'contract_workflow', 'lease_contract_id', p_lease_contract_id,
      'termination_date', p_termination_date, 'target_scope', p_target_scope,
      'lease_contract_unit_ids', to_jsonb(coalesce(p_lease_contract_unit_ids, '{}'::uuid[]))), auth.uid()
  );
  return v_request;
end;
$$;

revoke all on function public.complete_appsuite_termination_request(uuid, integer, uuid, date, varchar, uuid[]) from public, anon;
grant execute on function public.complete_appsuite_termination_request(uuid, integer, uuid, date, varchar, uuid[]) to authenticated;
