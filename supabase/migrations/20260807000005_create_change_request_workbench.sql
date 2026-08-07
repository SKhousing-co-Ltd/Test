-- Change requests are proposed changes. They never update rent-roll source tables
-- directly: an operator reviews the draft and the later domain-specific apply step
-- is responsible for making the actual contract/rent-roll change.

create table if not exists public.change_request (
  change_request_id uuid primary key default gen_random_uuid(),
  source_type varchar(30) not null,
  source_record_key varchar(200),
  request_type varchar(50) not null,
  status varchar(20) not null default 'open',
  title text not null,
  summary text,
  source_payload jsonb not null default '{}'::jsonb,
  proposed_payload jsonb not null default '{}'::jsonb,
  resolution_payload jsonb not null default '{}'::jsonb,
  row_version integer not null default 1,
  assigned_to uuid references auth.users(id) on delete set null,
  resolved_at timestamptz,
  resolved_by uuid references auth.users(id) on delete set null,
  applied_at timestamptz,
  applied_by uuid references auth.users(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  updated_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_change_request_source_type check (source_type in ('initial_import', 'desknets', 'manual')),
  constraint ck_change_request_request_type check (request_type in ('contract_create', 'contract_update', 'contract_terminate', 'rent_roll_correction', 'master_data_correction', 'other')),
  constraint ck_change_request_status check (status in ('draft', 'open', 'in_review', 'on_hold', 'resolved', 'applied', 'excluded')),
  constraint ck_change_request_row_version check (row_version > 0),
  constraint ck_change_request_payloads check (
    jsonb_typeof(source_payload) = 'object'
    and jsonb_typeof(proposed_payload) = 'object'
    and jsonb_typeof(resolution_payload) = 'object'
  ),
  constraint ck_change_request_resolved check (
    (status not in ('resolved', 'applied') or (resolved_at is not null and resolved_by is not null))
    and (status in ('resolved', 'applied') or (resolved_at is null and resolved_by is null))
  ),
  constraint ck_change_request_applied check (
    (status <> 'applied' or (applied_at is not null and applied_by is not null))
    and (status = 'applied' or (applied_at is null and applied_by is null))
  )
);

create unique index if not exists uq_change_request_source_record_open
  on public.change_request(source_type, source_record_key, request_type)
  where source_record_key is not null and status not in ('applied', 'excluded');
create index if not exists ix_change_request_dashboard
  on public.change_request(status, assigned_to, created_at desc);

create table if not exists public.change_request_item (
  change_request_item_id uuid primary key default gen_random_uuid(),
  change_request_id uuid not null references public.change_request(change_request_id) on delete cascade,
  rent_roll_import_issue_id uuid references public.rent_roll_import_issue(rent_roll_import_issue_id) on delete set null,
  entity_type varchar(50) not null,
  entity_id uuid,
  field_name varchar(100),
  current_value jsonb,
  proposed_value jsonb,
  validation_status varchar(20) not null default 'pending',
  validation_message text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_change_request_item_entity_type check (entity_type in ('lease_contract', 'lease_contract_unit', 'unit_master', 'tenant_master', 'rent_roll_import_issue', 'other')),
  constraint ck_change_request_item_validation_status check (validation_status in ('pending', 'valid', 'warning', 'error')),
  constraint ck_change_request_item_sort_order check (sort_order >= 0),
  constraint ck_change_request_item_values check (
    (current_value is null or jsonb_typeof(current_value) in ('object', 'array', 'string', 'number', 'boolean', 'null'))
    and (proposed_value is null or jsonb_typeof(proposed_value) in ('object', 'array', 'string', 'number', 'boolean', 'null'))
  )
);
create index if not exists ix_change_request_item_request on public.change_request_item(change_request_id, sort_order);
create index if not exists ix_change_request_item_issue on public.change_request_item(rent_roll_import_issue_id) where rent_roll_import_issue_id is not null;

create table if not exists public.change_request_comment (
  change_request_comment_id uuid primary key default gen_random_uuid(),
  change_request_id uuid not null references public.change_request(change_request_id) on delete cascade,
  body text not null check (length(trim(body)) > 0),
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists ix_change_request_comment_request on public.change_request_comment(change_request_id, created_at);

create table if not exists public.change_request_action_log (
  change_request_action_log_id uuid primary key default gen_random_uuid(),
  change_request_id uuid not null references public.change_request(change_request_id) on delete cascade,
  action_type varchar(30) not null,
  previous_status varchar(20),
  next_status varchar(20),
  details jsonb not null default '{}'::jsonb,
  performed_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  constraint ck_change_request_action_log_type check (action_type in ('created', 'draft_saved', 'status_changed', 'resolved', 'applied', 'excluded', 'commented')),
  constraint ck_change_request_action_log_details check (jsonb_typeof(details) = 'object')
);
create index if not exists ix_change_request_action_log_request on public.change_request_action_log(change_request_id, created_at desc);

create or replace function public.set_change_request_updated_fields()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at = now();
  new.updated_by = auth.uid();
  if new.row_version = old.row_version then
    new.row_version = old.row_version + 1;
  end if;
  return new;
end;
$$;

create or replace function public.log_change_request_creation()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.change_request_action_log (
    change_request_id, action_type, next_status, details, performed_by
  ) values (
    new.change_request_id, 'created', new.status,
    jsonb_build_object('source_type', new.source_type, 'request_type', new.request_type), auth.uid()
  );
  return new;
end;
$$;

create or replace function public.log_change_request_comment()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.change_request_action_log (
    change_request_id, action_type, details, performed_by
  ) values (
    new.change_request_id, 'commented',
    jsonb_build_object('change_request_comment_id', new.change_request_comment_id), auth.uid()
  );
  return new;
end;
$$;

drop trigger if exists set_change_request_updated_fields on public.change_request;
create trigger set_change_request_updated_fields before update on public.change_request
for each row execute procedure public.set_change_request_updated_fields();
drop trigger if exists set_change_request_item_updated_at on public.change_request_item;
create trigger set_change_request_item_updated_at before update on public.change_request_item
for each row execute procedure public.set_updated_at();
drop trigger if exists log_change_request_creation on public.change_request;
create trigger log_change_request_creation after insert on public.change_request
for each row execute procedure public.log_change_request_creation();
drop trigger if exists log_change_request_comment on public.change_request_comment;
create trigger log_change_request_comment after insert on public.change_request_comment
for each row execute procedure public.log_change_request_comment();

create or replace function public.save_change_request_draft(
  p_change_request_id uuid,
  p_proposed_payload jsonb,
  p_expected_row_version integer,
  p_summary text default null
) returns public.change_request
language plpgsql security definer set search_path = public as $$
declare
  v_request public.change_request;
  v_previous_status varchar(20);
begin
  if not public.current_account_is_active() then
    raise exception 'Active account required';
  end if;
  if jsonb_typeof(p_proposed_payload) <> 'object' then
    raise exception 'proposed_payload must be a JSON object';
  end if;
  update public.change_request
     set proposed_payload = p_proposed_payload,
         summary = coalesce(p_summary, summary)
   where change_request_id = p_change_request_id
     and row_version = p_expected_row_version
     and status in ('draft', 'open', 'in_review', 'on_hold')
  returning * into v_request;
  if not found then
    raise exception 'Change request is not editable, or was updated by another user';
  end if;
  insert into public.change_request_action_log(change_request_id, action_type, previous_status, next_status, details, performed_by)
  values (v_request.change_request_id, 'draft_saved', v_request.status, v_request.status, jsonb_build_object('row_version', v_request.row_version), auth.uid());
  return v_request;
end;
$$;

create or replace function public.resolve_change_request(
  p_change_request_id uuid,
  p_expected_row_version integer,
  p_resolution_payload jsonb default '{}'::jsonb
) returns public.change_request
language plpgsql security definer set search_path = public as $$
declare
  v_request public.change_request;
  v_previous_status varchar(20);
begin
  if not public.current_account_is_active() then
    raise exception 'Active account required';
  end if;
  if jsonb_typeof(p_resolution_payload) <> 'object' then
    raise exception 'resolution_payload must be a JSON object';
  end if;
  select status into v_previous_status from public.change_request
   where change_request_id = p_change_request_id and row_version = p_expected_row_version;
  update public.change_request
     set status = 'resolved', resolution_payload = p_resolution_payload,
         resolved_at = now(), resolved_by = auth.uid()
   where change_request_id = p_change_request_id
     and row_version = p_expected_row_version
     and status in ('open', 'in_review', 'on_hold')
  returning * into v_request;
  if not found then
    raise exception 'Only an open, in-review, or on-hold change request with the expected version can be resolved';
  end if;
  insert into public.change_request_action_log(change_request_id, action_type, previous_status, next_status, details, performed_by)
  values (v_request.change_request_id, 'resolved', v_previous_status, 'resolved', p_resolution_payload, auth.uid());
  return v_request;
end;
$$;

create or replace function public.apply_change_request(
  p_change_request_id uuid,
  p_expected_row_version integer
) returns public.change_request
language plpgsql security definer set search_path = public as $$
declare
  v_request public.change_request;
  v_item public.change_request_item;
  v_item_count integer := 0;
  v_domain_item_count integer := 0;
  v_previous_status varchar(20);
begin
  if not public.current_account_is_active() then
    raise exception 'Active account required';
  end if;
  for v_item in
    select * from public.change_request_item
     where change_request_id = p_change_request_id
     order by sort_order, created_at
  loop
    v_item_count := v_item_count + 1;
    if v_item.validation_status <> 'valid' then
      raise exception 'Every change request item must be valid before applying';
    end if;
    if v_item.entity_type = 'rent_roll_import_issue' then
      continue;
    end if;
    if v_item.entity_type <> 'lease_contract_unit'
       or v_item.entity_id is null
       or v_item.field_name not in (
         'leased_area_sqm', 'monthly_rent_amount', 'monthly_common_charge_amount',
         'deposit_amount', 'security_deposit_amount', 'key_money_amount',
         'renewal_fee_amount', 'lease_start_date', 'lease_end_date'
       )
       or jsonb_typeof(v_item.proposed_value) not in ('number', 'string', 'null') then
      raise exception 'Unsupported change request item %', v_item.change_request_item_id;
    end if;
    perform 1 from public.lease_contract_unit
      where lease_contract_unit_id = v_item.entity_id for update;
    if not found then
      raise exception 'Lease contract unit % was not found', v_item.entity_id;
    end if;
    v_domain_item_count := v_domain_item_count + 1;
    if v_item.field_name = 'leased_area_sqm' then
      update public.lease_contract_unit set leased_area_sqm = (v_item.proposed_value #>> '{}')::numeric where lease_contract_unit_id = v_item.entity_id;
    elsif v_item.field_name = 'monthly_rent_amount' then
      update public.lease_contract_unit set monthly_rent_amount = (v_item.proposed_value #>> '{}')::numeric where lease_contract_unit_id = v_item.entity_id;
    elsif v_item.field_name = 'monthly_common_charge_amount' then
      update public.lease_contract_unit set monthly_common_charge_amount = (v_item.proposed_value #>> '{}')::numeric where lease_contract_unit_id = v_item.entity_id;
    elsif v_item.field_name = 'deposit_amount' then
      update public.lease_contract_unit set deposit_amount = (v_item.proposed_value #>> '{}')::numeric where lease_contract_unit_id = v_item.entity_id;
    elsif v_item.field_name = 'security_deposit_amount' then
      update public.lease_contract_unit set security_deposit_amount = (v_item.proposed_value #>> '{}')::numeric where lease_contract_unit_id = v_item.entity_id;
    elsif v_item.field_name = 'key_money_amount' then
      update public.lease_contract_unit set key_money_amount = (v_item.proposed_value #>> '{}')::numeric where lease_contract_unit_id = v_item.entity_id;
    elsif v_item.field_name = 'renewal_fee_amount' then
      update public.lease_contract_unit set renewal_fee_amount = (v_item.proposed_value #>> '{}')::numeric where lease_contract_unit_id = v_item.entity_id;
    elsif v_item.field_name = 'lease_start_date' then
      update public.lease_contract_unit set lease_start_date = (v_item.proposed_value #>> '{}')::date where lease_contract_unit_id = v_item.entity_id;
    elsif v_item.field_name = 'lease_end_date' then
      update public.lease_contract_unit set lease_end_date = (v_item.proposed_value #>> '{}')::date where lease_contract_unit_id = v_item.entity_id;
    end if;
  end loop;
  if v_item_count = 0 then
    raise exception 'A change request requires at least one item before applying';
  end if;
  if v_domain_item_count = 0 then
    raise exception 'A change request requires at least one supported rent-roll field change before applying';
  end if;
  select status into v_previous_status from public.change_request
   where change_request_id = p_change_request_id and row_version = p_expected_row_version;
  update public.change_request
     set status = 'applied', applied_at = now(), applied_by = auth.uid()
   where change_request_id = p_change_request_id
     and row_version = p_expected_row_version
     and status = 'resolved'
  returning * into v_request;
  if not found then
    raise exception 'Only a resolved change request with the expected version can be applied';
  end if;
  update public.rent_roll_import_issue as issue
     set resolved_at = now(), resolved_by = auth.uid()
   where issue.rent_roll_import_issue_id in (
     select item.rent_roll_import_issue_id
       from public.change_request_item as item
      where item.change_request_id = v_request.change_request_id
        and item.rent_roll_import_issue_id is not null
   ) and issue.resolved_at is null;
  insert into public.change_request_action_log(change_request_id, action_type, previous_status, next_status, details, performed_by)
  values (v_request.change_request_id, 'applied', v_previous_status, 'applied', '{}'::jsonb, auth.uid());
  return v_request;
end;
$$;

create or replace function public.set_change_request_status(
  p_change_request_id uuid,
  p_expected_row_version integer,
  p_next_status varchar,
  p_note text default null
) returns public.change_request
language plpgsql security definer set search_path = public as $$
declare v_request public.change_request; v_previous_status varchar(20);
begin
  if not public.current_account_is_active() then raise exception 'Active account required'; end if;
  if p_next_status not in ('in_review', 'on_hold', 'excluded') then
    raise exception 'Unsupported change request status';
  end if;
  select status into v_previous_status from public.change_request
   where change_request_id = p_change_request_id and row_version = p_expected_row_version;
  update public.change_request set status = p_next_status
   where change_request_id = p_change_request_id and row_version = p_expected_row_version
     and status in ('draft', 'open', 'in_review', 'on_hold')
  returning * into v_request;
  if not found then raise exception 'Change request is not editable, or was updated by another user'; end if;
  insert into public.change_request_action_log(change_request_id, action_type, previous_status, next_status, details, performed_by)
  values (v_request.change_request_id, case when p_next_status = 'excluded' then 'excluded' else 'status_changed' end,
          v_previous_status, p_next_status, jsonb_build_object('note', p_note), auth.uid());
  return v_request;
end;
$$;

create or replace function public.add_change_request_comment(
  p_change_request_id uuid,
  p_body text
) returns public.change_request_comment
language plpgsql security definer set search_path = public as $$
declare v_comment public.change_request_comment;
begin
  if not public.current_account_is_active() then raise exception 'Active account required'; end if;
  if not exists (select 1 from public.change_request where change_request_id = p_change_request_id) then
    raise exception 'Change request not found';
  end if;
  insert into public.change_request_comment(change_request_id, body, created_by)
  values (p_change_request_id, p_body, auth.uid()) returning * into v_comment;
  return v_comment;
end;
$$;

create or replace function public.create_change_request_from_import_issue(
  p_rent_roll_import_issue_id uuid
) returns public.change_request
language plpgsql security definer set search_path = public as $$
declare
  v_issue public.rent_roll_import_issue;
  v_request public.change_request;
begin
  if not public.current_account_is_active() then raise exception 'Active account required'; end if;
  select * into v_issue from public.rent_roll_import_issue
   where rent_roll_import_issue_id = p_rent_roll_import_issue_id and resolved_at is null
   for update;
  if not found then raise exception 'Open rent-roll import issue not found'; end if;
  select * into v_request from public.change_request
   where source_type = 'initial_import'
     and source_record_key = v_issue.rent_roll_import_issue_id::text
     and request_type = 'rent_roll_correction'
     and status not in ('applied', 'excluded');
  if found then return v_request; end if;
  insert into public.change_request (
    source_type, source_record_key, request_type, status, title, summary, source_payload, proposed_payload
  ) values (
    'initial_import', v_issue.rent_roll_import_issue_id::text, 'rent_roll_correction', 'open',
    format('Import issue: %s', v_issue.issue_type), v_issue.message,
    v_issue.source_payload, '{}'::jsonb
  ) returning * into v_request;
  insert into public.change_request_item (
    change_request_id, rent_roll_import_issue_id, entity_type, validation_status, validation_message
  ) values (
    v_request.change_request_id, v_issue.rent_roll_import_issue_id, 'rent_roll_import_issue', 'pending', v_issue.message
  );
  return v_request;
end;
$$;

create or replace function public.create_change_request_from_appsuite_record(
  p_app_id varchar,
  p_data_id varchar
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_record public.appsuite_record;
  v_request_id uuid;
begin
  if not public.current_account_is_active() then raise exception 'Active account required'; end if;
  select * into v_record from public.appsuite_record
   where app_id = p_app_id and data_id = p_data_id and is_present
   for update;
  if not found then raise exception 'AppSuite record not found'; end if;
  if lower(coalesce(v_record.approval_status, '')) not in ('approved', 'completed', '承認済み', '完了', '社長決裁済') then
    return null;
  end if;
  select change_request_id into v_request_id from public.change_request
   where source_type = 'desknets'
     and source_record_key = concat(v_record.app_id, ':', v_record.data_id)
     and request_type = 'contract_create'
     and status not in ('applied', 'excluded');
  if found then return v_request_id; end if;
  begin
    insert into public.change_request (
      source_type, source_record_key, request_type, status, title, summary, source_payload, proposed_payload
    ) values (
      'desknets', concat(v_record.app_id, ':', v_record.data_id), 'contract_create', 'open',
      concat('DeskNet''s承認契約: ', coalesce(v_record.property_name, '物件未設定'), ' / ', coalesce(v_record.tenant_name, '契約者未設定')),
      'DeskNet''sで承認された契約です。差分を確認してからレントロールへ適用してください。',
      v_record.raw_payload, v_record.raw_payload
    ) returning change_request_id into v_request_id;
  exception when unique_violation then
    select change_request_id into v_request_id from public.change_request
     where source_type = 'desknets'
       and source_record_key = concat(v_record.app_id, ':', v_record.data_id)
       and request_type = 'contract_create'
       and status not in ('applied', 'excluded');
    return v_request_id;
  end;
  insert into public.change_request_item (
    change_request_id, entity_type, validation_status, validation_message
  ) values (
    v_request_id, 'other', 'pending', '対象の契約区画・修正項目・値を選んでください。'
  );
  return v_request_id;
end;
$$;

create or replace function public.update_change_request_item(
  p_change_request_item_id uuid,
  p_expected_request_row_version integer,
  p_entity_type varchar,
  p_entity_id uuid,
  p_field_name varchar,
  p_proposed_value jsonb,
  p_validation_status varchar,
  p_validation_message text default null
) returns public.change_request_item
language plpgsql security definer set search_path = public as $$
declare v_item public.change_request_item;
begin
  if not public.current_account_is_active() then raise exception 'Active account required'; end if;
  if p_entity_type not in ('lease_contract_unit', 'rent_roll_import_issue')
     or p_validation_status not in ('pending', 'valid', 'warning', 'error')
     or (p_proposed_value is not null and jsonb_typeof(p_proposed_value) not in ('number', 'string', 'null')) then
    raise exception 'Invalid change request item input';
  end if;
  update public.change_request set summary = summary
   where change_request_id = (select change_request_id from public.change_request_item where change_request_item_id = p_change_request_item_id)
     and row_version = p_expected_request_row_version
     and status in ('draft', 'open', 'in_review', 'on_hold');
  if not found then raise exception 'Change request is not editable, or was updated by another user'; end if;
  update public.change_request_item
     set entity_type = p_entity_type, entity_id = p_entity_id, field_name = p_field_name,
         proposed_value = p_proposed_value, validation_status = p_validation_status,
         validation_message = p_validation_message
   where change_request_item_id = p_change_request_item_id
  returning * into v_item;
  if not found then raise exception 'Change request item not found'; end if;
  insert into public.change_request_action_log(change_request_id, action_type, details, performed_by)
  values (v_item.change_request_id, 'draft_saved', jsonb_build_object('change_request_item_id', v_item.change_request_item_id), auth.uid());
  return v_item;
end;
$$;

alter table public.change_request enable row level security;
alter table public.change_request_item enable row level security;
alter table public.change_request_comment enable row level security;
alter table public.change_request_action_log enable row level security;

-- Import issues can only be marked resolved through resolve_change_request.
revoke insert, update, delete on public.rent_roll_import_issue from authenticated;
drop policy if exists "authenticated employees can manage rent roll import issues" on public.rent_roll_import_issue;
create policy "active users read rent roll import issues" on public.rent_roll_import_issue for select to authenticated
  using (public.current_account_is_active());

grant select on public.change_request, public.change_request_item, public.change_request_comment, public.change_request_action_log to authenticated;
grant execute on function public.save_change_request_draft(uuid, jsonb, integer, text) to authenticated;
grant execute on function public.resolve_change_request(uuid, integer, jsonb) to authenticated;
grant execute on function public.apply_change_request(uuid, integer) to authenticated;
grant execute on function public.set_change_request_status(uuid, integer, varchar, text) to authenticated;
grant execute on function public.add_change_request_comment(uuid, text) to authenticated;
grant execute on function public.create_change_request_from_import_issue(uuid) to authenticated;
grant execute on function public.create_change_request_from_appsuite_record(varchar, varchar) to authenticated;
grant execute on function public.update_change_request_item(uuid, integer, varchar, uuid, varchar, jsonb, varchar, text) to authenticated;
revoke all on function public.save_change_request_draft(uuid, jsonb, integer, text) from public;
revoke all on function public.resolve_change_request(uuid, integer, jsonb) from public;
revoke all on function public.apply_change_request(uuid, integer) from public;
revoke all on function public.set_change_request_status(uuid, integer, varchar, text) from public;
revoke all on function public.add_change_request_comment(uuid, text) from public;
revoke all on function public.create_change_request_from_import_issue(uuid) from public;
revoke all on function public.create_change_request_from_appsuite_record(varchar, varchar) from public;
revoke all on function public.update_change_request_item(uuid, integer, varchar, uuid, varchar, jsonb, varchar, text) from public;

create policy "active users read change requests" on public.change_request for select to authenticated
  using (public.current_account_is_active());
create policy "active users read change request items" on public.change_request_item for select to authenticated
  using (public.current_account_is_active());
create policy "active users read change request comments" on public.change_request_comment for select to authenticated
  using (public.current_account_is_active());
create policy "active users read change request action logs" on public.change_request_action_log for select to authenticated
  using (public.current_account_is_active());

comment on table public.change_request is 'Initial import and DeskNets changes are reviewed here before any rent-roll update.';
comment on table public.change_request_item is 'One proposed field/entity change, optionally linked to an unresolved import issue.';
comment on table public.change_request_action_log is 'Append-only audit trail for operator actions and state transitions.';
