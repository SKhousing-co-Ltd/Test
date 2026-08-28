-- 契約形態確認・普通更新・定期満了の対応依頼を既存ワークベンチへ統合する。

alter table public.change_request drop constraint if exists ck_change_request_request_type;
alter table public.change_request add constraint ck_change_request_request_type check (
  request_type in (
    'contract_create', 'contract_update', 'contract_terminate', 'approval_cancel',
    'contract_cancellation_review', 'rent_roll_correction', 'master_data_correction',
    'parking_fee_setup', 'contract_term_type_confirmation',
    'contract_renewal_due', 'fixed_term_contract_end', 'other'
  )
);

create unique index if not exists uq_change_request_contract_deadline_once
  on public.change_request(source_type, source_record_key, request_type)
  where request_type in (
    'contract_term_type_confirmation', 'contract_renewal_due', 'fixed_term_contract_end'
  );

create or replace function private.complete_contract_deadline_request(
  p_change_request_id uuid,
  p_expected_row_version integer,
  p_resolution jsonb
)
returns public.change_request
language plpgsql
security definer
set search_path = ''
as $$
declare
  request_record public.change_request%rowtype;
begin
  update public.change_request request
  set status = 'applied',
      resolution_payload = request.resolution_payload || coalesce(p_resolution, '{}'::jsonb),
      resolved_at = now(), resolved_by = auth.uid(),
      applied_at = now(), applied_by = auth.uid()
  where request.change_request_id = p_change_request_id
    and request.row_version = p_expected_row_version
    and request.status in ('open', 'in_review', 'on_hold', 'resolved')
  returning * into request_record;
  if not found then
    raise exception '対応依頼が更新済みです。再読み込みしてください';
  end if;

  update public.change_request_item item
  set validation_status = 'valid', validation_message = null
  where item.change_request_id = p_change_request_id;

  insert into public.change_request_action_log(
    change_request_id, action_type, previous_status, next_status, details, performed_by
  ) values (
    p_change_request_id, 'applied', null, 'applied',
    coalesce(p_resolution, '{}'::jsonb), auth.uid()
  );
  return request_record;
end;
$$;

revoke all on function private.complete_contract_deadline_request(uuid, integer, jsonb)
  from public, anon, authenticated;

