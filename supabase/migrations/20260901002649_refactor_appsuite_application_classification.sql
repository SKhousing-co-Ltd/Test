-- AppSuite application definitions are the sole source of truth for business routing.
-- appsuite_record.workflow_type remains an API/display attribute and is never used to
-- choose a downstream business workflow.

alter table public.appsuite_application
  add column business_domain varchar(40),
  add column processing_type varchar(40),
  add column workflow_start_at timestamptz;

update public.appsuite_application
set business_domain = case contract_workflow_type
      when 'contract_create' then 'lease_contract'
      when 'contract_update' then 'lease_contract'
      when 'approval_cancel' then 'workflow_control'
    end,
    processing_type = contract_workflow_type,
    workflow_start_at = contract_workflow_start_at
where contract_workflow_type is not null;

update public.appsuite_application
set business_domain = 'procurement', processing_type = 'repair_order'
where app_id = '87';

update public.appsuite_application
set business_domain = 'procurement', processing_type = 'purchase_order',
    workflow_start_at = coalesce(workflow_start_at, now())
where app_id = '62';

update public.appsuite_application
set business_domain = 'lease_contract', processing_type = 'contract_terminate',
    workflow_start_at = coalesce(workflow_start_at, now()), is_sync_enabled = true
where app_id in ('71', '75', '76', '110');

-- Every enabled application needs an explicit disposition.  Unknown applications
-- are safely retained as synchronized-only until an administrator classifies them.
update public.appsuite_application
set business_domain = 'other', processing_type = 'sync_only'
where is_sync_enabled
  and (business_domain is null or processing_type is null);

alter table public.appsuite_application
  add constraint ck_appsuite_application_business_route check (
    (not is_sync_enabled and business_domain is null and processing_type is null)
    or (business_domain = 'lease_contract' and processing_type in ('contract_create', 'contract_update', 'contract_terminate'))
    or (business_domain = 'procurement' and processing_type in ('repair_order', 'purchase_order'))
    or (business_domain = 'workflow_control' and processing_type = 'approval_cancel')
    or (business_domain = 'payment' and processing_type = 'payment_request')
    or (business_domain in ('master', 'other') and processing_type = 'sync_only')
  );

alter table public.appsuite_application
  drop constraint if exists ck_appsuite_application_contract_workflow_type,
  drop column contract_workflow_type,
  drop column contract_workflow_start_at;

comment on column public.appsuite_application.business_domain is
  'AppSuiteアプリの業務大分類。appsuite_record.app_idから業務処理を決定する正本。';
comment on column public.appsuite_application.processing_type is
  'AppSuiteアプリの具体的な処理種別。稟議番号・アプリ名・workflow_typeで代替判定してはならない。';
comment on column public.appsuite_application.workflow_start_at is
  'この日時以降に決裁されたレコードだけを業務処理へ展開する。過去レコードは同期・照合用に保持する。';
comment on column public.appsuite_record.workflow_type is
  'AppSuiteの申請要件から取得した表示・検索用属性。業務ルーティングには使用しない。';

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
  if not found or v_config.business_domain not in ('lease_contract', 'workflow_control')
     or not new.is_present or new.is_cancelled then
    return new;
  end if;
  if lower(coalesce(new.approval_status, '')) not in ('approved', 'completed', '承認済み', '完了', '承認', '決裁済み', '社長決裁済')
     or coalesce(new.source_updated_at, new.source_created_at, new.created_at) < v_config.workflow_start_at then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.revision is not distinct from new.revision
     and old.raw_payload is not distinct from new.raw_payload
     and old.approval_status is not distinct from new.approval_status
     and old.is_present is not distinct from new.is_present then return new; end if;

  if v_config.processing_type = 'approval_cancel' then
    v_target_ringi := public.appsuite_json_text(new.raw_payload, '取下稟議番号');
    select count(*), min(appsuite_record_id::text)::uuid into v_target_count, v_target_id
      from public.appsuite_record
     where appsuite_record_id <> new.appsuite_record_id and is_present
       and public.normalize_appsuite_ringi_number(ringi_number) = public.normalize_appsuite_ringi_number(v_target_ringi)
       and lower(coalesce(approval_status, '')) in ('approved', 'completed', '承認済み', '完了', '承認', '決裁済み', '社長決裁済');
    if v_target_count <> 1 then v_target_id := null; end if;
    v_title := concat('決裁済み稟議取消: ', coalesce(v_target_ringi, '対象稟議番号未設定'));
    v_summary := case when v_target_count = 1 then '対象稟議を確認し、取消方法を選択してください。'
      else concat('対象稟議の一致件数は', v_target_count, '件です。対象を確認してください。') end;
    v_validation_status := case when v_target_count = 1 then 'valid' else 'error' end;
    v_validation_message := v_summary;
  elsif v_config.processing_type = 'contract_create' then
    v_title := concat('AppSuite新規契約: ', coalesce(new.property_name, '物件未設定'), ' / ', coalesce(new.tenant_name, '契約者未設定'));
    v_summary := '決裁済み申請です。契約内容とリーシング区画を確認してください。';
    v_validation_message := 'テナント、契約内容、リーシング区画を登録してください。';
  elsif v_config.processing_type = 'contract_terminate' then
    v_title := concat('AppSuite契約解約: ', coalesce(new.property_name, '物件未設定'), ' / ', coalesce(new.tenant_name, '契約者未設定'));
    v_summary := '決裁済み解約申請です。対象契約と終了内容を確認してください。';
    v_validation_message := '対象契約と終了日、必要な処理を登録してください。';
  else
    v_title := concat('AppSuite契約変更: ', coalesce(new.property_name, '物件未設定'), ' / ', coalesce(new.tenant_name, '契約者未設定'));
    v_summary := '決裁済み申請です。申請原文と現在の契約を照合し、変更内容を手入力してください。';
    v_validation_message := '対象契約と反映する変更、または対象項目なしの理由を登録してください。';
  end if;

  insert into public.change_request (source_type, source_record_key, request_type, status, title, summary,
    source_payload, proposed_payload, source_appsuite_record_id, target_appsuite_record_id)
  values ('desknets', concat(new.app_id, ':', new.data_id), v_config.processing_type, 'open', v_title, v_summary,
    new.raw_payload, case when v_config.processing_type = 'approval_cancel'
      then jsonb_build_object('target_ringi_number', v_target_ringi, 'target_match_count', v_target_count) else '{}'::jsonb end,
    new.appsuite_record_id, v_target_id)
  on conflict (source_type, source_record_key, request_type)
    where source_record_key is not null and status not in ('applied', 'excluded')
  do update set source_payload = excluded.source_payload,
    source_appsuite_record_id = excluded.source_appsuite_record_id,
    target_appsuite_record_id = coalesce(public.change_request.target_appsuite_record_id, excluded.target_appsuite_record_id),
    summary = case when public.change_request.status in ('applied', 'excluded') then public.change_request.summary else excluded.summary end
  returning change_request_id into v_request_id;

  if not exists (select 1 from public.change_request_item where change_request_id = v_request_id) then
    insert into public.change_request_item(change_request_id, entity_type, validation_status, validation_message)
    values (v_request_id, 'other', v_validation_status, v_validation_message);
  end if;
  return new;
