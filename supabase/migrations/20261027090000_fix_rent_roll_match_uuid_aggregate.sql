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
      (array_agg(candidates.lease_contract_unit_id) filter (where candidates.lease_contract_unit_id is not null))[1] as candidate_id,
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
