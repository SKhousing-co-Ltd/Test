-- レントロールからの安全な主契約編集と、旧レントロール比較レポートを追加する。
-- 駐車場契約は既存の駐車場台帳・駐車料対応依頼から独立して編集する。

alter table public.rent_roll_import_row
  add column if not exists source_monthly_parking_amount numeric(14, 0);

alter table public.rent_roll_import_row
  drop constraint if exists ck_rent_roll_import_row_amounts;
alter table public.rent_roll_import_row
  add constraint ck_rent_roll_import_row_amounts check (
    (source_area_sqm is null or source_area_sqm >= 0)
    and (source_monthly_rent_amount is null or source_monthly_rent_amount >= 0)
    and (source_monthly_common_charge_amount is null or source_monthly_common_charge_amount >= 0)
    and (source_monthly_parking_amount is null or source_monthly_parking_amount >= 0)
    and (source_other_monthly_amount is null or source_other_monthly_amount >= 0)
    and (source_monthly_total_amount is null or source_monthly_total_amount >= 0)
  );

create or replace function private.apply_rent_roll_contract_edit(
  p_lease_contract_unit_id uuid,
  p_expected_contract_row_version integer,
  p_expected_contract_unit_row_version integer,
  p_contract_changes jsonb,
  p_contract_unit_changes jsonb,
  p_reason text,
  p_as_of_date date default current_date
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  contract_record public.lease_contract%rowtype;
  contract_unit_record public.lease_contract_unit%rowtype;
  tenant_name_value text;
  property_name_value text;
  unit_label_value text;
  field_name_value text;
  current_value jsonb;
  proposed_value jsonb;
  operations jsonb := '[]'::jsonb;
  request_record public.change_request%rowtype;
  resolved_record public.change_request%rowtype;
  item_order integer := 0;
begin
  if auth.uid() is null
     or not (select public.current_account_is_active())
     or (select public.current_account_role()) not in ('admin', 'manager') then
    raise exception '契約編集は管理者またはマネージャーだけが実行できます';
  end if;
  if p_lease_contract_unit_id is null or p_as_of_date is null then
    raise exception '契約区画IDと基準日は必須です';
  end if;
  if jsonb_typeof(coalesce(p_contract_changes, '{}'::jsonb)) <> 'object'
     or jsonb_typeof(coalesce(p_contract_unit_changes, '{}'::jsonb)) <> 'object' then
    raise exception '変更内容はJSONオブジェクトで指定してください';
  end if;
  if nullif(btrim(p_reason), '') is null then
    raise exception '変更理由を入力してください';
  end if;

  select contract.* into contract_record
  from public.lease_contract_unit contract_unit
  join public.lease_contract contract on contract.lease_contract_id = contract_unit.lease_contract_id
  join public.unit_master unit on unit.unit_id = contract_unit.unit_id
  where contract_unit.lease_contract_unit_id = p_lease_contract_unit_id
    and unit.unit_type <> 'parking'
  for update of contract;
  if not found then raise exception '対象の主契約が見つかりません'; end if;

  select contract_unit.* into contract_unit_record
  from public.lease_contract_unit contract_unit
  where contract_unit.lease_contract_unit_id = p_lease_contract_unit_id
    and contract_unit.lease_contract_id = contract_record.lease_contract_id
  for update;

  if contract_record.row_version <> p_expected_contract_row_version
     or contract_unit_record.row_version <> p_expected_contract_unit_row_version then
    raise exception '契約情報が別の操作で更新されました。再読み込みして確認してください';
  end if;

  select tenant.tenant_name, asset.asset_name,
         concat_ws(' ', unit.floor_label, coalesce(unit.unit_name, unit.unit_code))
  into tenant_name_value, property_name_value, unit_label_value
  from public.tenant_master tenant
  join public.unit_master unit on unit.unit_id = contract_unit_record.unit_id
  join public.asset_master asset on asset.asset_id = unit.property_id
  where tenant.tenant_id = contract_record.tenant_id;

  for field_name_value in select jsonb_object_keys(coalesce(p_contract_changes, '{}'::jsonb))
  loop
    if field_name_value not in (
      'contract_type', 'contract_start_date', 'contract_end_date',
      'renewal_terms', 'payment_terms', 'notes'
    ) then raise exception '変更できない契約項目です: %', field_name_value; end if;
    current_value := to_jsonb(contract_record) -> field_name_value;
    proposed_value := p_contract_changes -> field_name_value;
    if current_value is distinct from proposed_value then
      operations := operations || jsonb_build_array(jsonb_build_object(
        'action', 'set_field', 'entity_type', 'lease_contract',
        'field_name', field_name_value, 'value', proposed_value
      ));
    end if;
  end loop;

  for field_name_value in select jsonb_object_keys(coalesce(p_contract_unit_changes, '{}'::jsonb))
  loop
    if field_name_value not in (
      'leased_area_sqm', 'monthly_rent_amount', 'monthly_common_charge_amount',
      'deposit_amount', 'security_deposit_amount', 'key_money_amount',
      'renewal_fee_amount', 'lease_start_date', 'lease_end_date'
    ) then raise exception '変更できない契約区画項目です: %', field_name_value; end if;
    current_value := to_jsonb(contract_unit_record) -> field_name_value;
    proposed_value := p_contract_unit_changes -> field_name_value;
    if current_value is distinct from proposed_value then
      operations := operations || jsonb_build_array(jsonb_build_object(
        'action', 'set_field', 'entity_type', 'lease_contract_unit',
        'entity_id', contract_unit_record.lease_contract_unit_id,
        'field_name', field_name_value, 'value', proposed_value
      ));
    end if;
  end loop;

  if jsonb_array_length(operations) = 0 then
    raise exception '変更された項目がありません';
  end if;

  insert into public.change_request (
    source_type, source_record_key, request_type, status, title, summary,
    source_payload, proposed_payload, lease_contract_id
  ) values (
    'manual', concat('rent-roll-edit:', p_lease_contract_unit_id, ':', gen_random_uuid()),
    'contract_update', 'open',
    concat('レントロール契約修正: ', property_name_value, ' ', unit_label_value),
    concat(tenant_name_value, '｜', btrim(p_reason)),
    jsonb_build_object(
      'origin', 'rent_roll_contract_modal', 'as_of_date', p_as_of_date,
      'lease_contract_unit_id', p_lease_contract_unit_id,
      'expected_contract_row_version', p_expected_contract_row_version,
      'expected_contract_unit_row_version', p_expected_contract_unit_row_version,
      'reason', btrim(p_reason)
    ),
    '{}'::jsonb,
    contract_record.lease_contract_id
  ) returning * into request_record;

  for proposed_value in select value from jsonb_array_elements(operations)
  loop
    item_order := item_order + 1;
    current_value := case
      when proposed_value ->> 'entity_type' = 'lease_contract'
        then to_jsonb(contract_record) -> (proposed_value ->> 'field_name')
      else to_jsonb(contract_unit_record) -> (proposed_value ->> 'field_name')
    end;
    insert into public.change_request_item (
      change_request_id, entity_type, entity_id, field_name,
      current_value, proposed_value, validation_status, validation_message, sort_order
    ) values (
      request_record.change_request_id,
      proposed_value ->> 'entity_type',
      case when proposed_value ->> 'entity_type' = 'lease_contract'
        then contract_record.lease_contract_id else contract_unit_record.lease_contract_unit_id end,
      proposed_value ->> 'field_name', current_value, proposed_value -> 'value',
      'valid', 'レントロール画面で変更前後を確認済み', item_order
    );
  end loop;

  select * into request_record from public.save_contract_update_draft(
    request_record.change_request_id, request_record.row_version,
    contract_record.lease_contract_id, operations, null
  );
  select * into resolved_record from public.resolve_change_request(
    request_record.change_request_id, request_record.row_version,
    jsonb_build_object('reason', btrim(p_reason), 'confirmed_in', 'rent_roll_contract_modal')
  );
  select * into request_record from public.apply_change_request(
    resolved_record.change_request_id, resolved_record.row_version
  );

  return jsonb_build_object(
    'change_request_id', request_record.change_request_id,
    'status', request_record.status,
    'detail', public.contract_detail_for_audit(p_lease_contract_unit_id, p_as_of_date)
  );
end;
$$;

revoke all on function private.apply_rent_roll_contract_edit(uuid, integer, integer, jsonb, jsonb, text, date)
  from public, anon;
grant execute on function private.apply_rent_roll_contract_edit(uuid, integer, integer, jsonb, jsonb, text, date)
  to authenticated;

create or replace function public.apply_rent_roll_contract_edit(
  p_lease_contract_unit_id uuid,
  p_expected_contract_row_version integer,
  p_expected_contract_unit_row_version integer,
  p_contract_changes jsonb,
  p_contract_unit_changes jsonb,
  p_reason text,
  p_as_of_date date default current_date
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog, public, private
as $$
  select private.apply_rent_roll_contract_edit(
    p_lease_contract_unit_id, p_expected_contract_row_version,
    p_expected_contract_unit_row_version, p_contract_changes,
    p_contract_unit_changes, p_reason, p_as_of_date
  );
$$;

revoke all on function public.apply_rent_roll_contract_edit(uuid, integer, integer, jsonb, jsonb, text, date)
  from public, anon;
grant execute on function public.apply_rent_roll_contract_edit(uuid, integer, integer, jsonb, jsonb, text, date)
  to authenticated;

create or replace function private.match_rent_roll_import_batch(p_batch_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  matched_count integer;
  ambiguous_count integer;
  unmatched_count integer;
begin
  if auth.uid() is null
     or not (select public.current_account_is_active())
     or (select public.current_account_role()) not in ('admin', 'manager') then
    raise exception 'レントロール照合は管理者またはマネージャーだけが実行できます';
  end if;
  perform 1 from public.rent_roll_import_batch where rent_roll_import_batch_id = p_batch_id for update;
  if not found then raise exception '比較バッチが見つかりません'; end if;

  with candidate_counts as (
    select source.rent_roll_import_row_id,
           count(contract_unit.lease_contract_unit_id) filter (
             where source.tenant_code is null
                or tenant.external_tenant_code = source.tenant_code
                or exists (
                  select 1 from public.tenant_billing_code code
                  where code.tenant_id = tenant.tenant_id
                    and code.billing_code = source.tenant_code
                    and code.is_active
                )
           )::integer as candidate_count,
           (array_agg(contract_unit.lease_contract_unit_id) filter (
             where source.tenant_code is null
                or tenant.external_tenant_code = source.tenant_code
                or exists (
                  select 1 from public.tenant_billing_code code
                  where code.tenant_id = tenant.tenant_id
                    and code.billing_code = source.tenant_code
                    and code.is_active
                )
           ))[1] as candidate_id
    from public.rent_roll_import_row source
    join public.rent_roll_import_batch batch
      on batch.rent_roll_import_batch_id = source.rent_roll_import_batch_id
    left join public.asset_master asset on asset.asset_name = source.property_name
    left join public.unit_master unit
      on unit.property_id = asset.asset_id
     and unit.unit_code = source.unit_code
     and (source.floor_label is null or unit.floor_label = source.floor_label)
    left join public.lease_contract_unit contract_unit on contract_unit.unit_id = unit.unit_id
    left join public.lease_contract contract on contract.lease_contract_id = contract_unit.lease_contract_id
      and coalesce(contract_unit.lease_start_date, contract.contract_start_date, '-infinity'::date) <= batch.as_of_date
      and coalesce(contract_unit.lease_end_date, contract.contract_end_date, 'infinity'::date) >= batch.as_of_date
      and contract.contract_status in ('active', 'terminated', 'expired')
    left join public.tenant_master tenant on tenant.tenant_id = contract.tenant_id
    where source.rent_roll_import_batch_id = p_batch_id
    group by source.rent_roll_import_row_id
  )
  update public.rent_roll_import_row source
  set matched_lease_contract_unit_id = case when candidates.candidate_count = 1 then candidates.candidate_id else null end,
      match_status = case when candidates.candidate_count = 1 then 'matched'
                          when candidates.candidate_count > 1 then 'ambiguous' else 'unmatched' end,
      match_note = case when candidates.candidate_count = 1 then null
                        when candidates.candidate_count > 1 then concat('候補が', candidates.candidate_count, '件あります')
                        else '物件・区画・テナントコードに一致する契約区画がありません' end,
      updated_at = now()
  from candidate_counts candidates
  where source.rent_roll_import_row_id = candidates.rent_roll_import_row_id;

  select count(*) filter (where match_status = 'matched'),
         count(*) filter (where match_status = 'ambiguous'),
         count(*) filter (where match_status = 'unmatched')
  into matched_count, ambiguous_count, unmatched_count
  from public.rent_roll_import_row where rent_roll_import_batch_id = p_batch_id;

  update public.rent_roll_import_batch
  set status = case when ambiguous_count + unmatched_count = 0 then 'matched' else 'reviewing' end,
      updated_at = now()
  where rent_roll_import_batch_id = p_batch_id;

  return jsonb_build_object('matched', matched_count, 'ambiguous', ambiguous_count, 'unmatched', unmatched_count);
end;
$$;

revoke all on function private.match_rent_roll_import_batch(uuid) from public, anon;
grant execute on function private.match_rent_roll_import_batch(uuid) to authenticated;

create or replace function public.match_rent_roll_import_batch(p_batch_id uuid)
returns jsonb language sql volatile security invoker
set search_path = pg_catalog, public, private
as $$ select private.match_rent_roll_import_batch(p_batch_id); $$;
revoke all on function public.match_rent_roll_import_batch(uuid) from public, anon;
grant execute on function public.match_rent_roll_import_batch(uuid) to authenticated;

create or replace function public.rent_roll_reconciliation_report(
  p_batch_id uuid,
  p_property_id uuid default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = pg_catalog, public
as $$
declare
  report jsonb;
begin
  if auth.uid() is null
     or not (select public.current_account_is_active())
     or (select public.current_account_role()) = 'viewer' then
    raise exception '整合性確認データを閲覧する権限がありません';
  end if;

  with evaluated as (
    select
      source.rent_roll_import_row_id,
      source.source_sheet_name,
      source.source_row_number,
      source.property_name,
      source.unit_code,
      source.tenant_code,
      source.tenant_name,
      source.match_status,
      source.match_note,
      source.matched_lease_contract_unit_id,
      coalesce(source.source_monthly_rent_amount, 0) as source_rent,
      coalesce(source.source_monthly_common_charge_amount, 0) as source_common,
      coalesce(source.source_monthly_parking_amount, 0) as source_parking,
      coalesce(source.source_other_monthly_amount, 0) as source_other,
      case when unit.unit_type in ('office', 'retail', 'residential', 'storage')
        then coalesce(contract_unit.monthly_rent_amount, 0) else 0 end as db_rent,
      coalesce(contract_unit.monthly_common_charge_amount, 0) as db_common,
      case when unit.unit_type = 'parking' then coalesce(parking_fee.own_fee, 0)
        else coalesce(parking_fee.related_fee, 0) end as db_parking,
      case when unit.unit_type not in ('office', 'retail', 'residential', 'storage', 'parking')
        then coalesce(contract_unit.monthly_rent_amount, 0) else 0 end as db_other
    from public.rent_roll_import_row source
    join public.rent_roll_import_batch batch on batch.rent_roll_import_batch_id = source.rent_roll_import_batch_id
    left join public.lease_contract_unit contract_unit
      on contract_unit.lease_contract_unit_id = source.matched_lease_contract_unit_id
    left join public.unit_master unit on unit.unit_id = contract_unit.unit_id
    left join lateral (
      select
        sum(fee.monthly_parking_fee) filter (where fee.parking_lease_contract_unit_id = contract_unit.lease_contract_unit_id) as own_fee,
        sum(fee.monthly_parking_fee) filter (where fee.main_lease_contract_unit_id = contract_unit.lease_contract_unit_id) as related_fee
      from public.parking_fee_history fee
      where (fee.parking_lease_contract_unit_id = contract_unit.lease_contract_unit_id
          or fee.main_lease_contract_unit_id = contract_unit.lease_contract_unit_id)
        and fee.effective_from <= batch.as_of_date
        and (fee.effective_to is null or fee.effective_to >= batch.as_of_date)
    ) parking_fee on true
    where source.rent_roll_import_batch_id = p_batch_id
      and (p_property_id is null or unit.property_id = p_property_id)
  ), classified as (
    select evaluated.*,
      source_rent + source_common + source_parking + source_other as source_total,
      db_rent + db_common + db_parking + db_other as db_total,
      db_rent - source_rent as rent_difference,
      db_common - source_common as common_difference,
      db_parking - source_parking as parking_difference,
      db_other - source_other as other_difference,
      case when match_status <> 'matched' then 'needs_review'
           when db_rent = source_rent and db_common = source_common
            and db_parking = source_parking and db_other = source_other then 'matched'
           else 'mismatch' end as reconciliation_status
    from evaluated
  ), property_summary as (
    select property_name,
      sum(source_rent) as source_rent, sum(db_rent) as db_rent,
      sum(source_common) as source_common, sum(db_common) as db_common,
      sum(source_parking) as source_parking, sum(db_parking) as db_parking,
      sum(source_other) as source_other, sum(db_other) as db_other,
      sum(source_total) as source_total, sum(db_total) as db_total,
      sum(db_total - source_total) as difference,
      count(*) filter (where reconciliation_status = 'matched') as matched_count,
      count(*) filter (where reconciliation_status = 'needs_review') as needs_review_count,
      count(*) filter (where reconciliation_status = 'mismatch') as mismatch_count
    from classified group by property_name
  )
  select jsonb_build_object(
    'batch', (select to_jsonb(batch) from public.rent_roll_import_batch batch where batch.rent_roll_import_batch_id = p_batch_id),
    'rows', coalesce((select jsonb_agg(to_jsonb(classified) order by property_name, source_sheet_name, source_row_number) from classified), '[]'::jsonb),
    'properties', coalesce((select jsonb_agg(to_jsonb(property_summary) order by property_name) from property_summary), '[]'::jsonb),
    'overall', coalesce((select jsonb_build_object(
      'source_rent', sum(source_rent), 'db_rent', sum(db_rent),
      'source_common', sum(source_common), 'db_common', sum(db_common),
      'source_parking', sum(source_parking), 'db_parking', sum(db_parking),
      'source_other', sum(source_other), 'db_other', sum(db_other),
      'source_total', sum(source_total), 'db_total', sum(db_total),
      'difference', sum(db_total - source_total),
      'matched_count', count(*) filter (where reconciliation_status = 'matched'),
      'needs_review_count', count(*) filter (where reconciliation_status = 'needs_review'),
      'mismatch_count', count(*) filter (where reconciliation_status = 'mismatch')
    ) from classified), '{}'::jsonb)
  ) into report;
  return report;
end;
$$;

revoke all on function public.rent_roll_reconciliation_report(uuid, uuid) from public, anon;
grant execute on function public.rent_roll_reconciliation_report(uuid, uuid) to authenticated;

comment on function public.apply_rent_roll_contract_edit(uuid, integer, integer, jsonb, jsonb, text, date)
  is 'レントロール画面で確認した主契約変更を既存の変更申請・監査ログ経由で適用し、更新後詳細を返す。';
comment on function public.match_rent_roll_import_batch(uuid)
  is '比較元レントロールを物件・区画・テナントコードで契約区画へ照合する。契約正本は更新しない。';
comment on function public.rent_roll_reconciliation_report(uuid, uuid)
  is '旧レントロールとDB再構成値を賃料・共益費・駐車場代・その他月額に分けて比較する。';
