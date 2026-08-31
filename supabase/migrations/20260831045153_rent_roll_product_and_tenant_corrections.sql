-- 商品区分をレントロールと統一し、契約名義・商品を既存の監査経路で変更できるようにする。

alter table public.unit_master drop constraint if exists ck_unit_master_type;
alter table public.unit_master add constraint ck_unit_master_type check (
  unit_type in ('office', 'retail', 'residential', 'storage', 'parking', 'equipment', 'other', 'bicycle_parking', 'signage', 'warehouse', 'antenna')
);

update public.unit_master
set unit_type = case unit_type
  when 'storage' then 'warehouse'
  when 'retail' then 'other'
  when 'equipment' then 'other'
  else unit_type
end
where unit_type in ('storage', 'retail', 'equipment');

alter table public.unit_master drop constraint if exists ck_unit_master_type;
alter table public.unit_master add constraint ck_unit_master_type check (
  unit_type in ('office', 'residential', 'parking', 'bicycle_parking', 'signage', 'warehouse', 'antenna', 'other')
);

alter table public.unit_master add column if not exists row_version integer not null default 1;
alter table public.unit_master drop constraint if exists ck_unit_master_row_version;
alter table public.unit_master add constraint ck_unit_master_row_version check (row_version > 0);

create or replace function public.bump_unit_master_row_version()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new is distinct from old and new.row_version = old.row_version then new.row_version := old.row_version + 1; end if;
  return new;
end;
$$;
drop trigger if exists bump_unit_master_row_version on public.unit_master;
create trigger bump_unit_master_row_version before update on public.unit_master
for each row execute procedure public.bump_unit_master_row_version();
revoke all on function public.bump_unit_master_row_version() from public, anon, authenticated;

-- 原文は保持し、取込・照合時だけコードの有効性を統一判定する。
create or replace function public.normalize_rent_roll_tenant_code(p_value text)
returns text language plpgsql immutable security invoker set search_path = '' as $$
declare normalized text := regexp_replace(btrim(coalesce(p_value, '')), '[[:space:]　]+', '', 'g');
begin
  if normalized = '' or normalized ~ '^[\-－―—ー−]+$' then return null; end if;
  return normalized;
end;
$$;
revoke all on function public.normalize_rent_roll_tenant_code(text) from public, anon;
grant execute on function public.normalize_rent_roll_tenant_code(text) to authenticated;

update public.tenant_master
set external_tenant_code = null, updated_at = now()
where external_tenant_code is not null
  and public.normalize_rent_roll_tenant_code(external_tenant_code) is null;

update public.tenant_billing_code
set is_active = false, is_primary = false, updated_at = now()
where is_active and public.normalize_rent_roll_tenant_code(billing_code) is null;

alter table public.tenant_master drop constraint if exists ck_tenant_master_external_code_valid;
alter table public.tenant_master add constraint ck_tenant_master_external_code_valid check (
  external_tenant_code is null or public.normalize_rent_roll_tenant_code(external_tenant_code) is not null
);
alter table public.tenant_billing_code drop constraint if exists ck_tenant_billing_code_active_valid;
alter table public.tenant_billing_code add constraint ck_tenant_billing_code_active_valid check (
  not is_active or public.normalize_rent_roll_tenant_code(billing_code) is not null
);

