-- 普通賃貸借は初回登録時の renewal_due_date を起点に、期限到来後は自動で1年更新する。

alter table public.change_request
  drop constraint if exists ck_change_request_resolved,
  drop constraint if exists ck_change_request_applied;

alter table public.change_request
  add constraint ck_change_request_resolved check (
    (status not in ('resolved', 'applied') or resolved_at is not null)
    and (status in ('resolved', 'applied') or resolved_at is null)
  ),
  add constraint ck_change_request_applied check (
    (status <> 'applied' or applied_at is not null)
    and (status = 'applied' or applied_at is null)
  );

create or replace function private.auto_renew_ordinary_contracts(p_as_of_date date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target record;
  next_due date;
  renewed_count integer := 0;
  skipped_count integer := 0;
  request_count integer := 0;
  request_target record;
  updated_contract_id uuid;
begin
  if p_as_of_date is null then
    raise exception '基準日は必須です';
  end if;

  for target in
    select contract.lease_contract_id,
           contract.renewal_due_date,
           contract.row_version
    from public.lease_contract contract
    where contract.lease_term_type = 'ordinary'
      and contract.renewal_due_date is not null
      and contract.renewal_due_date <= p_as_of_date
      and contract.actual_end_date is null
      and not exists (
        select 1
        from public.change_request termination_request
        where termination_request.lease_contract_id = contract.lease_contract_id
          and termination_request.request_type in ('contract_terminate', 'contract_cancellation_review')
          and termination_request.status in ('open', 'in_review', 'on_hold', 'resolved')
      )
    order by contract.renewal_due_date, contract.lease_contract_id
    for update of contract
  loop
    next_due := (target.renewal_due_date + interval '1 year')::date;

    for request_target in
      select request.change_request_id, request.status
      from public.change_request request
      where request.lease_contract_id = target.lease_contract_id
        and request.request_type = 'contract_renewal_due'
        and request.status in ('open', 'in_review', 'on_hold', 'resolved')
        and nullif(request.source_payload ->> 'target_date', '')::date = target.renewal_due_date
      for update
    loop
      update public.change_request request
      set status = 'applied',
          resolution_payload = request.resolution_payload || jsonb_build_object(
            'action', 'auto_renew_ordinary_contract',
            'previous_date', target.renewal_due_date,
            'next_date', next_due,
            'processed_at', now()
          ),
          resolved_at = coalesce(request.resolved_at, now()),
          applied_at = now()
      where request.change_request_id = request_target.change_request_id;

      update public.change_request_item item
      set validation_status = 'valid', validation_message = null
      where item.change_request_id = request_target.change_request_id;

      insert into public.change_request_action_log(
        change_request_id, action_type, previous_status, next_status, details, performed_by
      ) values (
        request_target.change_request_id, 'applied', request_target.status, 'applied',
        jsonb_build_object(
          'action', 'auto_renew_ordinary_contract',
          'previous_date', target.renewal_due_date,
          'next_date', next_due,
          'processed_at', now()
        ), null
      );
      request_count := request_count + 1;
    end loop;

    update public.lease_contract contract
    set renewal_due_date = next_due
    where contract.lease_contract_id = target.lease_contract_id
      and contract.row_version = target.row_version
      and contract.lease_term_type = 'ordinary'
      and contract.actual_end_date is null
    returning contract.lease_contract_id into updated_contract_id;

    if not found then
      skipped_count := skipped_count + 1;
      continue;
    end if;

    renewed_count := renewed_count + 1;
  end loop;

  return jsonb_build_object(
    'as_of_date', p_as_of_date,
    'renewed_count', renewed_count,
    'request_count', request_count,
    'skipped_count', skipped_count
  );
end;
$$;

revoke all on function private.auto_renew_ordinary_contracts(date) from public, anon, authenticated;

create or replace function private.sync_contract_deadlines_monthly()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.sync_contract_deadline_change_requests_internal(current_date, null);
  perform private.auto_renew_ordinary_contracts(current_date);
end;
$$;

revoke all on function private.sync_contract_deadlines_monthly() from public, anon, authenticated;

do $$
declare existing_job_id bigint;
begin
  select jobid into existing_job_id
  from cron.job
  where jobname = 'contract-deadline-daily-sync';

  if existing_job_id is null then
    perform cron.schedule(
      'contract-deadline-monthly-sync', '15 17 1 * *',
      'select private.sync_contract_deadlines_monthly();'
    );
  else
    perform cron.alter_job(
      job_id := existing_job_id,
      schedule := '15 17 1 * *',
      command := 'select private.sync_contract_deadlines_monthly();',
      active := true
    );
  end if;
end;
$$;

comment on function private.auto_renew_ordinary_contracts(date)
  is '初回登録時の次回更新予定日を起点に、終了予定でない普通賃貸借を1年間自動更新し、関連する更新確認依頼をappliedにする。';