create or replace function private.sync_contract_deadline_change_requests_internal(
  p_as_of_date date,
  p_lease_contract_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  created_count integer := 0;
  closed_count integer := 0;
  ordinary_lead integer;
  fixed_lead integer;
  target record;
  request_id uuid;
begin
  if p_as_of_date is null then raise exception '基準日は必須です'; end if;

  select lead_days into ordinary_lead
  from public.contract_deadline_notification_setting where issue_type = 'ordinary_renewal';
  select lead_days into fixed_lead
  from public.contract_deadline_notification_setting where issue_type = 'fixed_term_end';

  -- 現在の正本と一致しなくなった期限依頼を対象外にする。
  with stale as (
    select request.change_request_id
    from public.change_request request
    left join public.lease_contract contract on contract.lease_contract_id = request.lease_contract_id
    where request.request_type in (
      'contract_term_type_confirmation', 'contract_renewal_due', 'fixed_term_contract_end'
    )
      and request.status in ('open', 'in_review', 'on_hold')
      and (p_lease_contract_id is null or request.lease_contract_id = p_lease_contract_id)
      and (
        contract.lease_contract_id is null
        or contract.actual_end_date is not null and contract.actual_end_date < p_as_of_date
        or request.request_type = 'contract_term_type_confirmation' and contract.lease_term_type is not null
        or request.request_type = 'contract_renewal_due' and (
          contract.lease_term_type is distinct from 'ordinary'
          or contract.renewal_due_date is distinct from nullif(request.source_payload ->> 'target_date', '')::date
        )
        or request.request_type = 'fixed_term_contract_end' and (
          contract.lease_term_type is distinct from 'fixed_term'
          or contract.contract_end_date is distinct from nullif(request.source_payload ->> 'target_date', '')::date
          or exists (
            select 1 from public.lease_contract successor
            where successor.renewed_from_contract_id = contract.lease_contract_id
              and successor.contract_status <> 'draft'
          )
        )
      )
  )
  update public.change_request request
  set status = 'excluded',
      resolution_payload = request.resolution_payload || jsonb_build_object(
        'reason', 'contract_deadline_current_state_changed', 'checked_at', now()
      )
  from stale where request.change_request_id = stale.change_request_id;
  get diagnostics closed_count = row_count;

  -- 法的契約形態が未確認の主契約。
  for target in
    select contract.lease_contract_id, contract.tenant_id, tenant.tenant_name,
      contract.contract_start_date, contract.row_version
    from public.lease_contract contract
    join public.tenant_master tenant on tenant.tenant_id = contract.tenant_id
    where contract.lease_term_type is null
      and contract.contract_status <> 'draft'
      and contract.contract_type is distinct from 'parking'
      and (p_lease_contract_id is null or contract.lease_contract_id = p_lease_contract_id)
      and exists (
        select 1 from public.lease_contract_unit contract_unit
        join public.unit_master unit on unit.unit_id = contract_unit.unit_id
        where contract_unit.lease_contract_id = contract.lease_contract_id
          and unit.unit_type <> 'parking'
      )
  loop
    insert into public.change_request(
      source_type, source_record_key, request_type, status, title, summary,
      source_payload, proposed_payload, lease_contract_id
    ) values (
      'manual', concat('contract-term-type:', target.lease_contract_id, ':0001-01-01'),
      'contract_term_type_confirmation', 'open',
      concat('契約形態確認: ', target.tenant_name),
      '契約書を確認し、普通賃貸借または定期賃貸借を設定してください。',
      jsonb_build_object('target_date', '0001-01-01', 'contract_start_date', target.contract_start_date),
      jsonb_build_object('expected_contract_row_version', target.row_version),
      target.lease_contract_id
    ) on conflict do nothing returning change_request_id into request_id;
    if request_id is not null then
      insert into public.change_request_item(
        change_request_id, entity_type, entity_id, field_name,
        current_value, proposed_value, validation_status, validation_message
      ) values (
        request_id, 'lease_contract', target.lease_contract_id, 'lease_term_type',
        'null'::jsonb, null, 'pending', '契約書による契約形態の確認が必要です'
      );
      created_count := created_count + 1;
    end if;
    request_id := null;
  end loop;

  -- 普通賃貸借の次回更新予定。
  for target in
    select contract.lease_contract_id, tenant.tenant_name, contract.renewal_due_date
    from public.lease_contract contract
    join public.tenant_master tenant on tenant.tenant_id = contract.tenant_id
    where contract.lease_term_type = 'ordinary'
      and contract.renewal_due_date is not null
      and contract.renewal_due_date <= p_as_of_date + ordinary_lead
      and (contract.actual_end_date is null or contract.actual_end_date >= p_as_of_date)
      and (p_lease_contract_id is null or contract.lease_contract_id = p_lease_contract_id)
  loop
    insert into public.change_request(
      source_type, source_record_key, request_type, status, title, summary,
      source_payload, proposed_payload, lease_contract_id
    ) values (
      'manual', concat('contract-renewal:', target.lease_contract_id, ':', target.renewal_due_date),
      'contract_renewal_due', 'open', concat('契約更新確認: ', target.tenant_name),
      concat('次回更新予定日 ', target.renewal_due_date, ' の確認が必要です。'),
      jsonb_build_object('target_date', target.renewal_due_date), '{}'::jsonb,
      target.lease_contract_id
    ) on conflict do nothing returning change_request_id into request_id;
    if request_id is not null then
      insert into public.change_request_item(
        change_request_id, entity_type, entity_id, field_name,
        current_value, proposed_value, validation_status, validation_message
      ) values (
        request_id, 'lease_contract', target.lease_contract_id, 'renewal_due_date',
        to_jsonb(target.renewal_due_date), null, 'pending', '次回更新予定日を設定してください'
      );
      created_count := created_count + 1;
    end if;
    request_id := null;
  end loop;

  -- 定期賃貸借の満了確認。
  for target in
    select contract.lease_contract_id, tenant.tenant_name, contract.contract_end_date
    from public.lease_contract contract
    join public.tenant_master tenant on tenant.tenant_id = contract.tenant_id
    where contract.lease_term_type = 'fixed_term'
      and contract.contract_end_date <= p_as_of_date + fixed_lead
      and (contract.actual_end_date is null or contract.actual_end_date >= p_as_of_date)
      and not exists (
        select 1 from public.lease_contract successor
        where successor.renewed_from_contract_id = contract.lease_contract_id
          and successor.contract_status <> 'draft'
      )
      and (p_lease_contract_id is null or contract.lease_contract_id = p_lease_contract_id)
  loop
    insert into public.change_request(
      source_type, source_record_key, request_type, status, title, summary,
      source_payload, proposed_payload, lease_contract_id
    ) values (
      'manual', concat('fixed-term-end:', target.lease_contract_id, ':', target.contract_end_date),
      'fixed_term_contract_end', 'open', concat('定期賃貸借契約終了確認: ', target.tenant_name),
      concat('契約終了日 ', target.contract_end_date, ' に向けて再契約または退去を確認してください。'),
      jsonb_build_object('target_date', target.contract_end_date), '{}'::jsonb,
      target.lease_contract_id
    ) on conflict do nothing returning change_request_id into request_id;
    if request_id is not null then
      insert into public.change_request_item(
        change_request_id, entity_type, entity_id, field_name,
        current_value, proposed_value, validation_status, validation_message
      ) values (
        request_id, 'lease_contract', target.lease_contract_id, 'contract_end_date',
        to_jsonb(target.contract_end_date), null, 'pending', '再契約・退去・その他確認を選択してください'
      );
      created_count := created_count + 1;
    end if;
    request_id := null;
  end loop;

  return jsonb_build_object(
    'as_of_date', p_as_of_date, 'created_count', created_count, 'closed_count', closed_count
  );
end;
$$;

revoke all on function private.sync_contract_deadline_change_requests_internal(date, uuid)
  from public, anon, authenticated;

create or replace function public.sync_contract_deadline_change_requests(
  p_as_of_date date default current_date
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null
     or not (select public.current_account_is_active())
     or (select public.current_account_role()) not in ('admin', 'manager') then
    raise exception '契約期限対応依頼の同期は管理者またはマネージャーだけが実行できます';
  end if;
  return private.sync_contract_deadline_change_requests_internal(p_as_of_date, null);
end;
$$;

revoke all on function public.sync_contract_deadline_change_requests(date)
  from public, anon;
grant execute on function public.sync_contract_deadline_change_requests(date)
  to authenticated;

create or replace function public.contract_recontract_unit_defaults(
  p_lease_contract_id uuid
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'source_lease_contract_unit_id', contract_unit.lease_contract_unit_id,
    'leased_area_sqm', contract_unit.leased_area_sqm,
    'monthly_rent_amount', coalesce(term.monthly_rent_amount, contract_unit.monthly_rent_amount),
    'monthly_common_charge_amount', coalesce(term.monthly_common_charge_amount, contract_unit.monthly_common_charge_amount),
    'deposit_amount', coalesce(term.deposit_amount, contract_unit.deposit_amount),
    'security_deposit_amount', coalesce(term.security_deposit_amount, contract_unit.security_deposit_amount),
    'key_money_amount', coalesce(term.key_money_amount, contract_unit.key_money_amount),
    'renewal_fee_amount', coalesce(term.renewal_fee_amount, contract_unit.renewal_fee_amount)
  ) order by contract_unit.created_at), '[]'::jsonb)
  from public.lease_contract contract
  join public.lease_contract_unit contract_unit
    on contract_unit.lease_contract_id = contract.lease_contract_id
  left join lateral (
    select unit_term.*
    from public.lease_contract_unit_term unit_term
    left join public.lease_contract_amendment amendment
      on amendment.lease_contract_amendment_id = unit_term.lease_contract_amendment_id
    where unit_term.lease_contract_unit_id = contract_unit.lease_contract_unit_id
      and unit_term.effective_from <= contract.contract_end_date
      and (unit_term.effective_to is null or unit_term.effective_to >= contract.contract_end_date)
      and (unit_term.lease_contract_amendment_id is null or amendment.status = 'executed')
    order by unit_term.effective_from desc, unit_term.created_at desc
    limit 1
  ) term on true
  where contract.lease_contract_id = p_lease_contract_id
    and contract.lease_term_type = 'fixed_term';
