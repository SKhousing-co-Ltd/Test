-- 契約形態確認依頼を、原則「普通賃貸借」として一括確定する。
-- 定期賃貸借への変更は、契約書確認後に既存の契約期限変更処理で行う。

create or replace function public.bulk_confirm_ordinary_lease_terms(
  p_limit integer default 1000,
  p_reason text default '既存契約は原則として普通賃貸借として登録'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target record;
  contract_record public.lease_contract%rowtype;
  previous_status varchar(20);
  applied_count integer := 0;
  skipped_count integer := 0;
  max_count integer := greatest(coalesce(p_limit, 1000), 1);
begin
  if not public.current_account_is_active()
     or public.current_account_role() not in ('admin', 'manager') then
    raise exception '契約形態の一括確定は管理者またはマネージャーだけが実行できます';
  end if;
  if nullif(btrim(p_reason), '') is null then
    raise exception '一括確定の理由を入力してください';
  end if;

  for target in
    select distinct on (request.change_request_id)
      request.change_request_id,
      request.row_version,
      request.status,
      request.title,
      item.entity_id as lease_contract_id
    from public.change_request request
    join public.change_request_item item
      on item.change_request_id = request.change_request_id
     and item.entity_type = 'lease_contract'
     and item.field_name = 'lease_term_type'
    where request.request_type = 'contract_term_type_confirmation'
      and request.status in ('open', 'in_review', 'on_hold')
      and item.entity_id is not null
    order by request.change_request_id, item.created_at
    limit max_count
  loop
    previous_status := target.status;
    select * into contract_record
    from public.lease_contract
    where lease_contract_id = target.lease_contract_id
    for update;

    if not found or contract_record.lease_term_type is not null
       or contract_record.contract_end_date is not null then
      skipped_count := skipped_count + 1;
      continue;
    end if;

    update public.lease_contract
       set lease_term_type = 'ordinary',
           renewal_due_date = null
     where lease_contract_id = contract_record.lease_contract_id;

    update public.change_request_item
       set proposed_value = '"ordinary"'::jsonb,
           validation_status = 'valid',
           validation_message = '一括確定: 普通賃貸借'
     where change_request_id = target.change_request_id
       and entity_type = 'lease_contract'
       and field_name = 'lease_term_type';

    update public.change_request
       set status = 'applied',
           resolution_payload = jsonb_build_object('reason', btrim(p_reason), 'lease_term_type', 'ordinary'),
           resolved_at = coalesce(resolved_at, now()),
           resolved_by = coalesce(resolved_by, auth.uid()),
           applied_at = now(),
           applied_by = auth.uid()
     where change_request_id = target.change_request_id;

    insert into public.change_request_action_log(
      change_request_id, action_type, previous_status, next_status, details, performed_by
    ) values (
      target.change_request_id, 'applied', previous_status, 'applied',
      jsonb_build_object(
        'reason', btrim(p_reason),
        'lease_contract_id', contract_record.lease_contract_id,
        'lease_term_type', 'ordinary',
        'bulk_operation', true
      ), auth.uid()
    );
    applied_count := applied_count + 1;
  end loop;

  return jsonb_build_object(
    'applied_count', applied_count,
    'skipped_count', skipped_count,
    'remaining_count', (
      select count(*)
      from public.change_request
      where request_type = 'contract_term_type_confirmation'
        and status in ('open', 'in_review', 'on_hold')
    )
  );
end;
$$;

revoke all on function public.bulk_confirm_ordinary_lease_terms(integer, text)
  from public, anon, authenticated;
grant execute on function public.bulk_confirm_ordinary_lease_terms(integer, text)
  to authenticated;