end;
$$;

create or replace function public.stage_appsuite_procurement_record()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_config public.appsuite_application;
  line_no integer; line_label text; line_labels constant text[] := array['①', '②', '③'];
  vendor_value text; amount_value numeric; title_value text; payment_date_value date; inbox_id uuid;
begin
  select * into v_config from public.appsuite_application where app_id = new.app_id;
  if not found or v_config.business_domain <> 'procurement'
     or v_config.processing_type not in ('repair_order', 'purchase_order')
     or not new.is_present or coalesce(new.approval_status, '') not in ('完了', '承認', '決裁済み') then return new; end if;
  for line_no in 1..3 loop
    line_label := line_labels[line_no]; inbox_id := null;
    vendor_value := coalesce(public.appsuite_text_value(new.raw_payload, format('発注業者%s', line_label)), public.appsuite_text_value(new.raw_payload, format('発注業者%s', line_no)));
    if vendor_value is null and line_no = 1 then vendor_value := public.appsuite_text_value(new.raw_payload, '発注先'); end if;
    amount_value := coalesce(public.parse_external_amount(public.appsuite_text_value(new.raw_payload, format('発注金額%s（税込）', line_label))), public.parse_external_amount(public.appsuite_text_value(new.raw_payload, format('発注金額%s（税込）', line_no))));
    title_value := coalesce(public.appsuite_text_value(new.raw_payload, format('発注内容%s', line_label)), public.appsuite_text_value(new.raw_payload, format('発注内容%s', line_no)), public.appsuite_text_value(new.raw_payload, '不具合内容'), public.appsuite_text_value(new.raw_payload, '詳細'));
    payment_date_value := coalesce(public.parse_external_date(public.appsuite_text_value(new.raw_payload, format('支払予定日%s', line_label))), public.parse_external_date(public.appsuite_text_value(new.raw_payload, format('支払予定日%s', line_no))));
    if vendor_value is not null or amount_value is not null then
      insert into public.appsuite_procurement_inbox (appsuite_record_id, line_number, ringi_number, property_code, property_name, vendor_name, title, description, gross_amount, expected_payment_date, source_payload)
      values (new.appsuite_record_id, line_no, left(new.ringi_number, 100), left(public.appsuite_text_value(new.raw_payload, '物件コード'), 100), left(coalesce(public.appsuite_text_value(new.raw_payload, '建物名称'), public.appsuite_text_value(new.raw_payload, '物件名')), 200), left(vendor_value, 200), left(title_value, 300), public.appsuite_text_value(new.raw_payload, '詳細'), amount_value, payment_date_value, new.raw_payload)
      on conflict (appsuite_record_id, line_number) do update set ringi_number = excluded.ringi_number, property_code = excluded.property_code, property_name = excluded.property_name, vendor_name = excluded.vendor_name, title = excluded.title, description = excluded.description, gross_amount = excluded.gross_amount, expected_payment_date = excluded.expected_payment_date, source_payload = excluded.source_payload, updated_at = now()
      where public.appsuite_procurement_inbox.match_status not in ('imported', 'ignored') returning appsuite_procurement_inbox_id into inbox_id;
      if inbox_id is not null then perform public.reconcile_appsuite_procurement_inbox(inbox_id); end if;
    end if;
  end loop;
  return new;
end;
$$;

-- Remove the obsolete client-invoked, app_id=65-only path.  Trigger routing is
-- transactionally coupled to record synchronization and covers every classified app.
drop function if exists public.create_change_request_from_appsuite_record(varchar, varchar);

-- Re-run the procurement handler only for repair orders.  It cannot create a
-- contract request, and the conflict key makes the operation idempotent.
update public.appsuite_record set raw_payload = raw_payload
where app_id = '87' and is_present;
