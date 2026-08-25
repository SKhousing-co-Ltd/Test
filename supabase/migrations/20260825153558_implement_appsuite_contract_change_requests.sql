-- AppSuite lease approvals are staged as reviewed change requests before any
-- contract or rent-roll source data is changed.

alter table public.appsuite_application
  add column if not exists contract_workflow_type varchar(40),
  add column if not exists contract_workflow_start_at timestamptz;

alter table public.appsuite_application drop constraint if exists ck_appsuite_application_contract_workflow_type;
alter table public.appsuite_application add constraint ck_appsuite_application_contract_workflow_type
  check (contract_workflow_type is null or contract_workflow_type in ('contract_create', 'contract_update', 'approval_cancel'));

insert into public.appsuite_application (app_id, app_name, app_status, is_sync_enabled, contract_workflow_type, contract_workflow_start_at)
values
  ('23', '【営業】＜SGN＞オフィス看板新規契約稟議', 'running', true, 'contract_create', now()),
  ('63', '【営業】＜NOC＞オフィス駐車場新規契約稟議', 'running', true, 'contract_create', now()),
  ('65', '【営業】＜NSR＞オフィス貸室（単区画）新規契約稟議', 'running', true, 'contract_create', now()),
  ('66', '【営業】＜NRR＞レジデンス 貸室新規契約稟議', 'running', true, 'contract_create', now()),
  ('67', '【営業】＜NRC＞レジデンス駐車場契約稟議', 'running', true, 'contract_create', now()),
  ('72', '【営業】＜NOB＞オフィス駐輪場新規契約稟議', 'running', true, 'contract_create', now()),
  ('78', '【営業】＜NMR＞オフィス貸室（複数区画）新規契約稟議', 'running', true, 'contract_create', now()),
  ('24', '【営業】＜ORU＞貸室 賃料値上稟議', 'running', true, 'contract_update', now()),
  ('69', '【営業】＜KYO＞オフィス貸室 共同利用稟議', 'running', true, 'contract_update', now()),
  ('77', '【営業】＜RCC＞賃貸契約変更申請', 'running', true, 'contract_update', now()),
  ('79', '【営業】＜ZOR＞オフィス貸室増床稟議', 'running', true, 'contract_update', now()),
  ('83', '【営業】＜TEN＞オフィス貸室 転貸契約稟議', 'running', true, 'contract_update', now()),
  ('84', '【営業】＜ZOC＞オフィス駐車場 増車契約稟議', 'running', true, 'contract_update', now()),
  ('85', '【営業】＜KEI＞オフィス貸室 契約承継稟議', 'running', true, 'contract_update', now()),
  ('143', '【営業】＜NOU＞駐車場 賃料値上稟議', 'running', true, 'contract_update', now()),
  ('100', '【ビル事業部】＜CAN＞決裁済稟議取下申請', 'running', true, 'approval_cancel', now())
on conflict (app_id) do update
set contract_workflow_type = excluded.contract_workflow_type,
    contract_workflow_start_at = coalesce(public.appsuite_application.contract_workflow_start_at, excluded.contract_workflow_start_at),
    is_sync_enabled = true;

