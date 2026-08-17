-- Qualify columns that share names with PL/pgSQL variables.
create or replace function public.reconcile_appsuite_procurement_inbox(target_id uuid)
returns void language plpgsql set search_path = public as $$
declare item public.appsuite_procurement_inbox;
declare issue_list text[] := '{}';
declare property_matches integer := 0;
declare vendor_matches integer := 0;
declare property_id uuid;
declare vendor_id uuid;
begin
  select inbox.* into item from public.appsuite_procurement_inbox as inbox where inbox.appsuite_procurement_inbox_id = target_id;
  if not found or item.match_status in ('imported', 'ignored') then return; end if;
  select count(*), min(asset.asset_id::text)::uuid into property_matches, property_id
  from public.asset_master as asset
  where (item.property_code is not null and asset.asset_code::text = regexp_replace(item.property_code, '[^0-9]', '', 'g'))
     or (item.property_name is not null and (asset.asset_name = item.property_name or asset.short_name = item.property_name));
  if property_matches <> 1 then issue_list := array_append(issue_list, case when property_matches = 0 then '物件を特定できません' else '物件候補が複数あります' end); end if;
  select count(*), min(vendor.vendor_id::text)::uuid into vendor_matches, vendor_id
  from public.vendor_master as vendor
  where vendor.is_active and item.vendor_name is not null
    and regexp_replace(lower(vendor.vendor_name), '[[:space:]　株式会社（）()]', '', 'g') = regexp_replace(lower(item.vendor_name), '[[:space:]　株式会社（）()]', '', 'g');
  if vendor_matches <> 1 then issue_list := array_append(issue_list, case when vendor_matches = 0 then '取引先を登録してください' else '取引先候補が複数あります' end); end if;
  if item.gross_amount is null or item.gross_amount <= 0 then issue_list := array_append(issue_list, '発注金額を確認してください'); end if;
  if item.title is null then issue_list := array_append(issue_list, '発注内容を確認してください'); end if;
  update public.appsuite_procurement_inbox as inbox
     set matched_property_id = case when property_matches = 1 then property_id else null end,
         matched_vendor_id = case when vendor_matches = 1 then vendor_id else null end,
         matched_account_id = 'M08', issues = issue_list,
         match_status = case when cardinality(issue_list) = 0 then 'ready' else 'action_required' end, updated_at = now()
   where inbox.appsuite_procurement_inbox_id = target_id;
end;
$$;

create or replace function public.reconcile_billone_invoice_inbox(target_id uuid)
returns void language plpgsql set search_path = public as $$
declare item public.billone_invoice_inbox;
declare issue_list text[] := '{}';
declare property_matches integer := 0;
declare vendor_matches integer := 0;
declare order_matches integer := 0;
declare property_id uuid;
declare vendor_id uuid;
declare resolved_account_id varchar(10);
declare order_id uuid;
begin
  select inbox.* into item from public.billone_invoice_inbox as inbox where inbox.billone_invoice_inbox_id = target_id;
  if not found or item.match_status in ('imported', 'ignored') then return; end if;
  select count(*), min(orders.procurement_order_id::text)::uuid into order_matches, order_id
  from public.procurement_order as orders
  where (item.order_number is not null and orders.order_number = item.order_number)
     or (item.ringi_number is not null and orders.appsuite_ringi_number = item.ringi_number);
  if order_matches = 1 then
    select orders.property_id, orders.vendor_id, orders.account_id into property_id, vendor_id, resolved_account_id
      from public.procurement_order as orders where orders.procurement_order_id = order_id;
  else
    select count(*), min(asset.asset_id::text)::uuid into property_matches, property_id from public.asset_master as asset
      where (item.property_code is not null and asset.asset_code::text = regexp_replace(item.property_code, '[^0-9]', '', 'g'))
         or (item.property_name is not null and (asset.asset_name = item.property_name or asset.short_name = item.property_name));
    select count(*), min(vendor.vendor_id::text)::uuid into vendor_matches, vendor_id from public.vendor_master as vendor
      where vendor.is_active and ((item.supplier_id is not null and vendor.billone_supplier_id = item.supplier_id)
        or (item.supplier_name is not null and regexp_replace(lower(vendor.vendor_name), '[[:space:]　株式会社（）()]', '', 'g') = regexp_replace(lower(item.supplier_name), '[[:space:]　株式会社（）()]', '', 'g')));
    resolved_account_id := item.account_id;
    if property_matches <> 1 then property_id := null; end if;
    if vendor_matches <> 1 then vendor_id := null; end if;
  end if;
  if property_id is null then issue_list := array_append(issue_list, '物件を特定できません'); end if;
  if vendor_id is null then issue_list := array_append(issue_list, '取引先を特定できません'); end if;
  if resolved_account_id is null or not exists (select 1 from public.income_expense_account_master as account where account.account_id = resolved_account_id) then issue_list := array_append(issue_list, '収支科目を特定できません'); end if;
  if item.invoice_date is null then issue_list := array_append(issue_list, '請求日を確認してください'); end if;
  if item.due_date is null or (item.invoice_date is not null and item.due_date < item.invoice_date) then issue_list := array_append(issue_list, '支払期日を確認してください'); end if;
  if item.gross_amount is null or item.gross_amount <= 0 then issue_list := array_append(issue_list, '請求金額を確認してください'); end if;
  if coalesce(item.subtotal_amount, 0) + coalesce(item.tax_amount, 0) <> coalesce(item.gross_amount, -1) then issue_list := array_append(issue_list, '税抜額・消費税・税込額が一致しません'); end if;
  update public.billone_invoice_inbox as inbox
     set matched_property_id = property_id, matched_vendor_id = vendor_id, matched_account_id = resolved_account_id,
         matched_procurement_order_id = case when order_matches = 1 then order_id else null end,
         issues = issue_list, match_status = case when cardinality(issue_list) = 0 then 'ready' else 'action_required' end, updated_at = now()
   where inbox.billone_invoice_inbox_id = target_id;
end;
$$;

revoke all on function public.reconcile_appsuite_procurement_inbox(uuid), public.reconcile_billone_invoice_inbox(uuid) from public;
grant execute on function public.reconcile_appsuite_procurement_inbox(uuid), public.reconcile_billone_invoice_inbox(uuid) to authenticated, service_role;
