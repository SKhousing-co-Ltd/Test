-- Accounting CSVs commonly express a month without a day.
create or replace function public.parse_external_month(value text)
returns date
language plpgsql
immutable
set search_path = public
as $$
declare normalized text := btrim(coalesce(value, ''));
begin
  if normalized = '' then return null; end if;
  if normalized ~ '^[0-9]{4}[-/][0-9]{1,2}$' then
    return to_date(replace(normalized, '-', '/') || '/01', 'YYYY/MM/DD');
  end if;
  if normalized ~ '^[0-9]{4}年[0-9]{1,2}月$' then
    return to_date(replace(replace(normalized, '年', '/'), '月', '/01'), 'YYYY/MM/DD');
  end if;
  return date_trunc('month', public.parse_external_date(normalized))::date;
exception when others then
  return null;
end;
$$;

revoke all on function public.parse_external_month(text) from public;
grant execute on function public.parse_external_month(text) to authenticated;

create or replace function public.refresh_financial_actual_import_batch(target_batch_id uuid)
returns void
language plpgsql security invoker
set search_path = public
as $$
declare item public.financial_actual_import_row;
declare issue_list text[];
declare property_matches integer;
declare account_matches integer;
declare resolved_property_id uuid;
declare resolved_account_id varchar(10);
declare resolved_month date;
declare resolved_entry_date date;
declare resolved_amount numeric;
begin
  if not public.current_account_is_active() or public.current_account_role() not in ('admin', 'manager', 'staff') then
    raise exception '取込更新権限がありません';
  end if;
  if not exists (select 1 from public.financial_actual_import_batch where financial_actual_import_batch_id = target_batch_id) then
    raise exception '取込バッチが見つかりません';
  end if;

  for item in
    select * from public.financial_actual_import_row
    where financial_actual_import_batch_id = target_batch_id and match_status not in ('applied', 'ignored')
    order by source_row_number
  loop
    issue_list := '{}';
    resolved_month := public.parse_external_month(item.accounting_month_text);
    resolved_entry_date := public.parse_external_date(item.entry_date_text);
    resolved_amount := public.parse_external_amount(item.amount_text);

    if item.is_manually_resolved then
      resolved_property_id := item.matched_property_id;
      resolved_account_id := item.matched_account_id;
    else
      select count(*), min(asset.asset_id::text)::uuid into property_matches, resolved_property_id
      from public.asset_master as asset
      where (item.property_code ~ '^\s*[0-9]+\s*$' and asset.asset_code::text = btrim(item.property_code))
         or (nullif(btrim(item.property_name), '') is not null and (asset.asset_name = btrim(item.property_name) or asset.short_name = btrim(item.property_name)));
      if property_matches <> 1 then resolved_property_id := null; end if;

      select count(*), min(account.account_id) into account_matches, resolved_account_id
      from public.income_expense_account_master as account
      where (nullif(btrim(item.account_id_text), '') is not null and account.account_id = btrim(item.account_id_text))
         or (nullif(btrim(item.account_name), '') is not null and account.account_name = btrim(item.account_name));
      if account_matches <> 1 then resolved_account_id := null; end if;
    end if;

    if resolved_property_id is null then issue_list := array_append(issue_list, '物件を特定できません'); end if;
    if resolved_account_id is null then issue_list := array_append(issue_list, '収支科目を特定できません'); end if;
    if resolved_month is null then issue_list := array_append(issue_list, '計上月を確認してください'); end if;
    if nullif(btrim(coalesce(item.entry_date_text, '')), '') is not null and resolved_entry_date is null then issue_list := array_append(issue_list, '発生日を確認してください'); end if;
    if resolved_amount is null or resolved_amount <= 0 then issue_list := array_append(issue_list, '金額を確認してください'); end if;
    if nullif(btrim(coalesce(item.description, '')), '') is null then issue_list := array_append(issue_list, '内容を入力してください'); end if;
    if length(coalesce(item.description, '')) > 500 then issue_list := array_append(issue_list, '内容は500文字以内にしてください'); end if;
    if length(coalesce(item.counterparty_name, '')) > 200 then issue_list := array_append(issue_list, '相手先は200文字以内にしてください'); end if;

    update public.financial_actual_import_row
       set matched_property_id = resolved_property_id, matched_account_id = resolved_account_id,
           accounting_month = resolved_month, entry_date = resolved_entry_date, amount = resolved_amount,
           issues = issue_list, match_status = case when cardinality(issue_list) = 0 then 'ready' else 'action_required' end,
           updated_at = now()
     where financial_actual_import_row_id = item.financial_actual_import_row_id;
  end loop;

  update public.financial_actual_import_batch as batch
     set row_count = counts.row_count,
         ready_count = counts.ready_count,
         issue_count = counts.issue_count,
         applied_count = counts.applied_count,
         status = case
           when counts.row_count = 0 then 'action_required'
           when counts.issue_count > 0 then 'action_required'
           when counts.ready_count > 0 then 'ready'
           when counts.applied_count = counts.row_count then 'applied'
           else batch.status
         end,
         error_message = null,
         updated_at = now()
  from (
    select count(*)::integer as row_count,
      count(*) filter (where match_status = 'ready')::integer as ready_count,
      count(*) filter (where match_status = 'action_required')::integer as issue_count,
      count(*) filter (where match_status = 'applied')::integer as applied_count
    from public.financial_actual_import_row
    where financial_actual_import_batch_id = target_batch_id
  ) as counts
  where batch.financial_actual_import_batch_id = target_batch_id;
end;
$$;

comment on function public.parse_external_month(text) is 'CSVのYYYY/MM、YYYY-MM、YYYY年M月、日付形式を月初日に正規化する。';
