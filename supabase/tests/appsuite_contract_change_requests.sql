begin;

do $$
declare
  v_target_id uuid;
  v_cancel_source_id uuid;
  v_source_id uuid;
  v_request public.change_request;
  v_property_id uuid;
  v_unit_id uuid;
  v_contract_unit_id uuid;
  v_follow_up_cancel_source_id uuid;
  v_manager_id uuid;
  v_staff_id uuid;
  v_issue_id uuid;
begin
  insert into public.appsuite_application(app_id, app_name, is_sync_enabled, contract_workflow_type, contract_workflow_start_at)
  values
    ('TEST-CONTRACT-CREATE', 'テスト新規契約', true, 'contract_create', '2026-01-01T00:00:00Z'),
    ('TEST-CONTRACT-CANCEL', 'テスト取消', true, 'approval_cancel', '2026-01-01T00:00:00Z'),
    ('TEST-CONTRACT-REFERENCE', 'テスト照合対象', false, null, null);

  insert into public.appsuite_record(app_id, data_id, workflow_type, approval_status, property_name, tenant_name, source_updated_at, raw_payload)
  values ('TEST-CONTRACT-CREATE', 'new-1', '新規契約', '完了', 'テスト物件', 'テストテナント', '2026-02-01T00:00:00Z', '{"稟議番号":{"val":"TEST-NEW-1"}}');

  if (select count(*) from public.change_request where source_record_key = 'TEST-CONTRACT-CREATE:new-1' and request_type = 'contract_create') <> 1 then
    raise exception '運用開始日以降の決裁済み新規契約は1件の対応依頼を作る必要があります';
  end if;

  update public.appsuite_record set revision = '2' where app_id = 'TEST-CONTRACT-CREATE' and data_id = 'new-1';
  if (select count(*) from public.change_request where source_record_key = 'TEST-CONTRACT-CREATE:new-1' and request_type = 'contract_create') <> 1 then
    raise exception '再同期で対応依頼を重複作成してはいけません';
  end if;

  insert into public.appsuite_record(app_id, data_id, workflow_type, approval_status, source_updated_at, raw_payload)
  values ('TEST-CONTRACT-CREATE', 'old-1', '新規契約', '完了', '2025-12-31T23:59:59Z', '{}');
  if exists (select 1 from public.change_request where source_record_key = 'TEST-CONTRACT-CREATE:old-1') then
    raise exception '運用開始日前の申請は対応依頼へ展開してはいけません';
  end if;

  insert into public.appsuite_record(app_id, data_id, workflow_type, approval_status, ringi_number, source_updated_at, raw_payload)
  values ('TEST-CONTRACT-REFERENCE', 'target-1', '新規契約', '完了', ' TEST-CAN-001 ', '2025-01-01T00:00:00Z', '{}')
  returning appsuite_record_id into v_target_id;

  insert into public.appsuite_record(app_id, data_id, workflow_type, approval_status, ringi_number, source_updated_at, raw_payload)
  values ('TEST-CONTRACT-CANCEL', 'cancel-1', '決裁済み稟議取消', '完了', 'TEST-CANCEL-1', '2026-02-02T00:00:00Z',
    '{"取下稟議番号":{"val":"test-can-001"},"取下理由":{"val":"テスト取消"}}')
  returning appsuite_record_id into v_cancel_source_id;

  if not exists (
    select 1 from public.change_request
     where source_appsuite_record_id = v_cancel_source_id and target_appsuite_record_id = v_target_id
       and request_type = 'approval_cancel'
  ) then raise exception '取消申請は正規化した稟議番号で対象稟議へ一意に紐づく必要があります'; end if;

  if public.normalize_appsuite_ringi_number(' sk-abc-001 ') <> 'SK-ABC-001' then
    raise exception '稟議番号の正規化が不正です';
  end if;

  if has_function_privilege('anon', 'public.confirm_approval_cancellation(uuid,integer,text,text)', 'EXECUTE') then
    raise exception '匿名利用者に取消確定RPCを公開してはいけません';
  end if;
  if not has_function_privilege('authenticated', 'public.confirm_approval_cancellation(uuid,integer,text,text)', 'EXECUTE') then
    raise exception '認証済み利用者はRPCを呼び、DB内の役割検証を受けられる必要があります';
  end if;

  select user_id into v_manager_id from public.user_profiles
   where account_status = 'active' and role in ('admin', 'manager') limit 1;
  if v_manager_id is not null then
    perform set_config('request.jwt.claim.sub', v_manager_id::text, true);
    insert into public.asset_master(asset_code, asset_name) values (999991, 'AppSuite契約フローテスト物件')
    returning asset_id into v_property_id;
    insert into public.unit_master(property_id, unit_code, floor_label, unit_type, rentable_area_sqm)
    values (v_property_id, 'TEST-101', '1F', 'office', 50) returning unit_id into v_unit_id;
    insert into public.appsuite_record(app_id, data_id, workflow_type, approval_status, ringi_number, source_updated_at, raw_payload)
    values ('TEST-CONTRACT-CREATE', 'create-source', '新規契約', '完了', 'TEST-CREATE-SOURCE', '2026-02-01T00:00:00Z', '{}')
    returning appsuite_record_id into v_source_id;
    select * into v_request from public.change_request
     where source_appsuite_record_id = v_source_id and request_type = 'contract_create';

    select * into v_request from public.save_contract_create_draft(
      v_request.change_request_id, v_request.row_version,
      jsonb_build_object('property_id', v_property_id, 'new_tenant_name', 'AppSuite契約フローテストテナント', 'contract_type', 'lease', 'contract_start_date', '2026-04-01'),
      jsonb_build_array(jsonb_build_object('unit_id', v_unit_id, 'monthly_rent_amount', '100000', 'monthly_common_charge_amount', '10000'))
    );
    select * into v_request from public.resolve_change_request(v_request.change_request_id, v_request.row_version, '{}'::jsonb);
    select * into v_request from public.apply_change_request(v_request.change_request_id, v_request.row_version);
    if v_request.status <> 'applied' or v_request.lease_contract_id is null then
      raise exception '確認済み新規契約は契約と区画を原子的に作成する必要があります';
    end if;
    if not exists (
      select 1 from public.lease_contract contract join public.lease_contract_unit contract_unit using (lease_contract_id)
       where contract.lease_contract_id = v_request.lease_contract_id and contract.source_system = 'appsuite'
         and contract.source_record_key = 'TEST-CONTRACT-CREATE:create-source' and contract_unit.unit_id = v_unit_id
    ) then raise exception '作成契約はAppSuite発生元と選択区画を保持する必要があります'; end if;
    update public.appsuite_record set revision = 'after-apply'
     where appsuite_record_id = v_source_id;
    if (select count(*) from public.change_request where source_record_key = 'TEST-CONTRACT-CREATE:create-source' and request_type = 'contract_create') <> 1 then
      raise exception '適用後の再同期でも同じ発生元の対応依頼を重複作成してはいけません';
    end if;
    select lease_contract_unit_id into v_contract_unit_id from public.lease_contract_unit
     where lease_contract_id = v_request.lease_contract_id and unit_id = v_unit_id;

    insert into public.change_request(source_type, source_record_key, request_type, title, source_appsuite_record_id, lease_contract_id)
    values ('desknets', 'TEST-CONTRACT-CREATE:update-source', 'contract_update', '契約変更RPCテスト', v_source_id, v_request.lease_contract_id)
    returning * into v_request;
    insert into public.change_request_item(change_request_id, entity_type, validation_status, validation_message)
    values (v_request.change_request_id, 'other', 'pending', '入力待ち');
    select * into v_request from public.save_contract_update_draft(
      v_request.change_request_id, v_request.row_version, v_request.lease_contract_id,
      jsonb_build_array(
        jsonb_build_object('action', 'set_field', 'entity_type', 'lease_contract', 'field_name', 'notes', 'value', '変更申請を目視確認済み'),
        jsonb_build_object('action', 'set_field', 'entity_type', 'lease_contract_unit', 'entity_id', v_contract_unit_id, 'field_name', 'monthly_rent_amount', 'value', '120000')
      ), null
    );
    select * into v_request from public.resolve_change_request(v_request.change_request_id, v_request.row_version, '{}'::jsonb);
    select * into v_request from public.apply_change_request(v_request.change_request_id, v_request.row_version);
    if (select notes from public.lease_contract where lease_contract_id = v_request.lease_contract_id) <> '変更申請を目視確認済み'
       or (select monthly_rent_amount from public.lease_contract_unit where lease_contract_unit_id = v_contract_unit_id) <> 120000 then
      raise exception '契約変更は確認済みの複数操作を同一トランザクションで反映する必要があります';
    end if;

    insert into public.change_request(source_type, source_record_key, request_type, title, source_appsuite_record_id, lease_contract_id)
    values ('desknets', 'TEST-CONTRACT-CREATE:concurrency-source', 'contract_update', '同時編集検知テスト', v_source_id, v_request.lease_contract_id)
    returning * into v_request;
    insert into public.change_request_item(change_request_id, entity_type, validation_status, validation_message)
    values (v_request.change_request_id, 'other', 'pending', '入力待ち');
    select * into v_request from public.save_contract_update_draft(
      v_request.change_request_id, v_request.row_version, v_request.lease_contract_id,
      jsonb_build_array(jsonb_build_object('action', 'set_field', 'entity_type', 'lease_contract_unit', 'entity_id', v_contract_unit_id, 'field_name', 'monthly_rent_amount', 'value', '130000')), null
    );
    update public.lease_contract_unit set monthly_rent_amount = 125000 where lease_contract_unit_id = v_contract_unit_id;
    select * into v_request from public.resolve_change_request(v_request.change_request_id, v_request.row_version, '{}'::jsonb);
    begin
      perform public.apply_change_request(v_request.change_request_id, v_request.row_version);
      raise exception '確認後に正本が変更された場合は適用を拒否する必要があります';
    exception when others then
      if sqlerrm not like '%再確認してください%' then raise; end if;
    end;

    insert into public.appsuite_record(app_id, data_id, workflow_type, approval_status, ringi_number, source_updated_at, raw_payload)
    values ('TEST-CONTRACT-CANCEL', 'cancel-follow-up', '決裁済み稟議取消', '完了', 'TEST-CANCEL-FOLLOW-UP', '2026-02-03T00:00:00Z',
      '{"取下稟議番号":{"val":"TEST-CREATE-SOURCE"},"取下理由":{"val":"契約反映後の取消テスト"}}')
    returning appsuite_record_id into v_follow_up_cancel_source_id;
    select * into v_request from public.change_request
     where source_appsuite_record_id = v_follow_up_cancel_source_id and request_type = 'approval_cancel';
    select * into v_request from public.save_approval_cancellation_draft(
      v_request.change_request_id, v_request.row_version, v_source_id, 'create_contract_follow_up', '反映済み契約があることを確認'
    );
    select * into v_request from public.resolve_change_request(v_request.change_request_id, v_request.row_version, '{}'::jsonb);
    select * into v_request from public.confirm_approval_cancellation(
      v_request.change_request_id, v_request.row_version, 'create_contract_follow_up', '契約処置は別タスクで判断'
    );
    if not exists (
      select 1 from public.change_request where request_type = 'contract_cancellation_review'
       and target_appsuite_record_id = v_source_id and lease_contract_id is not null and status = 'open'
    ) then raise exception '反映済み契約を自動変更せず、別の契約処置タスクを作る必要があります'; end if;

    select * into v_request from public.change_request
     where source_appsuite_record_id = v_cancel_source_id and request_type = 'approval_cancel';
    select * into v_request from public.save_approval_cancellation_draft(
      v_request.change_request_id, v_request.row_version, v_target_id, 'source_only', '対象稟議を原本で確認済み'
    );
    select * into v_request from public.resolve_change_request(v_request.change_request_id, v_request.row_version, '{}'::jsonb);

    select user_id into v_staff_id from public.user_profiles where account_status = 'active' and role = 'staff' limit 1;
    if v_staff_id is not null then
      perform set_config('request.jwt.claim.sub', v_staff_id::text, true);
      begin
        perform public.confirm_approval_cancellation(v_request.change_request_id, v_request.row_version, 'source_only', 'スタッフ確定テスト');
        raise exception 'スタッフは取消を最終確定できません';
      exception when insufficient_privilege then null;
      when others then
        if sqlerrm not like '%管理者またはマネージャー%' then raise; end if;
      end;
      perform set_config('request.jwt.claim.sub', v_manager_id::text, true);
    end if;
    select * into v_request from public.confirm_approval_cancellation(
      v_request.change_request_id, v_request.row_version, 'source_only', '管理者が対象稟議を最終確認'
    );
    if v_request.status <> 'applied' or not (select is_cancelled from public.appsuite_record where appsuite_record_id = v_target_id) then
      raise exception '管理者の最終確定で対象稟議を取消済みにする必要があります';
    end if;

    insert into public.rent_roll_import_issue(source_file_name, source_sheet_name, source_row_number, issue_type, message)
    values ('appsuite-flow-test.xlsx', 'テスト', 1, 'combined_unit', '確認テスト') returning rent_roll_import_issue_id into v_issue_id;
    insert into public.change_request(source_type, source_record_key, request_type, title)
    values ('initial_import', 'appsuite-flow-review-only', 'rent_roll_correction', '既存確認依頼互換テスト') returning * into v_request;
    insert into public.change_request_item(change_request_id, rent_roll_import_issue_id, entity_type, validation_status, validation_message)
    values (v_request.change_request_id, v_issue_id, 'rent_roll_import_issue', 'pending', '目視確認待ち');
    select * into v_request from public.resolve_change_request(v_request.change_request_id, v_request.row_version, '{}'::jsonb);
    select * into v_request from public.apply_change_request(v_request.change_request_id, v_request.row_version);
    if v_request.status <> 'applied' or (select resolved_at from public.rent_roll_import_issue where rent_roll_import_issue_id = v_issue_id) is null then
      raise exception '既存の確認専用取込依頼を引き続き確定できる必要があります';
    end if;
  end if;
end;
$$;

rollback;