-- 指定された4契約だけを安全な複合条件で訂正する。福岡の同名契約は対象外。
do $$
declare refresh_tenant_id uuid; biceps_tenant_id uuid; sk_tenant_id uuid; target_count integer; owner_id uuid;
begin
  select tenant_id into refresh_tenant_id from public.tenant_master
  where normalized_tenant_name = lower(regexp_replace('リフレッシュルーム(喫煙室)', '[[:space:]　]+', '', 'g'));
  select tenant_id into biceps_tenant_id from public.tenant_master
  where normalized_tenant_name = lower(regexp_replace('(株)バイセップス', '[[:space:]　]+', '', 'g'));
  select tenant_id into sk_tenant_id from public.tenant_master
  where normalized_tenant_name = lower(regexp_replace('SKハウジング(株)', '[[:space:]　]+', '', 'g'));
  -- データなしで作成されるPreview環境では、データ訂正だけを安全にスキップする。
  if refresh_tenant_id is null and biceps_tenant_id is null and sk_tenant_id is null then
    raise notice '東館訂正対象のテナントがないため、データ訂正をスキップします';
    return;
  end if;
  if refresh_tenant_id is null or biceps_tenant_id is null or sk_tenant_id is null then
    raise exception '東館訂正に必要なテナントが見つかりません';
  end if;
  select count(*) into target_count
  from public.lease_contract contract
  join public.lease_contract_unit contract_unit using (lease_contract_id)
  join public.unit_master unit using (unit_id)
  join public.asset_master asset on asset.asset_id = unit.property_id
  where asset.asset_name = '三共ビル東館' and unit.unit_code in ('B101', 'B102', 'B106', '903')
    and contract.tenant_id = refresh_tenant_id and contract.contract_status in ('active', 'scheduled')
    and contract.source_system = 'rent_roll_xlsx';
  if target_count <> 4 then raise exception '東館訂正対象は4件である必要があります（実際: %件）', target_count; end if;
  select tenant_id into owner_id from public.tenant_billing_code where billing_code = '1311';
  if owner_id is not null and owner_id <> biceps_tenant_id then raise exception '請求コード1311は別テナントに割り当て済みです'; end if;
  insert into public.tenant_billing_code(tenant_id, billing_code, is_primary, is_active, sort_order)
  select biceps_tenant_id, '1311', false, true,
    coalesce((select max(sort_order) + 1 from public.tenant_billing_code where tenant_id = biceps_tenant_id), 0)
  where not exists (select 1 from public.tenant_billing_code where billing_code = '1311');
  update public.lease_contract contract set tenant_id = case unit.unit_code
    when 'B101' then biceps_tenant_id when 'B102' then biceps_tenant_id else sk_tenant_id end
  from public.lease_contract_unit contract_unit join public.unit_master unit on unit.unit_id = contract_unit.unit_id
  join public.asset_master asset on asset.asset_id = unit.property_id
  where contract.lease_contract_id = contract_unit.lease_contract_id and asset.asset_name = '三共ビル東館'
    and unit.unit_code in ('B101', 'B102', 'B106', '903') and contract.tenant_id = refresh_tenant_id
    and contract.contract_status in ('active', 'scheduled') and contract.source_system = 'rent_roll_xlsx';
  if not found then raise exception '東館訂正対象を更新できませんでした'; end if;
end;
$$;

