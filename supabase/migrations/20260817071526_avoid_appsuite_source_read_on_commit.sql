-- Keep AppSuite raw records private; the reviewed inbox contains every field needed to commit.
create or replace function public.commit_appsuite_procurement_inbox(target_id uuid)
returns uuid
language plpgsql security invoker
set search_path = public
as $$
declare item public.appsuite_procurement_inbox;
declare order_id uuid;
begin
  if not public.current_account_is_active() or public.current_account_role() not in ('admin', 'manager', 'staff') then raise exception '登録権限がありません'; end if;
  select inbox.* into item from public.appsuite_procurement_inbox as inbox
   where inbox.appsuite_procurement_inbox_id = target_id for update;
  if not found or item.match_status <> 'ready' then raise exception '照合が完了した発注だけ登録できます'; end if;
  insert into public.procurement_order (
    property_id, account_id, vendor_id, order_type, title, description, gross_amount,
    expected_payment_date, status, appsuite_app_id, appsuite_ringi_number, appsuite_record_id, appsuite_line_number, notes
  ) values (
    item.matched_property_id, item.matched_account_id, item.matched_vendor_id, 'repair', item.title, item.description, item.gross_amount,
    item.expected_payment_date, 'approved', '87', item.ringi_number, item.appsuite_record_id, item.line_number,
    'AppSuiteの決裁済み修繕発注稟議から登録'
  ) returning procurement_order_id into order_id;
  update public.appsuite_procurement_inbox as inbox
     set match_status = 'imported', imported_procurement_order_id = order_id, updated_at = now()
   where inbox.appsuite_procurement_inbox_id = target_id;
  return order_id;
end;
$$;

revoke all on function public.commit_appsuite_procurement_inbox(uuid) from public;
grant execute on function public.commit_appsuite_procurement_inbox(uuid) to authenticated;
