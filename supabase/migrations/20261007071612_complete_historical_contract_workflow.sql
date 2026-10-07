create or replace function public.complete_historical_contract_workflow(
  p_change_request_id uuid,
  p_expected_row_version integer,
  p_historical_contract_key text
) returns public.change_request
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.change_request;
  v_previous_status varchar(20);
begin
  if not public.current_account_is_active() or public.current_account_role() not in ('admin', 'manager', 'staff') then
    raise exception 'Active operator account required';
  end if;
  select * into v_request
  from public.change_request
  where change_request_id = p_change_request_id
    and row_version = p_expected_row_version
    and status in ('open', 'in_review', 'on_hold', 'resolved')
  for update;
  if not found then raise exception '対応依頼が処理可能な状態ではありません'; end if;
  if v_request.source_appsuite_record_id is null then raise exception 'AppSuite対応依頼ではありません'; end if;
  if not exists (
    select 1 from public.workflow_historical_contract_link link
    where link.appsuite_record_id = v_request.source_appsuite_record_id
      and link.historical_contract_key = p_historical_contract_key
  ) then raise exception '過去契約への紐付けが確認できません'; end if;
  v_previous_status := v_request.status;
  update public.change_request
     set status = 'applied', applied_at = now(), applied_by = auth.uid(), resolved_at = coalesce(resolved_at, now()), resolved_by = coalesce(resolved_by, auth.uid())
   where change_request_id = p_change_request_id
   returning * into v_request;
  insert into public.change_request_action_log(change_request_id, action_type, previous_status, next_status, details, performed_by)
  values (p_change_request_id, 'cancellation_confirmed', v_previous_status, 'applied', jsonb_build_object('mode', 'historical_contract_link', 'historical_contract_key', p_historical_contract_key, 'current_data_changed', false), auth.uid());
  return v_request;
end;
$$;

revoke all on function public.complete_historical_contract_workflow(uuid, integer, text) from public, anon;
grant execute on function public.complete_historical_contract_workflow(uuid, integer, text) to authenticated;
