-- Backfill current review work into the change-request workbench.
-- The NOT EXISTS predicates make this safe to run once alongside future syncs.

create or replace function public.create_change_request_from_appsuite_record(
  p_app_id varchar,
  p_data_id varchar
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_record public.appsuite_record;
  v_request_id uuid;
begin
  if not public.current_account_is_active() then
    raise exception 'Active account required';
  end if;

  select * into v_record
    from public.appsuite_record
   where app_id = p_app_id and data_id = p_data_id and is_present
   for update;
  if not found then
    raise exception 'AppSuite record not found';
  end if;

  if lower(coalesce(v_record.approval_status, '')) not in (
    'approved', 'completed', '完了', '決裁済み', '社長決裁済'
  ) then
    return null;
  end if;

  select change_request_id into v_request_id
    from public.change_request
   where source_type = 'desknets'
     and source_record_key = concat(v_record.app_id, ':', v_record.data_id)
     and request_type = 'contract_create'
     and status not in ('applied', 'excluded');
  if found then
    return v_request_id;
  end if;

  begin
    insert into public.change_request (
      source_type, source_record_key, request_type, status, title, summary, source_payload, proposed_payload
    ) values (
      'desknets', concat(v_record.app_id, ':', v_record.data_id), 'contract_create', 'open',
      concat('DeskNet''s新規契約: ', coalesce(v_record.property_name, '物件未設定'), ' / ', coalesce(v_record.tenant_name, '契約者未設定')),
      'DeskNet''sで完了した契約です。区画を確認してからレントロールへ適用してください。',
      v_record.raw_payload, v_record.raw_payload
    ) returning change_request_id into v_request_id;
  exception when unique_violation then
    select change_request_id into v_request_id
      from public.change_request
     where source_type = 'desknets'
       and source_record_key = concat(v_record.app_id, ':', v_record.data_id)
       and request_type = 'contract_create'
       and status not in ('applied', 'excluded');
    return v_request_id;
  end;

  insert into public.change_request_item (
    change_request_id, entity_type, validation_status, validation_message
  ) values (
    v_request_id, 'other', 'pending', '対象の契約区画・項目・値を選んでください。'
  );
  return v_request_id;
end;
$$;

-- Existing import issues predate the workbench. Create one open request per issue.
with inserted_requests as (
  insert into public.change_request (
    source_type, source_record_key, request_type, status, title, summary, source_payload, proposed_payload
  )
  select
    'initial_import', issue.rent_roll_import_issue_id::text, 'rent_roll_correction', 'open',
    format('取込エラー: %s', issue.issue_type), issue.message,
    issue.source_payload, '{}'::jsonb
  from public.rent_roll_import_issue as issue
  where issue.resolved_at is null
    and not exists (
      select 1
      from public.change_request as request
      where request.source_type = 'initial_import'
        and request.source_record_key = issue.rent_roll_import_issue_id::text
        and request.request_type = 'rent_roll_correction'
        and request.status not in ('applied', 'excluded')
    )
  returning change_request_id, source_record_key
)
insert into public.change_request_item (
  change_request_id, rent_roll_import_issue_id, entity_type, validation_status, validation_message
)
select
  request.change_request_id, issue.rent_roll_import_issue_id,
  'rent_roll_import_issue', 'pending', issue.message
from inserted_requests as request
join public.rent_roll_import_issue as issue
  on issue.rent_roll_import_issue_id::text = request.source_record_key;

-- Backfill DeskNet's records that are already complete. Future records are created by the sync RPC.
with inserted_requests as (
  insert into public.change_request (
    source_type, source_record_key, request_type, status, title, summary, source_payload, proposed_payload
  )
  select
    'desknets', concat(record.app_id, ':', record.data_id), 'contract_create', 'open',
    concat('DeskNet''s新規契約: ', coalesce(record.property_name, '物件未設定'), ' / ', coalesce(record.tenant_name, '契約者未設定')),
    'DeskNet''sで完了した契約です。区画を確認してからレントロールへ適用してください。',
    record.raw_payload, record.raw_payload
  from public.appsuite_record as record
  where record.is_present
    and lower(coalesce(record.approval_status, '')) in ('approved', 'completed', '完了', '決裁済み', '社長決裁済')
    and not exists (
      select 1
      from public.change_request as request
      where request.source_type = 'desknets'
        and request.source_record_key = concat(record.app_id, ':', record.data_id)
        and request.request_type = 'contract_create'
        and request.status not in ('applied', 'excluded')
    )
  returning change_request_id
)
insert into public.change_request_item (
  change_request_id, entity_type, validation_status, validation_message
)
select
  request.change_request_id, 'other', 'pending', '対象の契約区画・項目・値を選んでください。'
from inserted_requests as request;

revoke all on function public.create_change_request_from_appsuite_record(varchar, varchar) from public;
grant execute on function public.create_change_request_from_appsuite_record(varchar, varchar) to authenticated;
