create or replace function public.list_approval_inventory()
returns table (appsuite_record_id uuid, app_id varchar, data_id varchar, ringi_number varchar, workflow_type varchar, approval_status varchar, property_name text, tenant_name text, source_updated_at timestamptz, is_present boolean, review_status text, reviewed_at timestamptz, reviewer text, links jsonb)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.current_account_is_active() then raise exception 'Active account required'; end if;
  return query select r.appsuite_record_id, r.app_id, r.data_id, r.ringi_number, r.workflow_type, r.approval_status, r.property_name, r.tenant_name, r.source_updated_at, r.is_present,
    coalesce(v.status, 'unreviewed'), v.reviewed_at, coalesce(e.employee_name::text, p.email::text),
    coalesce((select jsonb_agg(x.item) from (
      select jsonb_build_object('kind','現行契約','tenant',t.tenant_name,'start',c.contract_start_date,'end',c.contract_end_date,'scope',l.target_scope,'unit',u.unit_code,'floor',u.floor_label) item
      from public.workflow_contract_link l join public.lease_contract c on c.lease_contract_id=l.lease_contract_id
      left join public.tenant_master t on t.tenant_id=c.tenant_id
      left join public.lease_contract_unit cu on cu.lease_contract_unit_id=l.lease_contract_unit_id
      left join public.unit_master u on u.unit_id=cu.unit_id where l.appsuite_record_id=r.appsuite_record_id
      union all
      select jsonb_build_object('kind','過去契約履歴','tenant',h.tenant_name,'property',h.property_name,'unit',h.unit_code,'snapshot',h.snapshot_date)
      from public.workflow_historical_contract_link h where h.appsuite_record_id=r.appsuite_record_id
    ) x), '[]'::jsonb)
  from public.appsuite_record r left join public.approval_inventory_review v using (appsuite_record_id)
  left join public.user_profiles p on p.user_id=v.reviewed_by left join public.employee_master e on e.employee_id=p.employee_id
  order by r.appsuite_record_id;
end $$;
