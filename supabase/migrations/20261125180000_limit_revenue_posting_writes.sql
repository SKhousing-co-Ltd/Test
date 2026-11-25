create function public.require_revenue_posting_editor()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.current_account_is_active() or not exists (
    select 1 from public.user_profiles where user_id = auth.uid() and role <> 'viewer'
  ) then
    raise exception '売上計上の操作権限がありません';
  end if;
  return new;
end; $$;
create trigger require_revenue_posting_editor_on_batch
  before insert on public.revenue_posting_batch
  for each row execute function public.require_revenue_posting_editor();
create trigger require_revenue_posting_editor_on_release
  before update on public.revenue_posting_source
  for each row execute function public.require_revenue_posting_editor();

create function public.list_due_revenue_posting_entries(p_asset_id uuid, p_billing_month date)
returns jsonb language sql security definer set search_path = public, pg_temp as $$
  select case when public.current_account_is_active() then
    coalesce(jsonb_agg(jsonb_build_object('postingMonth', e.posting_month, 'cells', e.csv_cells)
      order by e.posting_month, s.billing_month, s.source_key, e.sort_order), '[]'::jsonb)
  else '[]'::jsonb end
  from public.revenue_posting_entry e
  join public.revenue_posting_source s on s.id = e.source_id
  where s.asset_id = p_asset_id and s.released_at is null
    and e.is_immediate = false and e.exported_at is null and e.cancelled_at is null
    and e.posting_month <= p_billing_month;
$$;
revoke all on function public.list_due_revenue_posting_entries(uuid,date) from public;
grant execute on function public.list_due_revenue_posting_entries(uuid,date) to authenticated;