create or replace function public.normalize_appsuite_ringi_number(value text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select upper(regexp_replace(btrim(coalesce(value, '')), '[[:space:]　]+', '', 'g'));
$$;

alter table public.appsuite_record
  add column if not exists is_cancelled boolean not null default false,
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancelled_by uuid references auth.users(id) on delete set null,
  add column if not exists cancellation_reason text,
  add column if not exists cancelled_by_appsuite_record_id uuid references public.appsuite_record(appsuite_record_id) on delete restrict;

alter table public.appsuite_record drop constraint if exists ck_appsuite_record_cancellation;
alter table public.appsuite_record add constraint ck_appsuite_record_cancellation check (
  (not is_cancelled and cancelled_at is null and cancelled_by is null and cancelled_by_appsuite_record_id is null)
  or (is_cancelled and cancelled_at is not null and cancelled_by is not null and cancelled_by_appsuite_record_id is not null)
);

create index if not exists ix_appsuite_record_normalized_ringi
  on public.appsuite_record (public.normalize_appsuite_ringi_number(ringi_number))
  where ringi_number is not null and is_present;

alter table public.change_request drop constraint if exists ck_change_request_request_type;
alter table public.change_request add constraint ck_change_request_request_type check (
  request_type in (
    'contract_create', 'contract_update', 'contract_terminate', 'approval_cancel',
    'contract_cancellation_review', 'rent_roll_correction', 'master_data_correction', 'other'
  )
);

alter table public.change_request
  add column if not exists source_appsuite_record_id uuid references public.appsuite_record(appsuite_record_id) on delete restrict,
  add column if not exists target_appsuite_record_id uuid references public.appsuite_record(appsuite_record_id) on delete restrict,
  add column if not exists lease_contract_id uuid references public.lease_contract(lease_contract_id) on delete restrict;

create index if not exists ix_change_request_source_appsuite on public.change_request(source_appsuite_record_id);
create index if not exists ix_change_request_target_appsuite on public.change_request(target_appsuite_record_id);
create index if not exists ix_change_request_lease_contract on public.change_request(lease_contract_id);

alter table public.change_request_action_log drop constraint if exists ck_change_request_action_log_type;
alter table public.change_request_action_log add constraint ck_change_request_action_log_type check (
  action_type in (
    'created', 'draft_saved', 'status_changed', 'resolved', 'applied', 'excluded',
    'commented', 'cancellation_confirmed', 'follow_up_created'
  )
);

create or replace function public.appsuite_json_text(payload jsonb, field_name text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select nullif(btrim(coalesce(payload -> field_name ->> 'val', payload ->> field_name)), '');
$$;

create or replace function public.enqueue_contract_change_request_from_appsuite()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_config public.appsuite_application;
  v_request_id uuid;
  v_target_ringi text;
  v_target_id uuid;
  v_target_count integer := 0;
  v_title text;
  v_summary text;
  v_validation_status varchar(20) := 'pending';
  v_validation_message text;
begin
  select * into v_config from public.appsuite_application where app_id = new.app_id;
  if not found or v_config.contract_workflow_type is null or not new.is_present or new.is_cancelled then
    return new;
  end if;
  if lower(coalesce(new.approval_status, '')) not in ('approved', 'completed', '承認済み', '完了', '承認', '決裁済み', '社長決裁済') then
    return new;
  end if;
  if coalesce(new.source_updated_at, new.source_created_at, new.created_at) < v_config.contract_workflow_start_at then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and old.revision is not distinct from new.revision
     and old.raw_payload is not distinct from new.raw_payload
     and old.approval_status is not distinct from new.approval_status
     and old.is_present is not distinct from new.is_present then
    return new;
  end if;

  if v_config.contract_workflow_type = 'approval_cancel' then
    v_target_ringi := public.appsuite_json_text(new.raw_payload, '取下稟議番号');
    select count(*), min(appsuite_record_id::text)::uuid
      into v_target_count, v_target_id
      from public.appsuite_record
     where appsuite_record_id <> new.appsuite_record_id
       and is_present
       and public.normalize_appsuite_ringi_number(ringi_number) = public.normalize_appsuite_ringi_number(v_target_ringi)
       and lower(coalesce(approval_status, '')) in ('approved', 'completed', '承認済み', '完了', '承認', '決裁済み', '社長決裁済');
    if v_target_count <> 1 then v_target_id := null; end if;
    v_title := concat('決裁済み稟議取消: ', coalesce(v_target_ringi, '対象稟議番号未設定'));
    v_summary := case when v_target_count = 1
      then '対象稟議を確認し、取消方法を選択してください。'
      else concat('対象稟議の一致件数は', v_target_count, '件です。対象を確認してください。') end;
    v_validation_status := case when v_target_count = 1 then 'valid' else 'error' end;
    v_validation_message := case when v_target_count = 1 then '対象稟議を一意に照合しました。' else v_summary end;
  elsif v_config.contract_workflow_type = 'contract_create' then
    v_title := concat('AppSuite新規契約: ', coalesce(new.property_name, '物件未設定'), ' / ', coalesce(new.tenant_name, '契約者未設定'));
    v_summary := '決裁済み申請です。契約内容とリーシング区画を確認してください。';
    v_validation_message := 'テナント、契約内容、リーシング区画を登録してください。';
  else
    v_title := concat('AppSuite契約変更: ', coalesce(new.property_name, '物件未設定'), ' / ', coalesce(new.tenant_name, '契約者未設定'));
    v_summary := '決裁済み申請です。申請原文と現在の契約を照合し、変更内容を手入力してください。';
    v_validation_message := '対象契約と反映する変更、または対象項目なしの理由を登録してください。';
  end if;

  select change_request_id into v_request_id from public.change_request
   where source_type = 'desknets' and source_record_key = concat(new.app_id, ':', new.data_id)
     and request_type = v_config.contract_workflow_type
   order by created_at limit 1;
  if found then
    update public.change_request
       set source_payload = new.raw_payload,
           source_appsuite_record_id = new.appsuite_record_id,
           target_appsuite_record_id = coalesce(target_appsuite_record_id, v_target_id),
           summary = case when status in ('applied', 'excluded') then summary else v_summary end
     where change_request_id = v_request_id;
    return new;
  end if;

  insert into public.change_request (
    source_type, source_record_key, request_type, status, title, summary,
    source_payload, proposed_payload, source_appsuite_record_id, target_appsuite_record_id
  ) values (
    'desknets', concat(new.app_id, ':', new.data_id), v_config.contract_workflow_type, 'open', v_title, v_summary,
    new.raw_payload,
    case when v_config.contract_workflow_type = 'approval_cancel'
      then jsonb_build_object('target_ringi_number', v_target_ringi, 'target_match_count', v_target_count)
      else '{}'::jsonb end,
    new.appsuite_record_id, v_target_id
  )
  on conflict (source_type, source_record_key, request_type)
    where source_record_key is not null and status not in ('applied', 'excluded')
  do update set
    source_payload = excluded.source_payload,
    source_appsuite_record_id = excluded.source_appsuite_record_id,
    target_appsuite_record_id = coalesce(public.change_request.target_appsuite_record_id, excluded.target_appsuite_record_id),
    summary = excluded.summary
  returning change_request_id into v_request_id;

  if not exists (select 1 from public.change_request_item where change_request_id = v_request_id) then
    insert into public.change_request_item(change_request_id, entity_type, validation_status, validation_message)
    values (v_request_id, 'other', v_validation_status, v_validation_message);
  end if;
  return new;
end;
$$;

drop trigger if exists enqueue_contract_change_request_from_appsuite on public.appsuite_record;
create trigger enqueue_contract_change_request_from_appsuite
after insert or update of revision, raw_payload, approval_status, is_present on public.appsuite_record
for each row execute function public.enqueue_contract_change_request_from_appsuite();

create or replace function public.save_contract_create_draft(
  p_change_request_id uuid,
  p_expected_row_version integer,
  p_contract jsonb,
  p_units jsonb
) returns public.change_request
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.change_request;
  v_property_id uuid;
  v_unit jsonb;
  v_unit_id uuid;
  v_unit_count integer := 0;
begin
  if not public.current_account_is_active() or public.current_account_role() not in ('admin', 'manager', 'staff') then
    raise exception '契約対応依頼の編集権限がありません';
  end if;
  if jsonb_typeof(p_contract) <> 'object' or jsonb_typeof(p_units) <> 'array' or jsonb_array_length(p_units) = 0 then
    raise exception '契約情報と1件以上の区画が必要です';
  end if;
  if nullif(p_contract ->> 'property_id', '') is null then raise exception '物件を選択してください'; end if;
  v_property_id := (p_contract ->> 'property_id')::uuid;
  if ((p_contract ? 'tenant_id') and nullif(p_contract ->> 'tenant_id', '') is not null)
     = ((p_contract ? 'new_tenant_name') and nullif(btrim(p_contract ->> 'new_tenant_name'), '') is not null) then
    raise exception '既存テナントまたは新規テナント名のどちらか一方を指定してください';
  end if;
  if nullif(p_contract ->> 'tenant_id', '') is not null
     and not exists (select 1 from public.tenant_master where tenant_id = (p_contract ->> 'tenant_id')::uuid) then
    raise exception '選択したテナントが見つかりません';
  end if;
  for v_unit in select value from jsonb_array_elements(p_units)
  loop
    v_unit_id := (v_unit ->> 'unit_id')::uuid;
    if not exists (
      select 1 from public.unit_master
       where unit_id = v_unit_id and property_id = v_property_id and is_active
    ) then raise exception '物件に属する有効な区画を選択してください'; end if;
    if exists (
      select 1 from jsonb_array_elements(p_units) duplicate
       where duplicate.value ->> 'unit_id' = v_unit ->> 'unit_id'
       group by duplicate.value ->> 'unit_id' having count(*) > 1
    ) then raise exception '同じ区画を複数指定できません'; end if;
    v_unit_count := v_unit_count + 1;
  end loop;
  update public.change_request
     set proposed_payload = jsonb_build_object('contract', p_contract, 'units', p_units),
         lease_contract_id = null
   where change_request_id = p_change_request_id
     and request_type = 'contract_create'
     and row_version = p_expected_row_version
     and status in ('draft', 'open', 'in_review', 'on_hold')
  returning * into v_request;
  if not found then raise exception '対応依頼が更新済みか、編集できない状態です'; end if;
  if exists (
    select 1 from public.appsuite_record
     where appsuite_record_id = v_request.source_appsuite_record_id and is_cancelled
  ) then raise exception '取消済み稟議は編集できません'; end if;
  update public.change_request_item set validation_status = 'valid', validation_message = concat(v_unit_count, '区画を確認済み')
   where change_request_id = p_change_request_id;
  insert into public.change_request_action_log(change_request_id, action_type, previous_status, next_status, details, performed_by)
  values (p_change_request_id, 'draft_saved', v_request.status, v_request.status, jsonb_build_object('unit_count', v_unit_count), auth.uid());
  return v_request;
end;
$$;

create or replace function public.save_contract_update_draft(
  p_change_request_id uuid,
  p_expected_row_version integer,
  p_lease_contract_id uuid,
  p_operations jsonb,
  p_no_system_reason text default null
) returns public.change_request
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.change_request;
  v_operation jsonb;
  v_verified jsonb := '[]'::jsonb;
  v_action text;
  v_entity_type text;
  v_entity_id uuid;
  v_field text;
  v_current jsonb;
begin
  if not public.current_account_is_active() or public.current_account_role() not in ('admin', 'manager', 'staff') then
    raise exception '契約対応依頼の編集権限がありません';
  end if;
  if jsonb_typeof(p_operations) <> 'array' then raise exception '変更操作は配列で指定してください'; end if;
  if jsonb_array_length(p_operations) = 0 and nullif(btrim(p_no_system_reason), '') is null then
    raise exception '反映する変更、または本システムに対象項目がない理由を入力してください';
  end if;
  perform 1 from public.lease_contract where lease_contract_id = p_lease_contract_id;
  if not found then raise exception '対象契約が見つかりません'; end if;

  for v_operation in select value from jsonb_array_elements(p_operations)
  loop
    v_action := v_operation ->> 'action';
    v_entity_type := v_operation ->> 'entity_type';
    v_field := v_operation ->> 'field_name';
    v_entity_id := nullif(v_operation ->> 'entity_id', '')::uuid;
    v_current := null;
    if v_action = 'set_field' and v_entity_type = 'lease_contract' then
      if v_field not in ('tenant_id', 'contract_type', 'contract_start_date', 'contract_end_date', 'renewal_terms', 'payment_terms', 'notes') then
        raise exception '変更できない契約項目です: %', v_field;
      end if;
      select to_jsonb(contract) -> v_field into v_current from public.lease_contract contract where lease_contract_id = p_lease_contract_id;
    elsif v_action = 'set_field' and v_entity_type = 'lease_contract_unit' then
      if v_field not in ('leased_area_sqm', 'monthly_rent_amount', 'monthly_common_charge_amount', 'deposit_amount', 'security_deposit_amount', 'key_money_amount', 'renewal_fee_amount', 'lease_start_date', 'lease_end_date') then
        raise exception '変更できない契約区画項目です: %', v_field;
      end if;
      select to_jsonb(contract_unit) -> v_field into v_current
        from public.lease_contract_unit contract_unit
       where lease_contract_unit_id = v_entity_id and lease_contract_id = p_lease_contract_id;
      if not found then raise exception '対象契約に属する契約区画が見つかりません'; end if;
    elsif v_action = 'link_unit' then
      v_entity_id := (v_operation ->> 'unit_id')::uuid;
      if not exists (select 1 from public.unit_master where unit_id = v_entity_id and is_active) then
        raise exception '追加する有効な区画が見つかりません';
      end if;
    elsif v_action = 'unlink_unit' then
      if not exists (
        select 1 from public.lease_contract_unit where lease_contract_unit_id = v_entity_id and lease_contract_id = p_lease_contract_id
      ) then raise exception '解除する契約区画が見つかりません'; end if;
      if nullif(v_operation #>> '{value,effective_date}', '') is null then raise exception '区画解除の効力発生日が必要です'; end if;
    else
      raise exception '対応していない変更操作です';
    end if;
    v_verified := v_verified || jsonb_build_array(v_operation || jsonb_build_object('current_value', v_current));
  end loop;

  update public.change_request
     set proposed_payload = jsonb_build_object(
       'lease_contract_id', p_lease_contract_id,
       'operations', v_verified,
       'no_system_reason', nullif(btrim(p_no_system_reason), '')
     ), lease_contract_id = p_lease_contract_id
   where change_request_id = p_change_request_id
     and request_type in ('contract_update', 'contract_cancellation_review')
     and row_version = p_expected_row_version
     and status in ('draft', 'open', 'in_review', 'on_hold')
  returning * into v_request;
  if not found then raise exception '対応依頼が更新済みか、編集できない状態です'; end if;
  update public.change_request_item set validation_status = 'valid', validation_message = '変更内容を手動確認済み'
   where change_request_id = p_change_request_id;
  insert into public.change_request_action_log(change_request_id, action_type, previous_status, next_status, details, performed_by)
  values (p_change_request_id, 'draft_saved', v_request.status, v_request.status,
    jsonb_build_object('operation_count', jsonb_array_length(p_operations), 'no_system_reason', nullif(btrim(p_no_system_reason), '')), auth.uid());
  return v_request;
end;
$$;

create or replace function public.save_approval_cancellation_draft(
  p_change_request_id uuid,
  p_expected_row_version integer,
  p_target_appsuite_record_id uuid,
  p_mode text,
  p_note text
) returns public.change_request
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.change_request;
  v_target_ringi text;
begin
  if not public.current_account_is_active() or public.current_account_role() not in ('admin', 'manager', 'staff') then
    raise exception '取消対応依頼の編集権限がありません';
  end if;
  if p_mode not in ('source_only', 'create_contract_follow_up') then raise exception '取消方法が不正です'; end if;
  if nullif(btrim(p_note), '') is null then raise exception '確認メモを入力してください'; end if;
  select ringi_number into v_target_ringi from public.appsuite_record
   where appsuite_record_id = p_target_appsuite_record_id and is_present
     and lower(coalesce(approval_status, '')) in ('approved', 'completed', '承認済み', '完了', '承認', '決裁済み', '社長決裁済');
  if not found then raise exception '対象の決裁済み稟議が見つかりません'; end if;
  update public.change_request
     set target_appsuite_record_id = p_target_appsuite_record_id,
         proposed_payload = proposed_payload || jsonb_build_object(
           'target_ringi_number', v_target_ringi, 'target_match_count', 1, 'mode', p_mode, 'note', btrim(p_note)
         )
   where change_request_id = p_change_request_id
     and request_type = 'approval_cancel'
     and row_version = p_expected_row_version
     and status in ('draft', 'open', 'in_review', 'on_hold')
  returning * into v_request;
  if not found then raise exception '対応依頼が更新済みか、編集できない状態です'; end if;
  update public.change_request_item set validation_status = 'valid', validation_message = '取消対象と処理方法を確認済み'
   where change_request_id = p_change_request_id;
  insert into public.change_request_action_log(change_request_id, action_type, previous_status, next_status, details, performed_by)
  values (p_change_request_id, 'draft_saved', v_request.status, v_request.status,
    jsonb_build_object('target_appsuite_record_id', p_target_appsuite_record_id, 'mode', p_mode), auth.uid());
  return v_request;
end;
$$;

create or replace function public.list_approval_cancellation_candidates(p_change_request_id uuid)
returns table (
  appsuite_record_id uuid,
  ringi_number varchar,
  property_name text,
  tenant_name text,
  approval_status varchar,
  is_cancelled boolean,
  lease_contract_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target_ringi text;
  v_source_id uuid;
begin
  if not public.current_account_is_active() then raise exception 'Active account required'; end if;
  select public.appsuite_json_text(source_record.raw_payload, '取下稟議番号'), source_record.appsuite_record_id
    into v_target_ringi, v_source_id
    from public.change_request request
    join public.appsuite_record source_record on source_record.appsuite_record_id = request.source_appsuite_record_id
   where request.change_request_id = p_change_request_id and request.request_type = 'approval_cancel';
  if not found then raise exception '取消対応依頼が見つかりません'; end if;
  return query
  select target.appsuite_record_id, target.ringi_number, target.property_name, target.tenant_name,
    target.approval_status, target.is_cancelled,
    (
      select request.lease_contract_id from public.change_request request
       where request.source_appsuite_record_id = target.appsuite_record_id and request.status = 'applied'
       order by request.applied_at desc nulls last limit 1
    )
  from public.appsuite_record target
  where target.is_present
    and target.appsuite_record_id <> v_source_id
    and public.normalize_appsuite_ringi_number(target.ringi_number) = public.normalize_appsuite_ringi_number(v_target_ringi)
    and lower(coalesce(target.approval_status, '')) in ('approved', 'completed', '承認済み', '完了', '承認', '決裁済み', '社長決裁済')
  order by target.source_updated_at desc nulls last, target.created_at desc;
end;
$$;

create or replace function public.resolve_change_request(
  p_change_request_id uuid,
  p_expected_row_version integer,
  p_resolution_payload jsonb default '{}'::jsonb
) returns public.change_request
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.change_request;
  v_previous_status varchar(20);
begin
  if not public.current_account_is_active() then raise exception 'Active account required'; end if;
  if jsonb_typeof(p_resolution_payload) <> 'object' then raise exception 'resolution_payload must be a JSON object'; end if;
  select * into v_request from public.change_request
   where change_request_id = p_change_request_id and row_version = p_expected_row_version for update;
  if not found or v_request.status not in ('open', 'in_review', 'on_hold') then
    raise exception 'Only an open, in-review, or on-hold request with the expected version can be resolved';
  end if;
  if exists (
    select 1 from public.change_request_item
     where change_request_id = p_change_request_id and validation_status <> 'valid'
       and not (
         v_request.source_type = 'initial_import' and v_request.request_type = 'rent_roll_correction'
         and entity_type = 'rent_roll_import_issue'
       )
  ) then
    raise exception '未確認またはエラーの明細があります';
  end if;
  if v_request.request_type = 'contract_create'
     and (jsonb_typeof(v_request.proposed_payload -> 'contract') <> 'object' or jsonb_array_length(coalesce(v_request.proposed_payload -> 'units', '[]'::jsonb)) = 0) then
    raise exception '契約情報と区画を保存してください';
  end if;
  if v_request.request_type in ('contract_update', 'contract_cancellation_review')
     and jsonb_typeof(v_request.proposed_payload -> 'operations') <> 'array' then
    raise exception '契約変更内容を保存してください';
  end if;
  if v_request.request_type = 'approval_cancel'
     and (v_request.target_appsuite_record_id is null or v_request.proposed_payload ->> 'mode' not in ('source_only', 'create_contract_follow_up')) then
    raise exception '取消対象と処理方法を保存してください';
  end if;
  v_previous_status := v_request.status;
  update public.change_request set status = 'resolved', resolution_payload = p_resolution_payload,
    resolved_at = now(), resolved_by = auth.uid()
   where change_request_id = p_change_request_id returning * into v_request;
  insert into public.change_request_action_log(change_request_id, action_type, previous_status, next_status, details, performed_by)
  values (p_change_request_id, 'resolved', v_previous_status, 'resolved', p_resolution_payload, auth.uid());
  return v_request;
end;
$$;

create or replace function public.apply_change_request(
  p_change_request_id uuid,
  p_expected_row_version integer
) returns public.change_request
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.change_request;
  v_contract jsonb;
  v_units jsonb;
  v_unit jsonb;
  v_operation jsonb;
  v_tenant_id uuid;
  v_contract_id uuid;
  v_contract_unit_id uuid;
  v_unit_id uuid;
  v_start date;
  v_end date;
  v_current jsonb;
  v_item_count integer := 0;
  v_domain_item_count integer := 0;
begin
  if not public.current_account_is_active() or public.current_account_role() not in ('admin', 'manager', 'staff') then
    raise exception '対応依頼の確定権限がありません';
  end if;
  select * into v_request from public.change_request
   where change_request_id = p_change_request_id and row_version = p_expected_row_version and status = 'resolved' for update;
  if not found then raise exception 'Only a resolved change request with the expected version can be applied'; end if;
  if v_request.request_type = 'approval_cancel' then raise exception '取消申請は取消確定操作を使用してください'; end if;
  if v_request.source_appsuite_record_id is not null and exists (
    select 1 from public.appsuite_record where appsuite_record_id = v_request.source_appsuite_record_id and is_cancelled
  ) then raise exception '取消済み稟議は反映できません'; end if;

  if v_request.request_type = 'contract_create' then
    v_contract := v_request.proposed_payload -> 'contract';
    v_units := v_request.proposed_payload -> 'units';
    v_start := nullif(v_contract ->> 'contract_start_date', '')::date;
    v_end := nullif(v_contract ->> 'contract_end_date', '')::date;
    if v_end is not null and v_start is not null and v_end < v_start then raise exception '契約終了日は開始日以降を指定してください'; end if;
    if nullif(v_contract ->> 'tenant_id', '') is not null then
      v_tenant_id := (v_contract ->> 'tenant_id')::uuid;
      perform 1 from public.tenant_master where tenant_id = v_tenant_id for update;
      if not found then raise exception '選択したテナントが見つかりません'; end if;
    else
      insert into public.tenant_master(external_tenant_code, tenant_name, normalized_tenant_name)
      values (
        nullif(v_contract ->> 'external_tenant_code', ''), btrim(v_contract ->> 'new_tenant_name'),
        public.normalize_contract_workflow_key(v_contract ->> 'new_tenant_name')
      ) on conflict (normalized_tenant_name) do update set tenant_name = excluded.tenant_name
      returning tenant_id into v_tenant_id;
    end if;
    insert into public.lease_contract(
      tenant_id, contract_status, contract_type, contract_start_date, contract_end_date,
      renewal_terms, payment_terms, notes, source_system, source_record_key
    ) values (
      v_tenant_id, 'active', nullif(v_contract ->> 'contract_type', ''), v_start, v_end,
      nullif(v_contract ->> 'renewal_terms', ''), nullif(v_contract ->> 'payment_terms', ''), nullif(v_contract ->> 'notes', ''),
      'appsuite', v_request.source_record_key
    ) returning lease_contract_id into v_contract_id;
    for v_unit in select value from jsonb_array_elements(v_units)
    loop
      v_unit_id := (v_unit ->> 'unit_id')::uuid;
      perform 1 from public.unit_master
       where unit_id = v_unit_id and property_id = (v_contract ->> 'property_id')::uuid and is_active for update;
      if not found then raise exception '物件に属する有効な区画が見つかりません'; end if;
      if exists (
        select 1 from public.lease_contract_unit existing_unit
        join public.lease_contract existing_contract on existing_contract.lease_contract_id = existing_unit.lease_contract_id
        where existing_unit.unit_id = v_unit_id and existing_contract.contract_status = 'active'
          and daterange(coalesce(existing_contract.contract_start_date, '-infinity'::date), coalesce(existing_contract.contract_end_date, 'infinity'::date), '[]')
              && daterange(coalesce(v_start, '-infinity'::date), coalesce(v_end, 'infinity'::date), '[]')
      ) then raise exception '契約期間が重複する区画があります'; end if;
      insert into public.lease_contract_unit(
        lease_contract_id, unit_id, leased_area_sqm, monthly_rent_amount, monthly_common_charge_amount,
        deposit_amount, security_deposit_amount, key_money_amount, renewal_fee_amount, lease_start_date, lease_end_date
      ) values (
        v_contract_id, v_unit_id, nullif(v_unit ->> 'leased_area_sqm', '')::numeric,
        nullif(v_unit ->> 'monthly_rent_amount', '')::numeric, nullif(v_unit ->> 'monthly_common_charge_amount', '')::numeric,
        nullif(v_unit ->> 'deposit_amount', '')::numeric, nullif(v_unit ->> 'security_deposit_amount', '')::numeric,
        nullif(v_unit ->> 'key_money_amount', '')::numeric, nullif(v_unit ->> 'renewal_fee_amount', '')::numeric,
        coalesce(nullif(v_unit ->> 'lease_start_date', '')::date, v_start), coalesce(nullif(v_unit ->> 'lease_end_date', '')::date, v_end)
      );
      v_domain_item_count := v_domain_item_count + 1;
    end loop;
    update public.change_request set lease_contract_id = v_contract_id where change_request_id = p_change_request_id;
  elsif v_request.request_type in ('contract_update', 'contract_cancellation_review') then
    v_contract_id := v_request.lease_contract_id;
    perform 1 from public.lease_contract where lease_contract_id = v_contract_id for update;
    if not found then raise exception '対象契約が見つかりません'; end if;
    for v_operation in select value from jsonb_array_elements(v_request.proposed_payload -> 'operations')
    loop
      if v_operation ->> 'action' = 'set_field' and v_operation ->> 'entity_type' = 'lease_contract' then
        select to_jsonb(contract) -> (v_operation ->> 'field_name') into v_current from public.lease_contract contract where lease_contract_id = v_contract_id;
        if v_current is distinct from v_operation -> 'current_value' then raise exception '契約内容が確認後に変更されました。再確認してください'; end if;
        case v_operation ->> 'field_name'
          when 'tenant_id' then update public.lease_contract set tenant_id = (v_operation ->> 'value')::uuid where lease_contract_id = v_contract_id;
          when 'contract_type' then update public.lease_contract set contract_type = v_operation ->> 'value' where lease_contract_id = v_contract_id;
          when 'contract_start_date' then update public.lease_contract set contract_start_date = nullif(v_operation ->> 'value', '')::date where lease_contract_id = v_contract_id;
          when 'contract_end_date' then update public.lease_contract set contract_end_date = nullif(v_operation ->> 'value', '')::date where lease_contract_id = v_contract_id;
          when 'renewal_terms' then update public.lease_contract set renewal_terms = v_operation ->> 'value' where lease_contract_id = v_contract_id;
          when 'payment_terms' then update public.lease_contract set payment_terms = v_operation ->> 'value' where lease_contract_id = v_contract_id;
          when 'notes' then update public.lease_contract set notes = v_operation ->> 'value' where lease_contract_id = v_contract_id;
          else raise exception '変更できない契約項目です';
        end case;
      elsif v_operation ->> 'action' = 'set_field' and v_operation ->> 'entity_type' = 'lease_contract_unit' then
        v_contract_unit_id := (v_operation ->> 'entity_id')::uuid;
        select to_jsonb(contract_unit) -> (v_operation ->> 'field_name') into v_current
          from public.lease_contract_unit contract_unit
         where lease_contract_unit_id = v_contract_unit_id and lease_contract_id = v_contract_id for update;
        if not found then raise exception '対象契約区画が見つかりません'; end if;
        if v_current is distinct from v_operation -> 'current_value' then raise exception '契約区画が確認後に変更されました。再確認してください'; end if;
        case v_operation ->> 'field_name'
          when 'leased_area_sqm' then update public.lease_contract_unit set leased_area_sqm = nullif(v_operation ->> 'value', '')::numeric where lease_contract_unit_id = v_contract_unit_id;
          when 'monthly_rent_amount' then update public.lease_contract_unit set monthly_rent_amount = nullif(v_operation ->> 'value', '')::numeric where lease_contract_unit_id = v_contract_unit_id;
          when 'monthly_common_charge_amount' then update public.lease_contract_unit set monthly_common_charge_amount = nullif(v_operation ->> 'value', '')::numeric where lease_contract_unit_id = v_contract_unit_id;
          when 'deposit_amount' then update public.lease_contract_unit set deposit_amount = nullif(v_operation ->> 'value', '')::numeric where lease_contract_unit_id = v_contract_unit_id;
          when 'security_deposit_amount' then update public.lease_contract_unit set security_deposit_amount = nullif(v_operation ->> 'value', '')::numeric where lease_contract_unit_id = v_contract_unit_id;
          when 'key_money_amount' then update public.lease_contract_unit set key_money_amount = nullif(v_operation ->> 'value', '')::numeric where lease_contract_unit_id = v_contract_unit_id;
          when 'renewal_fee_amount' then update public.lease_contract_unit set renewal_fee_amount = nullif(v_operation ->> 'value', '')::numeric where lease_contract_unit_id = v_contract_unit_id;
          when 'lease_start_date' then update public.lease_contract_unit set lease_start_date = nullif(v_operation ->> 'value', '')::date where lease_contract_unit_id = v_contract_unit_id;
          when 'lease_end_date' then update public.lease_contract_unit set lease_end_date = nullif(v_operation ->> 'value', '')::date where lease_contract_unit_id = v_contract_unit_id;
          else raise exception '変更できない契約区画項目です';
        end case;
      elsif v_operation ->> 'action' = 'link_unit' then
        v_unit_id := (v_operation ->> 'unit_id')::uuid;
        if exists (
          select 1 from public.lease_contract_unit existing_unit join public.lease_contract existing_contract using (lease_contract_id)
           where existing_unit.unit_id = v_unit_id and existing_contract.contract_status = 'active'
        ) then raise exception '契約中の区画は追加できません'; end if;
        insert into public.lease_contract_unit(lease_contract_id, unit_id, leased_area_sqm, monthly_rent_amount, monthly_common_charge_amount, deposit_amount, security_deposit_amount, key_money_amount, renewal_fee_amount, lease_start_date, lease_end_date)
        values (v_contract_id, v_unit_id, nullif(v_operation #>> '{value,leased_area_sqm}', '')::numeric,
          nullif(v_operation #>> '{value,monthly_rent_amount}', '')::numeric, nullif(v_operation #>> '{value,monthly_common_charge_amount}', '')::numeric,
          nullif(v_operation #>> '{value,deposit_amount}', '')::numeric, nullif(v_operation #>> '{value,security_deposit_amount}', '')::numeric,
          nullif(v_operation #>> '{value,key_money_amount}', '')::numeric, nullif(v_operation #>> '{value,renewal_fee_amount}', '')::numeric,
          nullif(v_operation #>> '{value,lease_start_date}', '')::date, nullif(v_operation #>> '{value,lease_end_date}', '')::date);
      elsif v_operation ->> 'action' = 'unlink_unit' then
        update public.lease_contract_unit set lease_end_date = (v_operation #>> '{value,effective_date}')::date - 1
         where lease_contract_unit_id = (v_operation ->> 'entity_id')::uuid and lease_contract_id = v_contract_id;
      else raise exception '対応していない変更操作です';
      end if;
      v_domain_item_count := v_domain_item_count + 1;
    end loop;
  else
    for v_unit in select to_jsonb(item) from public.change_request_item item where change_request_id = p_change_request_id order by sort_order, created_at
    loop
      v_item_count := v_item_count + 1;
      if v_unit ->> 'entity_type' = 'rent_roll_import_issue' then continue; end if;
      if v_unit ->> 'validation_status' <> 'valid' then raise exception 'Every contract change item must be valid before applying'; end if;
      if v_unit ->> 'entity_type' <> 'lease_contract_unit' or nullif(v_unit ->> 'entity_id', '') is null then
        raise exception 'Unsupported change request item';
      end if;
      v_contract_unit_id := (v_unit ->> 'entity_id')::uuid;
      perform 1 from public.lease_contract_unit where lease_contract_unit_id = v_contract_unit_id for update;
      if not found then raise exception 'Lease contract unit was not found'; end if;
      case v_unit ->> 'field_name'
        when 'leased_area_sqm' then update public.lease_contract_unit set leased_area_sqm = ((v_unit -> 'proposed_value') #>> '{}')::numeric where lease_contract_unit_id = v_contract_unit_id;
        when 'monthly_rent_amount' then update public.lease_contract_unit set monthly_rent_amount = ((v_unit -> 'proposed_value') #>> '{}')::numeric where lease_contract_unit_id = v_contract_unit_id;
        when 'monthly_common_charge_amount' then update public.lease_contract_unit set monthly_common_charge_amount = ((v_unit -> 'proposed_value') #>> '{}')::numeric where lease_contract_unit_id = v_contract_unit_id;
        when 'deposit_amount' then update public.lease_contract_unit set deposit_amount = ((v_unit -> 'proposed_value') #>> '{}')::numeric where lease_contract_unit_id = v_contract_unit_id;
        when 'security_deposit_amount' then update public.lease_contract_unit set security_deposit_amount = ((v_unit -> 'proposed_value') #>> '{}')::numeric where lease_contract_unit_id = v_contract_unit_id;
        when 'key_money_amount' then update public.lease_contract_unit set key_money_amount = ((v_unit -> 'proposed_value') #>> '{}')::numeric where lease_contract_unit_id = v_contract_unit_id;
        when 'renewal_fee_amount' then update public.lease_contract_unit set renewal_fee_amount = ((v_unit -> 'proposed_value') #>> '{}')::numeric where lease_contract_unit_id = v_contract_unit_id;
        when 'lease_start_date' then update public.lease_contract_unit set lease_start_date = ((v_unit -> 'proposed_value') #>> '{}')::date where lease_contract_unit_id = v_contract_unit_id;
        when 'lease_end_date' then update public.lease_contract_unit set lease_end_date = ((v_unit -> 'proposed_value') #>> '{}')::date where lease_contract_unit_id = v_contract_unit_id;
        else raise exception 'Unsupported change request item';
      end case;
      v_domain_item_count := v_domain_item_count + 1;
    end loop;
    if v_domain_item_count = 0 and not (v_request.source_type = 'initial_import' and v_request.request_type = 'rent_roll_correction') then
      raise exception 'A change request requires at least one supported field change';
    end if;
  end if;

  update public.change_request_item set validation_status = 'valid', validation_message = null
   where change_request_id = p_change_request_id and entity_type = 'rent_roll_import_issue';
  update public.rent_roll_import_issue issue set resolved_at = now(), resolved_by = auth.uid()
   where issue.rent_roll_import_issue_id in (
     select rent_roll_import_issue_id from public.change_request_item where change_request_id = p_change_request_id and rent_roll_import_issue_id is not null
   ) and issue.resolved_at is null;
  update public.change_request set status = 'applied', applied_at = now(), applied_by = auth.uid(), lease_contract_id = coalesce(lease_contract_id, v_contract_id)
   where change_request_id = p_change_request_id returning * into v_request;
  insert into public.change_request_action_log(change_request_id, action_type, previous_status, next_status, details, performed_by)
  values (p_change_request_id, 'applied', 'resolved', 'applied',
    jsonb_build_object('lease_contract_id', v_request.lease_contract_id, 'domain_item_count', v_domain_item_count, 'before_after', v_request.proposed_payload -> 'operations'), auth.uid());
  return v_request;
end;
$$;

create or replace function public.confirm_approval_cancellation(
  p_change_request_id uuid,
  p_expected_row_version integer,
  p_mode text,
  p_note text
) returns public.change_request
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.change_request;
  v_source public.appsuite_record;
  v_target public.appsuite_record;
  v_contract_id uuid;
  v_follow_up_id uuid;
begin
  if not public.current_account_is_active() or public.current_account_role() not in ('admin', 'manager') then
    raise exception '取消の最終確定は管理者またはマネージャーのみ実行できます';
  end if;
  if p_mode not in ('source_only', 'create_contract_follow_up') then raise exception '取消方法が不正です'; end if;
  if nullif(btrim(p_note), '') is null then raise exception '最終確認メモを入力してください'; end if;
  select * into v_request from public.change_request
   where change_request_id = p_change_request_id and request_type = 'approval_cancel'
     and row_version = p_expected_row_version and status = 'resolved' for update;
  if not found then raise exception '確認済みの取消依頼、または最新のバージョンが見つかりません'; end if;
  if v_request.proposed_payload ->> 'mode' <> p_mode then raise exception '確認済みの取消方法と一致しません'; end if;
  select * into v_source from public.appsuite_record where appsuite_record_id = v_request.source_appsuite_record_id for update;
  select * into v_target from public.appsuite_record where appsuite_record_id = v_request.target_appsuite_record_id for update;
  if not found then raise exception '取消対象の稟議が見つかりません'; end if;
  if public.normalize_appsuite_ringi_number(v_target.ringi_number)
     <> public.normalize_appsuite_ringi_number(public.appsuite_json_text(v_source.raw_payload, '取下稟議番号')) then
    raise exception '取消申請の取下稟議番号と対象稟議が一致しません';
  end if;
  if v_target.is_cancelled then raise exception '対象稟議は既に取消済みです'; end if;
  update public.appsuite_record set is_cancelled = true, cancelled_at = now(), cancelled_by = auth.uid(),
    cancellation_reason = btrim(p_note), cancelled_by_appsuite_record_id = v_source.appsuite_record_id
   where appsuite_record_id = v_target.appsuite_record_id;
  update public.change_request set status = 'excluded', resolved_at = null, resolved_by = null
   where source_appsuite_record_id = v_target.appsuite_record_id and status in ('draft', 'open', 'in_review', 'on_hold', 'resolved');
  select lease_contract_id into v_contract_id from public.change_request
   where source_appsuite_record_id = v_target.appsuite_record_id and status = 'applied'
   order by applied_at desc nulls last limit 1;
  if p_mode = 'create_contract_follow_up' then
    if v_contract_id is null then raise exception '反映済み契約がないため、契約処置タスクは作成できません'; end if;
    insert into public.change_request(
      source_type, source_record_key, request_type, status, title, summary, source_payload,
      proposed_payload, source_appsuite_record_id, target_appsuite_record_id, lease_contract_id
    ) values (
      'manual', concat('cancellation-follow-up:', v_request.change_request_id), 'contract_cancellation_review', 'open',
      concat('取消済み稟議の契約処置確認: ', coalesce(v_target.ringi_number, v_target.data_id)),
      '元稟議は取消済みです。反映済み契約は自動変更せず、必要な処置を確認してください。',
      v_source.raw_payload, '{}'::jsonb, v_source.appsuite_record_id, v_target.appsuite_record_id, v_contract_id
    ) returning change_request_id into v_follow_up_id;
    insert into public.change_request_item(change_request_id, entity_type, entity_id, validation_status, validation_message)
    values (v_follow_up_id, 'lease_contract', v_contract_id, 'pending', '契約を維持・修正・終了するか確認してください。');
    insert into public.change_request_action_log(change_request_id, action_type, details, performed_by)
    values (p_change_request_id, 'follow_up_created', jsonb_build_object('follow_up_change_request_id', v_follow_up_id, 'lease_contract_id', v_contract_id), auth.uid());
  end if;
  update public.change_request set status = 'applied', applied_at = now(), applied_by = auth.uid(),
    resolution_payload = resolution_payload || jsonb_build_object('mode', p_mode, 'final_note', btrim(p_note), 'follow_up_change_request_id', v_follow_up_id)
   where change_request_id = p_change_request_id returning * into v_request;
  insert into public.change_request_action_log(change_request_id, action_type, previous_status, next_status, details, performed_by)
  values (p_change_request_id, 'cancellation_confirmed', 'resolved', 'applied',
    jsonb_build_object('target_appsuite_record_id', v_target.appsuite_record_id, 'mode', p_mode, 'follow_up_change_request_id', v_follow_up_id), auth.uid());
  return v_request;
end;
$$;

revoke all on function public.normalize_appsuite_ringi_number(text) from public, anon, authenticated;
revoke all on function public.appsuite_json_text(jsonb, text) from public, anon, authenticated;
revoke all on function public.enqueue_contract_change_request_from_appsuite() from public, anon, authenticated;
revoke all on function public.save_contract_create_draft(uuid, integer, jsonb, jsonb) from public, anon;
revoke all on function public.save_contract_update_draft(uuid, integer, uuid, jsonb, text) from public, anon;
revoke all on function public.save_approval_cancellation_draft(uuid, integer, uuid, text, text) from public, anon;
revoke all on function public.list_approval_cancellation_candidates(uuid) from public, anon;
revoke all on function public.resolve_change_request(uuid, integer, jsonb) from public, anon;
revoke all on function public.apply_change_request(uuid, integer) from public, anon;
revoke all on function public.confirm_approval_cancellation(uuid, integer, text, text) from public, anon;

grant execute on function public.save_contract_create_draft(uuid, integer, jsonb, jsonb) to authenticated;
grant execute on function public.save_contract_update_draft(uuid, integer, uuid, jsonb, text) to authenticated;
grant execute on function public.save_approval_cancellation_draft(uuid, integer, uuid, text, text) to authenticated;
grant execute on function public.list_approval_cancellation_candidates(uuid) to authenticated;
grant execute on function public.resolve_change_request(uuid, integer, jsonb) to authenticated;
grant execute on function public.apply_change_request(uuid, integer) to authenticated;
grant execute on function public.confirm_approval_cancellation(uuid, integer, text, text) to authenticated;

comment on column public.appsuite_application.contract_workflow_type is '決裁済みレコードから作る契約対応依頼の種別。NULLは契約対応依頼を作らない。';
comment on column public.appsuite_application.contract_workflow_start_at is 'この日時以降に決裁されたレコードだけを対応依頼へ展開する。過去レコードは取消照合用に同期する。';
comment on function public.confirm_approval_cancellation(uuid, integer, text, text) is '管理者・マネージャーが決裁済み稟議を取消済みにし、必要なら反映済み契約の確認タスクを作る。';