create or replace function private.match_rent_roll_import_batch(p_batch_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare matched_count integer; ambiguous_count integer; unmatched_count integer;
begin
  if auth.uid() is null or not (select public.current_account_is_active())
     or (select public.current_account_role()) not in ('admin', 'manager') then
    raise exception 'レントロール照合は管理者またはマネージャーだけが実行できます';
  end if;
  perform 1 from public.rent_roll_import_batch where rent_roll_import_batch_id = p_batch_id for update;
  if not found then raise exception '比較バッチが見つかりません'; end if;
  with candidates as (
    select source.rent_roll_import_row_id,
      public.normalize_rent_roll_tenant_code(source.tenant_code) as normalized_code,
      lower(regexp_replace(coalesce(source.tenant_name, ''), '[[:space:]　]+', '', 'g')) as normalized_name,
      snapshot.lease_contract_unit_id
    from public.rent_roll_import_row source
    join public.rent_roll_import_batch batch using (rent_roll_import_batch_id)
    left join public.asset_master asset on asset.asset_name = source.property_name
    left join public.unit_master unit on unit.property_id = asset.asset_id and unit.unit_code = source.unit_code
      and (source.floor_label is null or unit.floor_label = source.floor_label)
    left join public.lease_contract_unit_snapshot_at_date(asset.asset_id, batch.as_of_date) snapshot on snapshot.unit_id = unit.unit_id
    where source.rent_roll_import_batch_id = p_batch_id
      and ((public.normalize_rent_roll_tenant_code(source.tenant_code) is not null and (
          snapshot.external_tenant_code = public.normalize_rent_roll_tenant_code(source.tenant_code)
          or exists (select 1 from public.tenant_billing_code code where code.tenant_id = snapshot.tenant_id
            and code.billing_code = public.normalize_rent_roll_tenant_code(source.tenant_code) and code.is_active)
        )) or (public.normalize_rent_roll_tenant_code(source.tenant_code) is null
          and lower(regexp_replace(coalesce(source.tenant_name, ''), '[[:space:]　]+', '', 'g')) <> ''
          and lower(regexp_replace(snapshot.tenant_name, '[[:space:]　]+', '', 'g')) = lower(regexp_replace(source.tenant_name, '[[:space:]　]+', '', 'g'))))
  ), counts as (
    select row.rent_roll_import_row_id, count(candidates.lease_contract_unit_id)::integer as candidate_count,
      min(candidates.lease_contract_unit_id) as candidate_id,
      public.normalize_rent_roll_tenant_code(row.tenant_code) as normalized_code,
      nullif(lower(regexp_replace(coalesce(row.tenant_name, ''), '[[:space:]　]+', '', 'g')), '') as normalized_name
    from public.rent_roll_import_row row left join candidates using (rent_roll_import_row_id)
    where row.rent_roll_import_batch_id = p_batch_id
    group by row.rent_roll_import_row_id, row.tenant_code, row.tenant_name
  )
  update public.rent_roll_import_row row set
    matched_lease_contract_unit_id = case when counts.candidate_count = 1 then counts.candidate_id else null end,
    match_status = case when counts.candidate_count = 1 then 'matched' when counts.candidate_count > 1 then 'ambiguous' else 'unmatched' end,
    match_note = case when counts.candidate_count = 1 and counts.normalized_code is not null then '有効なテナントコードで一致'
      when counts.candidate_count = 1 then 'テナントコード未設定のため名称一致で照合'
      when counts.candidate_count > 1 then concat('候補が', counts.candidate_count, '件あります')
      when counts.normalized_code is null and counts.normalized_name is null then 'テナントコード・名義が未設定のため自動照合しません'
      when counts.normalized_code is null then 'テナントコード未設定かつ名義不一致のため自動照合しません'
      else '有効なテナントコードに一致する契約区画がありません' end,
    updated_at = now()
  from counts where row.rent_roll_import_row_id = counts.rent_roll_import_row_id;
  select count(*) filter (where match_status = 'matched'), count(*) filter (where match_status = 'ambiguous'), count(*) filter (where match_status = 'unmatched')
  into matched_count, ambiguous_count, unmatched_count from public.rent_roll_import_row where rent_roll_import_batch_id = p_batch_id;
  update public.rent_roll_import_batch set status = case when ambiguous_count + unmatched_count = 0 then 'matched' else 'reviewing' end, updated_at = now()
  where rent_roll_import_batch_id = p_batch_id;
  return jsonb_build_object('matched', matched_count, 'ambiguous', ambiguous_count, 'unmatched', unmatched_count);
end;
$$;
revoke all on function private.match_rent_roll_import_batch(uuid) from public, anon;
grant execute on function private.match_rent_roll_import_batch(uuid) to authenticated;

create or replace function public.contract_term_detail_for_audit(
  p_lease_contract_unit_id uuid,
  p_as_of_date date default current_date
)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_set(
    jsonb_set(
      detail.base_detail, '{contract}', detail.base_detail -> 'contract' || jsonb_build_object(
        'lease_term_type', contract.lease_term_type, 'renewal_due_date', contract.renewal_due_date,
        'actual_end_date', contract.actual_end_date, 'renewed_from_contract_id', contract.renewed_from_contract_id
      )
    ),
    '{contract,unit_row_version}', to_jsonb(unit.row_version), true
  )
  from public.lease_contract_unit contract_unit
  join public.lease_contract contract using (lease_contract_id)
  join public.unit_master unit using (unit_id)
  cross join lateral (select public.contract_detail_for_audit(p_lease_contract_unit_id, p_as_of_date) base_detail) detail
  where contract_unit.lease_contract_unit_id = p_lease_contract_unit_id;
$$;
revoke all on function public.contract_term_detail_for_audit(uuid, date) from public, anon;
grant execute on function public.contract_term_detail_for_audit(uuid, date) to authenticated;

create or replace function public.apply_rent_roll_contract_edit_with_terms_and_identity(
  p_lease_contract_unit_id uuid, p_expected_contract_row_version integer, p_expected_contract_unit_row_version integer,
  p_contract_changes jsonb, p_contract_unit_changes jsonb, p_term_changes jsonb,
  p_tenant_id uuid, p_unit_type text, p_expected_unit_row_version integer, p_reason text, p_as_of_date date default current_date
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare contract_record public.lease_contract%rowtype; unit_record public.unit_master%rowtype; request_id uuid; changed boolean := false;
begin
  if auth.uid() is null or not (select public.current_account_is_active()) or (select public.current_account_role()) not in ('admin', 'manager') then raise exception '契約編集は管理者またはマネージャーだけが実行できます'; end if;
  if nullif(btrim(p_reason), '') is null then raise exception '変更理由を入力してください'; end if;
  select contract.* into contract_record from public.lease_contract_unit cu join public.lease_contract contract using (lease_contract_id)
  join public.unit_master unit on unit.unit_id = cu.unit_id where cu.lease_contract_unit_id = p_lease_contract_unit_id and unit.unit_type <> 'parking' for update of contract;
  if not found or contract_record.row_version <> p_expected_contract_row_version then raise exception '契約情報が別の操作で更新されました。再読み込みしてください'; end if;
  select unit.* into unit_record from public.lease_contract_unit cu join public.unit_master unit on unit.unit_id = cu.unit_id
  where cu.lease_contract_unit_id = p_lease_contract_unit_id for update of unit;
  if p_unit_type is not null and unit_record.row_version <> p_expected_unit_row_version then raise exception '商品情報が別の操作で更新されました。再読み込みしてください'; end if;
  if p_tenant_id is not null and p_tenant_id <> contract_record.tenant_id then
    perform 1 from public.tenant_master where tenant_id = p_tenant_id for update; if not found then raise exception '選択したテナントが見つかりません'; end if;
    changed := true;
  end if;
  if p_unit_type is not null and p_unit_type <> unit_record.unit_type then
    if p_unit_type not in ('office', 'residential', 'parking', 'bicycle_parking', 'signage', 'warehouse', 'antenna', 'other') then raise exception '商品コードが不正です'; end if;
    if p_unit_type = 'parking' then raise exception '主契約の区画を駐車場商品へ変更できません'; end if;
    changed := true;
  end if;
  if coalesce(p_contract_changes, '{}'::jsonb) <> '{}'::jsonb or coalesce(p_contract_unit_changes, '{}'::jsonb) <> '{}'::jsonb or coalesce(p_term_changes, '{}'::jsonb) <> '{}'::jsonb then
    perform public.apply_rent_roll_contract_edit_with_terms(p_lease_contract_unit_id, p_expected_contract_row_version, p_expected_contract_unit_row_version, p_contract_changes, p_contract_unit_changes, p_term_changes, p_reason, p_as_of_date);
    changed := true;
  end if;
  if not changed then raise exception '変更された項目がありません'; end if;
  if (p_tenant_id is not null and p_tenant_id <> contract_record.tenant_id) or (p_unit_type is not null and p_unit_type <> unit_record.unit_type) then
    insert into public.change_request(source_type, source_record_key, request_type, status, title, summary, source_payload, proposed_payload, resolution_payload, lease_contract_id, resolved_at, resolved_by, applied_at, applied_by)
    values ('manual', concat('rent-roll-identity-edit:', p_lease_contract_unit_id, ':', gen_random_uuid()), 'contract_update', 'applied', 'レントロール契約名義・商品修正', btrim(p_reason), jsonb_build_object('origin','rent_roll_contract_modal','reason',btrim(p_reason)), '{}'::jsonb, jsonb_build_object('reason',btrim(p_reason)), contract_record.lease_contract_id, now(), auth.uid(), now(), auth.uid()) returning change_request_id into request_id;
    if p_tenant_id is not null and p_tenant_id <> contract_record.tenant_id then
      insert into public.change_request_item(change_request_id, entity_type, entity_id, field_name, current_value, proposed_value, validation_status, validation_message)
      values (request_id, 'lease_contract', contract_record.lease_contract_id, 'tenant_id', to_jsonb(contract_record.tenant_id), to_jsonb(p_tenant_id), 'valid', 'レントロール画面で変更前後を確認済み');
      update public.lease_contract set tenant_id = p_tenant_id where lease_contract_id = contract_record.lease_contract_id;
    end if;
    if p_unit_type is not null and p_unit_type <> unit_record.unit_type then
      insert into public.change_request_item(change_request_id, entity_type, entity_id, field_name, current_value, proposed_value, validation_status, validation_message)
      values (request_id, 'unit_master', unit_record.unit_id, 'unit_type', to_jsonb(unit_record.unit_type), to_jsonb(p_unit_type), 'valid', 'レントロール画面で変更前後を確認済み');
      update public.unit_master set unit_type = p_unit_type, updated_at = now() where unit_id = unit_record.unit_id and row_version = p_expected_unit_row_version;
      if not found then raise exception '商品情報が別の操作で更新されました。再読み込みしてください'; end if;
    end if;
    insert into public.change_request_action_log(change_request_id, action_type, previous_status, next_status, details, performed_by)
    values (request_id, 'applied', null, 'applied', jsonb_build_object('reason', btrim(p_reason)), auth.uid());
  end if;
  return jsonb_build_object('change_request_id', request_id, 'status', 'applied', 'detail', public.contract_term_detail_for_audit(p_lease_contract_unit_id, p_as_of_date));
end;
$$;
revoke all on function public.apply_rent_roll_contract_edit_with_terms_and_identity(uuid, integer, integer, jsonb, jsonb, jsonb, uuid, text, integer, text, date) from public, anon;
grant execute on function public.apply_rent_roll_contract_edit_with_terms_and_identity(uuid, integer, integer, jsonb, jsonb, jsonb, uuid, text, integer, text, date) to authenticated;

comment on function public.normalize_rent_roll_tenant_code(text) is '空白・ダッシュ類だけのテナントコードを未設定として扱う。原文値は変更しない。';
