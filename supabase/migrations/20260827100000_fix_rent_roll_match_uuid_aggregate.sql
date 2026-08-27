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