$$;

revoke all on function public.contract_recontract_unit_defaults(uuid) from public, anon;
grant execute on function public.contract_recontract_unit_defaults(uuid) to authenticated;

create or replace function public.confirm_contract_term_type(
  p_change_request_id uuid,
  p_expected_request_row_version integer,
  p_expected_contract_row_version integer,
  p_lease_term_type text,
  p_renewal_due_date date default null,
  p_contract_end_date date default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  request_record public.change_request%rowtype;
  contract_record public.lease_contract%rowtype;
begin
  if auth.uid() is null or not (select public.current_account_is_active())
     or (select public.current_account_role()) not in ('admin', 'manager') then
    raise exception '契約形態の確定は管理者またはマネージャーだけが実行できます';
  end if;
  if p_lease_term_type not in ('ordinary', 'fixed_term') then
    raise exception '契約形態を選択してください';
  end if;
  if p_lease_term_type = 'ordinary' and p_contract_end_date is not null then
    raise exception '普通賃貸借に契約終了日は設定できません';
  end if;
  if p_lease_term_type = 'fixed_term' and p_contract_end_date is null then
    raise exception '定期賃貸借の契約終了日は必須です';
  end if;
  if p_lease_term_type = 'fixed_term' and p_renewal_due_date is not null then
    raise exception '定期賃貸借に次回更新予定日は設定できません';
  end if;

  select * into request_record from public.change_request request
  where request.change_request_id = p_change_request_id
    and request.request_type = 'contract_term_type_confirmation'
    and request.row_version = p_expected_request_row_version
    and request.status in ('open', 'in_review', 'on_hold')
  for update;
  if not found then raise exception '契約形態確認依頼が更新済みです'; end if;

  update public.lease_contract contract
  set lease_term_type = p_lease_term_type,
      renewal_due_date = case when p_lease_term_type = 'ordinary' then p_renewal_due_date else null end,
      contract_end_date = case when p_lease_term_type = 'fixed_term' then p_contract_end_date else null end
  where contract.lease_contract_id = request_record.lease_contract_id
    and contract.row_version = p_expected_contract_row_version
    and contract.contract_type is distinct from 'parking'
  returning * into contract_record;
  if not found then raise exception '契約が更新済みか、主契約ではありません'; end if;

  perform private.complete_contract_deadline_request(
    p_change_request_id, p_expected_request_row_version,
    jsonb_build_object(
      'action', 'confirm_term_type', 'lease_term_type', p_lease_term_type,
      'renewal_due_date', p_renewal_due_date, 'contract_end_date', p_contract_end_date
    )
  );
  perform private.sync_contract_deadline_change_requests_internal(
    current_date, contract_record.lease_contract_id
  );
  return jsonb_build_object(
    'lease_contract_id', contract_record.lease_contract_id,
    'lease_term_type', contract_record.lease_term_type,
    'contract_row_version', contract_record.row_version
  );
end;
$$;

create or replace function public.set_next_ordinary_renewal_due_date(
  p_change_request_id uuid,
  p_expected_request_row_version integer,
  p_expected_contract_row_version integer,
  p_next_renewal_due_date date
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  request_record public.change_request%rowtype;
  contract_record public.lease_contract%rowtype;
  target_date date;
begin
  if auth.uid() is null or not (select public.current_account_is_active())
     or (select public.current_account_role()) not in ('admin', 'manager') then
    raise exception '次回更新予定日の設定は管理者またはマネージャーだけが実行できます';
  end if;
  select * into request_record from public.change_request request
  where request.change_request_id = p_change_request_id
    and request.request_type = 'contract_renewal_due'
    and request.row_version = p_expected_request_row_version
    and request.status in ('open', 'in_review', 'on_hold')
  for update;
  if not found then raise exception '契約更新確認依頼が更新済みです'; end if;
  target_date := nullif(request_record.source_payload ->> 'target_date', '')::date;
  if p_next_renewal_due_date is null or p_next_renewal_due_date <= target_date then
    raise exception '次回更新予定日は現在の更新予定日より後にしてください';
  end if;

  update public.lease_contract contract
  set renewal_due_date = p_next_renewal_due_date
  where contract.lease_contract_id = request_record.lease_contract_id
    and contract.row_version = p_expected_contract_row_version
    and contract.lease_term_type = 'ordinary'
    and contract.renewal_due_date = target_date
    and contract.actual_end_date is null
  returning * into contract_record;
  if not found then raise exception '契約が更新済みか、普通賃貸借ではありません'; end if;

  perform private.complete_contract_deadline_request(
    p_change_request_id, p_expected_request_row_version,
    jsonb_build_object(
      'action', 'set_next_renewal_due_date', 'previous_date', target_date,
      'next_date', p_next_renewal_due_date
    )
  );
  perform private.sync_contract_deadline_change_requests_internal(
    current_date, contract_record.lease_contract_id
  );
  return jsonb_build_object(
    'lease_contract_id', contract_record.lease_contract_id,
    'renewal_due_date', contract_record.renewal_due_date,
    'contract_row_version', contract_record.row_version
  );
end;
$$;

create or replace function public.resolve_fixed_term_contract_end(
  p_change_request_id uuid,
  p_expected_request_row_version integer,
  p_expected_contract_row_version integer,
  p_action text,
  p_new_contract_start_date date default null,
  p_new_contract_end_date date default null,
  p_actual_end_date date default null,
  p_units jsonb default '[]'::jsonb,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  request_record public.change_request%rowtype;
  old_contract public.lease_contract%rowtype;
  new_contract public.lease_contract%rowtype;
  unit_payload jsonb;
  source_unit public.lease_contract_unit%rowtype;
  new_unit_id uuid;
begin
  if auth.uid() is null or not (select public.current_account_is_active())
     or (select public.current_account_role()) not in ('admin', 'manager') then
    raise exception '定期賃貸借の終了処理は管理者またはマネージャーだけが実行できます';
  end if;
  if p_action not in ('recontract', 'move_out') then
    raise exception '再契約または退去を選択してください';
  end if;
  if nullif(btrim(p_reason), '') is null then raise exception '確認理由は必須です'; end if;

  select * into request_record from public.change_request request
  where request.change_request_id = p_change_request_id
    and request.request_type = 'fixed_term_contract_end'
    and request.row_version = p_expected_request_row_version
    and request.status in ('open', 'in_review', 'on_hold')
  for update;
  if not found then raise exception '定期賃貸借契約終了確認依頼が更新済みです'; end if;

  select * into old_contract from public.lease_contract contract
  where contract.lease_contract_id = request_record.lease_contract_id
    and contract.row_version = p_expected_contract_row_version
    and contract.lease_term_type = 'fixed_term'
  for update;
  if not found then raise exception '契約が更新済みか、定期賃貸借ではありません'; end if;

  if p_action = 'move_out' then
    if coalesce(p_actual_end_date, old_contract.contract_end_date) < old_contract.contract_start_date
       or coalesce(p_actual_end_date, old_contract.contract_end_date) > old_contract.contract_end_date then
      raise exception '実終了日は契約期間内で指定してください';
    end if;
    update public.lease_contract
    set actual_end_date = coalesce(p_actual_end_date, old_contract.contract_end_date),
        contract_status = case
          when coalesce(p_actual_end_date, old_contract.contract_end_date) <= current_date then 'terminated'
          else contract_status end
    where lease_contract_id = old_contract.lease_contract_id
    returning * into old_contract;
    perform private.complete_contract_deadline_request(
      p_change_request_id, p_expected_request_row_version,
      jsonb_build_object('action', 'move_out', 'actual_end_date', old_contract.actual_end_date, 'reason', btrim(p_reason))
    );
    perform private.sync_contract_deadline_change_requests_internal(current_date, old_contract.lease_contract_id);
    return jsonb_build_object('action', 'move_out', 'lease_contract_id', old_contract.lease_contract_id);
  end if;

  if p_new_contract_start_date is null or p_new_contract_end_date is null then
    raise exception '再契約の開始日と終了日は必須です';
  end if;
  if p_new_contract_start_date <= old_contract.contract_end_date then
    raise exception '再契約開始日は旧契約終了日の翌日以降にしてください';
  end if;
  if p_new_contract_end_date < p_new_contract_start_date then
    raise exception '再契約終了日は開始日以降にしてください';
  end if;
  if jsonb_typeof(coalesce(p_units, '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_units, '[]'::jsonb)) = 0 then
    raise exception '再契約する区画と契約条件を1件以上確認してください';
  end if;
  if exists (
    select 1 from public.lease_contract successor
    where successor.renewed_from_contract_id = old_contract.lease_contract_id
      and successor.contract_status <> 'draft'
  ) then raise exception 'この契約には既に再契約が登録されています'; end if;

  insert into public.lease_contract(
    tenant_id, contract_status, contract_type, lease_term_type,
    contract_start_date, contract_end_date, renewed_from_contract_id,
    renewal_terms, payment_terms, notes, source_system
  ) values (
    old_contract.tenant_id,
    case when p_new_contract_start_date > current_date then 'scheduled' else 'active' end,
    old_contract.contract_type, 'fixed_term', p_new_contract_start_date,
    p_new_contract_end_date, old_contract.lease_contract_id,
    old_contract.renewal_terms, old_contract.payment_terms,
    concat_ws(E'\n', old_contract.notes, concat('再契約確認: ', btrim(p_reason))), 'manual'
  ) returning * into new_contract;

  for unit_payload in select value from jsonb_array_elements(p_units)
  loop
    select * into source_unit from public.lease_contract_unit contract_unit
    where contract_unit.lease_contract_unit_id = nullif(unit_payload ->> 'source_lease_contract_unit_id', '')::uuid
      and contract_unit.lease_contract_id = old_contract.lease_contract_id;
    if not found then raise exception '旧契約に属さない区画が指定されています'; end if;

    insert into public.lease_contract_unit(
      lease_contract_id, unit_id, lease_start_date, lease_end_date,
      leased_area_sqm, monthly_rent_amount, monthly_common_charge_amount,
      deposit_amount, security_deposit_amount, key_money_amount, renewal_fee_amount
    ) values (
      new_contract.lease_contract_id, source_unit.unit_id,
      coalesce(nullif(unit_payload ->> 'lease_start_date', '')::date, p_new_contract_start_date),
      coalesce(nullif(unit_payload ->> 'lease_end_date', '')::date, p_new_contract_end_date),
      coalesce(nullif(unit_payload ->> 'leased_area_sqm', '')::numeric, source_unit.leased_area_sqm),
      coalesce(nullif(unit_payload ->> 'monthly_rent_amount', '')::numeric, source_unit.monthly_rent_amount),
      coalesce(nullif(unit_payload ->> 'monthly_common_charge_amount', '')::numeric, source_unit.monthly_common_charge_amount),
      coalesce(nullif(unit_payload ->> 'deposit_amount', '')::numeric, source_unit.deposit_amount),
      coalesce(nullif(unit_payload ->> 'security_deposit_amount', '')::numeric, source_unit.security_deposit_amount),
      coalesce(nullif(unit_payload ->> 'key_money_amount', '')::numeric, source_unit.key_money_amount),
      coalesce(nullif(unit_payload ->> 'renewal_fee_amount', '')::numeric, source_unit.renewal_fee_amount)
    ) returning lease_contract_unit_id into new_unit_id;

    insert into public.lease_contract_unit_term(
      lease_contract_unit_id, effective_from, effective_to,
      monthly_rent_amount, monthly_common_charge_amount, deposit_amount,
      security_deposit_amount, key_money_amount, renewal_fee_amount
    ) select
      new_unit_id, p_new_contract_start_date, p_new_contract_end_date,
      contract_unit.monthly_rent_amount, contract_unit.monthly_common_charge_amount,
      contract_unit.deposit_amount, contract_unit.security_deposit_amount,
      contract_unit.key_money_amount, contract_unit.renewal_fee_amount
    from public.lease_contract_unit contract_unit
    where contract_unit.lease_contract_unit_id = new_unit_id;
  end loop;

  perform private.complete_contract_deadline_request(
    p_change_request_id, p_expected_request_row_version,
    jsonb_build_object(
      'action', 'recontract', 'new_lease_contract_id', new_contract.lease_contract_id,
      'contract_start_date', p_new_contract_start_date,
      'contract_end_date', p_new_contract_end_date, 'reason', btrim(p_reason)
    )
  );
  perform private.sync_contract_deadline_change_requests_internal(current_date, old_contract.lease_contract_id);
  return jsonb_build_object(
    'action', 'recontract', 'old_lease_contract_id', old_contract.lease_contract_id,
    'new_lease_contract_id', new_contract.lease_contract_id
  );
end;
$$;

revoke all on function public.confirm_contract_term_type(uuid, integer, integer, text, date, date)
  from public, anon;
revoke all on function public.set_next_ordinary_renewal_due_date(uuid, integer, integer, date)
  from public, anon;
revoke all on function public.resolve_fixed_term_contract_end(uuid, integer, integer, text, date, date, date, jsonb, text)
  from public, anon;
grant execute on function public.confirm_contract_term_type(uuid, integer, integer, text, date, date)
  to authenticated;
grant execute on function public.set_next_ordinary_renewal_due_date(uuid, integer, integer, date)
  to authenticated;
grant execute on function public.resolve_fixed_term_contract_end(uuid, integer, integer, text, date, date, date, jsonb, text)
  to authenticated;

create or replace function public.apply_rent_roll_contract_edit_with_terms(
  p_lease_contract_unit_id uuid,
  p_expected_contract_row_version integer,
  p_expected_contract_unit_row_version integer,
  p_contract_changes jsonb,
  p_contract_unit_changes jsonb,
  p_term_changes jsonb,
  p_reason text,
  p_as_of_date date default current_date
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  base_changed boolean;
  term_changed boolean;
  safe_contract_changes jsonb;
  contract_record public.lease_contract%rowtype;
  request_id uuid;
  field_name text;
  before_value jsonb;
  after_value jsonb;
  next_term_type text;
  next_renewal_due date;
  next_actual_end date;
  next_contract_end date;
begin
  if auth.uid() is null or not (select public.current_account_is_active())
     or (select public.current_account_role()) not in ('admin', 'manager') then
    raise exception '契約編集は管理者またはマネージャーだけが実行できます';
  end if;
  if nullif(btrim(p_reason), '') is null then raise exception '変更理由を入力してください'; end if;
  if jsonb_typeof(coalesce(p_term_changes, '{}'::jsonb)) <> 'object' then
    raise exception '契約期限変更はJSONオブジェクトで指定してください';
  end if;
  for field_name in select jsonb_object_keys(coalesce(p_term_changes, '{}'::jsonb))
  loop
    if field_name not in ('lease_term_type', 'renewal_due_date', 'actual_end_date') then
      raise exception '変更できない契約期限項目です: %', field_name;
    end if;
  end loop;

  safe_contract_changes := coalesce(p_contract_changes, '{}'::jsonb) - 'contract_end_date';
  base_changed := safe_contract_changes <> '{}'::jsonb
    or coalesce(p_contract_unit_changes, '{}'::jsonb) <> '{}'::jsonb;
  term_changed := coalesce(p_term_changes, '{}'::jsonb) <> '{}'::jsonb
    or coalesce(p_contract_changes, '{}'::jsonb) ? 'contract_end_date';
  if not base_changed and not term_changed then raise exception '変更された項目がありません'; end if;

  if base_changed then
    perform public.apply_rent_roll_contract_edit(
      p_lease_contract_unit_id, p_expected_contract_row_version,
      p_expected_contract_unit_row_version, safe_contract_changes,
      coalesce(p_contract_unit_changes, '{}'::jsonb), btrim(p_reason), p_as_of_date
    );
    select contract.* into contract_record
    from public.lease_contract_unit contract_unit
    join public.lease_contract contract on contract.lease_contract_id = contract_unit.lease_contract_id
    where contract_unit.lease_contract_unit_id = p_lease_contract_unit_id
      and contract.contract_type is distinct from 'parking'
    for update of contract;
  else
    select contract.* into contract_record
    from public.lease_contract_unit contract_unit
    join public.lease_contract contract on contract.lease_contract_id = contract_unit.lease_contract_id
    where contract_unit.lease_contract_unit_id = p_lease_contract_unit_id
      and contract.row_version = p_expected_contract_row_version
      and contract.contract_type is distinct from 'parking'
    for update of contract;
  end if;
  if not found then raise exception '契約が更新済みか、主契約ではありません'; end if;

  if term_changed then
    next_term_type := case when p_term_changes ? 'lease_term_type'
      then nullif(p_term_changes ->> 'lease_term_type', '') else contract_record.lease_term_type end;
    next_renewal_due := case when p_term_changes ? 'renewal_due_date'
      then nullif(p_term_changes ->> 'renewal_due_date', '')::date else contract_record.renewal_due_date end;
    next_actual_end := case when p_term_changes ? 'actual_end_date'
      then nullif(p_term_changes ->> 'actual_end_date', '')::date else contract_record.actual_end_date end;
    next_contract_end := case when coalesce(p_contract_changes, '{}'::jsonb) ? 'contract_end_date'
      then nullif(p_contract_changes ->> 'contract_end_date', '')::date else contract_record.contract_end_date end;

    if next_term_type not in ('ordinary', 'fixed_term') then
      raise exception '契約形態を選択してください';
    end if;
    if next_term_type = 'ordinary' and next_contract_end is not null then
      raise exception '普通賃貸借に契約終了日は設定できません';
    end if;
    if next_term_type = 'fixed_term' and next_contract_end is null then
      raise exception '定期賃貸借の契約終了日は必須です';
    end if;
    if next_term_type = 'fixed_term' and next_renewal_due is not null then
      raise exception '定期賃貸借に次回更新予定日は設定できません';
    end if;

    insert into public.change_request(
      source_type, source_record_key, request_type, status, title, summary,
      source_payload, proposed_payload, resolution_payload, lease_contract_id,
      resolved_at, resolved_by, applied_at, applied_by
    ) values (
      'manual', concat('rent-roll-term-edit:', p_lease_contract_unit_id, ':', gen_random_uuid()),
      'contract_update', 'applied', 'レントロール契約期限修正', btrim(p_reason),
      jsonb_build_object('origin', 'rent_roll_contract_modal', 'as_of_date', p_as_of_date),
      jsonb_build_object('term_changes', p_term_changes),
      jsonb_build_object('reason', btrim(p_reason)), contract_record.lease_contract_id,
      now(), auth.uid(), now(), auth.uid()
    ) returning change_request_id into request_id;

    for field_name in select jsonb_object_keys(p_term_changes)
    loop
      before_value := to_jsonb(contract_record) -> field_name;
      after_value := p_term_changes -> field_name;
      insert into public.change_request_item(
        change_request_id, entity_type, entity_id, field_name,
        current_value, proposed_value, validation_status, validation_message
      ) values (
        request_id, 'lease_contract', contract_record.lease_contract_id, field_name,
        before_value, after_value, 'valid', 'レントロール画面で変更前後を確認済み'
      );
    end loop;
    if coalesce(p_contract_changes, '{}'::jsonb) ? 'contract_end_date' then
      insert into public.change_request_item(
        change_request_id, entity_type, entity_id, field_name,
        current_value, proposed_value, validation_status, validation_message
      ) values (
        request_id, 'lease_contract', contract_record.lease_contract_id, 'contract_end_date',
        to_jsonb(contract_record.contract_end_date), p_contract_changes -> 'contract_end_date',
        'valid', 'レントロール画面で変更前後を確認済み'
      );
    end if;

    update public.lease_contract
    set lease_term_type = next_term_type,
        renewal_due_date = case when next_term_type = 'ordinary' then next_renewal_due else null end,
        contract_end_date = next_contract_end,
        actual_end_date = next_actual_end
    where lease_contract_id = contract_record.lease_contract_id
    returning * into contract_record;
  end if;

  return jsonb_build_object(
    'change_request_id', request_id,
    'status', 'applied',
    'detail', public.contract_term_detail_for_audit(p_lease_contract_unit_id, p_as_of_date)
  );
end;
$$;

revoke all on function public.apply_rent_roll_contract_edit_with_terms(uuid, integer, integer, jsonb, jsonb, jsonb, text, date)
  from public, anon;
grant execute on function public.apply_rent_roll_contract_edit_with_terms(uuid, integer, integer, jsonb, jsonb, jsonb, text, date)
  to authenticated;

create or replace function public.recheck_open_change_requests()
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  target record;
  result jsonb;
  checked_count integer := 0;
  applied_count integer := 0;
  open_count integer := 0;
  skipped_count integer := 0;
begin
  if auth.uid() is null or not (select public.current_account_is_active()) then
    raise exception '有効なアカウントが必要です';
  end if;
  for target in
    select request.change_request_id, request.row_version
    from public.change_request request
    where request.status in ('open', 'in_review', 'on_hold')
      and request.request_type not in (
        'contract_term_type_confirmation', 'contract_renewal_due', 'fixed_term_contract_end'
      )
    order by request.updated_at desc, request.change_request_id
  loop
    result := private.recheck_change_request_internal(
      target.change_request_id, target.row_version
    );
    checked_count := checked_count + 1;
    case result ->> 'outcome'
      when 'applied' then applied_count := applied_count + 1;
      when 'open' then open_count := open_count + 1;
      else skipped_count := skipped_count + 1;
    end case;
  end loop;
  return jsonb_build_object(
    'checked_count', checked_count, 'applied_count', applied_count,
    'open_count', open_count, 'skipped_count', skipped_count
  );
end;
$$;

revoke all on function public.recheck_open_change_requests() from public, anon;
grant execute on function public.recheck_open_change_requests() to authenticated;

create or replace function public.contract_term_migration_preflight()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare result jsonb;
begin
  if auth.uid() is null or not (select public.current_account_is_active())
     or (select public.current_account_role()) not in ('admin', 'manager') then
    raise exception '契約移行監査は管理者またはマネージャーだけが実行できます';
  end if;
  select jsonb_build_object(
    'contracts', (select count(*) from public.lease_contract),
    'tenants_with_contracts', (select count(distinct tenant_id) from public.lease_contract),
    'tenants_with_multiple_contracts', (
      select count(*) from (
        select tenant_id from public.lease_contract group by tenant_id having count(*) > 1
      ) multiple_contracts
    ),
    'unclassified_main_contracts', (
      select count(distinct contract.lease_contract_id)
      from public.lease_contract contract
      join public.lease_contract_unit contract_unit using (lease_contract_id)
      join public.unit_master unit using (unit_id)
      where contract.lease_term_type is null and unit.unit_type <> 'parking'
    ),
    'contract_categories', (
      select coalesce(jsonb_object_agg(category, total), '{}'::jsonb)
      from (
        select coalesce(contract_type, '<NULL>') category, count(*) total
        from public.lease_contract group by contract_type
      ) categories
    ),
    'contract_statuses', (
      select coalesce(jsonb_object_agg(contract_status, total), '{}'::jsonb)
      from (
        select contract_status, count(*) total
        from public.lease_contract group by contract_status
      ) statuses
    ),
    'billing_codes', (select count(*) from public.tenant_billing_code),
    'billing_tenants', (select count(distinct tenant_id) from public.tenant_billing_code)
  ) into result;
  return result;
end;
$$;

revoke all on function public.contract_term_migration_preflight() from public, anon;
grant execute on function public.contract_term_migration_preflight() to authenticated;

create or replace function private.sync_contract_deadline_requests_after_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.sync_contract_deadline_change_requests_internal(
    current_date, new.lease_contract_id
  );
  return new;
end;
$$;

revoke all on function private.sync_contract_deadline_requests_after_write()
  from public, anon, authenticated;

drop trigger if exists sync_contract_deadline_requests_after_write on public.lease_contract;
create constraint trigger sync_contract_deadline_requests_after_write
after insert or update of lease_term_type, renewal_due_date, contract_end_date,
  actual_end_date, contract_status, renewed_from_contract_id
on public.lease_contract
deferrable initially deferred
for each row execute function private.sync_contract_deadline_requests_after_write();

create extension if not exists pg_cron with schema pg_catalog;
do $$
declare existing_job_id bigint;
begin
  select jobid into existing_job_id from cron.job
  where jobname = 'contract-deadline-daily-sync';
  if existing_job_id is null then
    perform cron.schedule(
      'contract-deadline-daily-sync', '15 17 * * *',
      'select private.sync_contract_deadline_change_requests_internal(current_date, null);'
    );
  else
    perform cron.alter_job(
      job_id := existing_job_id,
      schedule := '15 17 * * *',
      command := 'select private.sync_contract_deadline_change_requests_internal(current_date, null);',
      active := true
    );
  end if;
end;
$$;

-- 初回デプロイ時にも未分類・期限接近案件を一度同期する。
select private.sync_contract_deadline_change_requests_internal(current_date, null);

comment on function public.sync_contract_deadline_change_requests(date)
  is '契約形態未確認・普通更新・定期満了の対応依頼を基準日時点で冪等同期する。';
comment on function public.confirm_contract_term_type(uuid, integer, integer, text, date, date)
  is '未分類の主契約を契約書確認後に普通または定期へ分類する。';
comment on function public.set_next_ordinary_renewal_due_date(uuid, integer, integer, date)
  is '普通賃貸借を終了させず、次回更新予定日だけを更新する。';
comment on function public.resolve_fixed_term_contract_end(uuid, integer, integer, text, date, date, date, jsonb, text)
  is '定期賃貸借の再契約を新規契約として作成するか、退去実終了日を確定する。';
