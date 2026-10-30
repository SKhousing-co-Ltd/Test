create table public.lease_contract_unit_rent_change_log (
  lease_contract_unit_rent_change_log_id uuid primary key default gen_random_uuid(),
  lease_contract_unit_id uuid not null references public.lease_contract_unit(lease_contract_unit_id) on delete restrict,
  change_request_id uuid not null references public.change_request(change_request_id) on delete restrict,
  effective_from date not null,
  change_action text not null check (change_action in ('scheduled', 'revised', 'cancelled')),
  before_values jsonb,
  after_values jsonb,
  reason text not null,
  changed_by uuid references auth.users(id) on delete set null default auth.uid(),
  changed_at timestamptz not null default now(),
  constraint ck_lease_contract_unit_rent_change_values check (
    (before_values is null or jsonb_typeof(before_values) = 'object')
    and (after_values is null or jsonb_typeof(after_values) = 'object')
  )
);

create index ix_lease_contract_unit_rent_change_log_unit_date
  on public.lease_contract_unit_rent_change_log(lease_contract_unit_id, effective_from desc, changed_at desc);

alter table public.lease_contract_unit_rent_change_log enable row level security;
revoke all on public.lease_contract_unit_rent_change_log from public, anon;
grant select on public.lease_contract_unit_rent_change_log to authenticated;
create policy "active users read lease contract rent change log"
  on public.lease_contract_unit_rent_change_log for select to authenticated
  using (public.current_account_is_active());

create or replace function public.apply_contract_unit_rent_schedule(
  p_lease_contract_unit_id uuid,
  p_expected_row_version integer,
  p_changes jsonb,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_contract_unit public.lease_contract_unit%rowtype;
  v_contract public.lease_contract%rowtype;
  v_tenant_name text;
  v_property_name text;
  v_unit_label text;
  v_change jsonb;
  v_action text;
  v_effective_from date;
  v_rent numeric(14, 0);
  v_common_charge numeric(14, 0);
  v_term public.lease_contract_unit_term%rowtype;
  v_previous public.lease_contract_unit_term%rowtype;
  v_next_effective_from date;
  v_anchor_date date;
  v_has_terms boolean;
  v_before_values jsonb;
  v_before_schedule jsonb;
  v_after_schedule jsonb;
  v_active_rent numeric(14, 0);
  v_active_common_charge numeric(14, 0);
  v_change_request_id uuid;
  v_change_log_action text;
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
begin
  if auth.uid() is null or not (select public.current_account_is_active())
     or (select public.current_account_role()) not in ('admin', 'manager') then
    raise exception '賃料履歴の編集は管理者またはマネージャーだけが実行できます';
  end if;
  if nullif(btrim(p_reason), '') is null then
    raise exception '変更理由を入力してください';
  end if;
  if jsonb_typeof(p_changes) is distinct from 'array' or jsonb_array_length(p_changes) = 0 then
    raise exception '賃料変更を1件以上入力してください';
  end if;

  select contract_unit.* into v_contract_unit
    from public.lease_contract_unit contract_unit
    join public.unit_master unit on unit.unit_id = contract_unit.unit_id
   where contract_unit.lease_contract_unit_id = p_lease_contract_unit_id
     and unit.unit_type <> 'parking'
   for update of contract_unit;
  if not found then raise exception '対象の契約区画が見つかりません'; end if;
  if v_contract_unit.row_version <> p_expected_row_version then
    raise exception '契約区画が別の操作で更新されました。再読み込みしてください';
  end if;
  select contract.* into v_contract
    from public.lease_contract contract
   where contract.lease_contract_id = v_contract_unit.lease_contract_id
   for update;
  if not found then raise exception '対象の契約が見つかりません'; end if;
  select tenant.tenant_name, asset.asset_name,
         concat_ws(' ', unit.floor_label, coalesce(unit.unit_name, unit.unit_code))
    into v_tenant_name, v_property_name, v_unit_label
    from public.tenant_master tenant
    join public.unit_master unit on unit.unit_id = v_contract_unit.unit_id
    join public.asset_master asset on asset.asset_id = unit.property_id
   where tenant.tenant_id = v_contract.tenant_id;

  if exists (
    select 1 from (
      select value ->> 'effective_from' as effective_from, count(*) as row_count
        from jsonb_array_elements(p_changes)
       group by value ->> 'effective_from'
    ) duplicate_dates where row_count > 1
  ) then raise exception '同じ適用開始日を複数回指定できません'; end if;

  for v_change in select value from jsonb_array_elements(p_changes)
  loop
    v_action := v_change ->> 'action';
    if v_action is null or v_action not in ('upsert', 'remove') then raise exception '賃料変更操作が不正です'; end if;
    if nullif(v_change ->> 'effective_from', '') is null then raise exception '適用開始日を入力してください'; end if;
    v_effective_from := (v_change ->> 'effective_from')::date;
    if v_effective_from < coalesce(v_contract_unit.lease_start_date, v_contract.contract_start_date, v_effective_from)
       or v_effective_from > coalesce(v_contract_unit.lease_end_date, v_contract.contract_end_date, 'infinity'::date) then
      raise exception '適用開始日は契約区画の利用期間内に設定してください';
    end if;
    if v_action = 'upsert' then
      if nullif(v_change ->> 'monthly_rent_amount', '') is null then raise exception '月額賃料を入力してください'; end if;
      v_rent := (v_change ->> 'monthly_rent_amount')::numeric;
      v_common_charge := nullif(v_change ->> 'monthly_common_charge_amount', '')::numeric;
      if v_rent < 0 or (v_common_charge is not null and v_common_charge < 0) then
        raise exception '賃料と共益費は0以上で入力してください';
      end if;
    elsif v_effective_from <= v_today then
      raise exception '適用済みの賃料履歴は取消できません。金額を修正してください';
    end if;
  end loop;

  select coalesce(jsonb_agg(to_jsonb(term) order by term.effective_from), '[]'::jsonb)
    into v_before_schedule
    from public.lease_contract_unit_term term
   where term.lease_contract_unit_id = p_lease_contract_unit_id;

  insert into public.change_request (
    source_type, source_record_key, request_type, status, title, summary,
    source_payload, proposed_payload, resolution_payload, lease_contract_id,
    resolved_at, resolved_by, applied_at, applied_by
  ) values (
    'manual', concat('rent-schedule:', p_lease_contract_unit_id, ':', gen_random_uuid()),
    'contract_update', 'applied',
    concat('賃料履歴の修正: ', v_property_name, ' ', v_unit_label),
    concat(v_tenant_name, '｜', btrim(p_reason)),
    jsonb_build_object('origin', 'contract_rent_schedule_editor', 'lease_contract_unit_id', p_lease_contract_unit_id),
    jsonb_build_object('rent_schedule_changes', p_changes, 'before_schedule', v_before_schedule),
    jsonb_build_object('reason', btrim(p_reason)), v_contract.lease_contract_id,
    now(), auth.uid(), now(), auth.uid()
  ) returning change_request_id into v_change_request_id;

  for v_change in
    select value from jsonb_array_elements(p_changes)
     where value ->> 'action' = 'remove'
     order by (value ->> 'effective_from')::date desc
  loop
    v_effective_from := (v_change ->> 'effective_from')::date;
    select term.* into v_term
      from public.lease_contract_unit_term term
     where term.lease_contract_unit_id = p_lease_contract_unit_id
       and term.effective_from = v_effective_from
     for update;
    if not found then raise exception '取消対象の将来賃料が見つかりません'; end if;
    if v_term.lease_contract_amendment_id is not null then
      raise exception '覚書に紐づく賃料条件は、覚書側の手続きで変更してください';
    end if;
    select term.* into v_previous
      from public.lease_contract_unit_term term
     where term.lease_contract_unit_id = p_lease_contract_unit_id
       and term.effective_from < v_effective_from
     order by term.effective_from desc limit 1
     for update;
    if not found then raise exception '最初の賃料条件は取消できません'; end if;
    select term.effective_from into v_next_effective_from
      from public.lease_contract_unit_term term
     where term.lease_contract_unit_id = p_lease_contract_unit_id
       and term.effective_from > v_effective_from
     order by term.effective_from limit 1;
    v_before_values := jsonb_build_object(
      'monthly_rent_amount', v_term.monthly_rent_amount,
      'monthly_common_charge_amount', v_term.monthly_common_charge_amount
    );
    update public.lease_contract_unit_term
       set effective_to = case when v_next_effective_from is null then null else v_next_effective_from - 1 end,
           updated_at = now()
     where lease_contract_unit_term_id = v_previous.lease_contract_unit_term_id;
    delete from public.lease_contract_unit_term where lease_contract_unit_term_id = v_term.lease_contract_unit_term_id;
    insert into public.lease_contract_unit_rent_change_log (
      lease_contract_unit_id, change_request_id, effective_from, change_action,
      before_values, after_values, reason, changed_by
    ) values (
      p_lease_contract_unit_id, v_change_request_id, v_effective_from, 'cancelled',
      v_before_values, null, btrim(p_reason), auth.uid()
    );
  end loop;

  for v_change in
    select value from jsonb_array_elements(p_changes)
     where value ->> 'action' = 'upsert'
     order by (value ->> 'effective_from')::date
  loop
    v_effective_from := (v_change ->> 'effective_from')::date;
    v_rent := (v_change ->> 'monthly_rent_amount')::numeric;
    v_common_charge := nullif(v_change ->> 'monthly_common_charge_amount', '')::numeric;
    select term.* into v_term
      from public.lease_contract_unit_term term
     where term.lease_contract_unit_id = p_lease_contract_unit_id
       and term.effective_from <= v_effective_from
       and (term.effective_to is null or term.effective_to >= v_effective_from)
     order by term.effective_from desc limit 1
     for update;
    if found then
      v_before_values := jsonb_build_object(
        'monthly_rent_amount', v_term.monthly_rent_amount,
        'monthly_common_charge_amount', v_term.monthly_common_charge_amount
      );
      if v_term.effective_from = v_effective_from then
        update public.lease_contract_unit_term
           set monthly_rent_amount = v_rent,
               monthly_common_charge_amount = v_common_charge,
               updated_at = now()
         where lease_contract_unit_term_id = v_term.lease_contract_unit_term_id;
        v_change_log_action := 'revised';
      else
        update public.lease_contract_unit_term
           set effective_to = v_effective_from - 1, updated_at = now()
         where lease_contract_unit_term_id = v_term.lease_contract_unit_term_id;
        insert into public.lease_contract_unit_term (
          lease_contract_unit_id, lease_contract_amendment_id, effective_from, effective_to,
          monthly_rent_amount, monthly_common_charge_amount, deposit_amount,
          security_deposit_amount, key_money_amount, renewal_fee_amount
        ) values (
          p_lease_contract_unit_id, null, v_effective_from, v_term.effective_to,
          v_rent, v_common_charge, v_term.deposit_amount,
          v_term.security_deposit_amount, v_term.key_money_amount, v_term.renewal_fee_amount
        );
        v_change_log_action := 'scheduled';
      end if;
    else
      select exists (
        select 1 from public.lease_contract_unit_term term
         where term.lease_contract_unit_id = p_lease_contract_unit_id
      ) into v_has_terms;
      if v_has_terms then raise exception '適用開始日を含む賃料期間がありません'; end if;
      v_anchor_date := coalesce(v_contract_unit.lease_start_date, v_contract.contract_start_date, v_effective_from);
      if v_effective_from > v_anchor_date then
        insert into public.lease_contract_unit_term (
          lease_contract_unit_id, effective_from, effective_to, monthly_rent_amount,
          monthly_common_charge_amount, deposit_amount, security_deposit_amount,
          key_money_amount, renewal_fee_amount
        ) values (
          p_lease_contract_unit_id, v_anchor_date, v_effective_from - 1,
          v_contract_unit.monthly_rent_amount, v_contract_unit.monthly_common_charge_amount,
          v_contract_unit.deposit_amount, v_contract_unit.security_deposit_amount,
          v_contract_unit.key_money_amount, v_contract_unit.renewal_fee_amount
        );
        v_before_values := jsonb_build_object(
          'monthly_rent_amount', v_contract_unit.monthly_rent_amount,
          'monthly_common_charge_amount', v_contract_unit.monthly_common_charge_amount
        );
      else
        v_before_values := null;
      end if;
      insert into public.lease_contract_unit_term (
        lease_contract_unit_id, effective_from, monthly_rent_amount,
        monthly_common_charge_amount, deposit_amount, security_deposit_amount,
        key_money_amount, renewal_fee_amount
      ) values (
        p_lease_contract_unit_id, v_effective_from, v_rent, v_common_charge,
        v_contract_unit.deposit_amount, v_contract_unit.security_deposit_amount,
        v_contract_unit.key_money_amount, v_contract_unit.renewal_fee_amount
      );
      v_change_log_action := 'scheduled';
    end if;
    insert into public.lease_contract_unit_rent_change_log (
      lease_contract_unit_id, change_request_id, effective_from, change_action,
      before_values, after_values, reason, changed_by
    ) values (
      p_lease_contract_unit_id, v_change_request_id, v_effective_from, v_change_log_action,
      v_before_values,
      jsonb_build_object('monthly_rent_amount', v_rent, 'monthly_common_charge_amount', v_common_charge),
      btrim(p_reason), auth.uid()
    );
  end loop;

  select term.monthly_rent_amount, term.monthly_common_charge_amount
    into v_active_rent, v_active_common_charge
    from public.lease_contract_unit_term term
   where term.lease_contract_unit_id = p_lease_contract_unit_id
     and term.effective_from <= v_today
     and (term.effective_to is null or term.effective_to >= v_today)
   order by term.effective_from desc limit 1;
  if found then
    update public.lease_contract_unit
       set monthly_rent_amount = v_active_rent,
           monthly_common_charge_amount = v_active_common_charge,
           updated_at = now()
     where lease_contract_unit_id = p_lease_contract_unit_id
       and (monthly_rent_amount is distinct from v_active_rent
         or monthly_common_charge_amount is distinct from v_active_common_charge);
  end if;

  select coalesce(jsonb_agg(to_jsonb(term) order by term.effective_from), '[]'::jsonb)
    into v_after_schedule
    from public.lease_contract_unit_term term
   where term.lease_contract_unit_id = p_lease_contract_unit_id;
  update public.change_request
     set proposed_payload = jsonb_build_object(
       'rent_schedule_changes', p_changes,
       'before_schedule', v_before_schedule,
       'after_schedule', v_after_schedule
     ),
         updated_by = auth.uid(), updated_at = now()
   where change_request_id = v_change_request_id;
  insert into public.change_request_item (
    change_request_id, entity_type, entity_id, field_name,
    current_value, proposed_value, validation_status, validation_message
  ) values (
    v_change_request_id, 'lease_contract_unit', p_lease_contract_unit_id, 'rent_schedule',
    v_before_schedule, v_after_schedule, 'valid', '適用開始日ごとの賃料条件を保存しました'
  );
  insert into public.change_request_action_log (
    change_request_id, action_type, previous_status, next_status, details, performed_by
  ) values (
    v_change_request_id, 'applied', null, 'applied',
    jsonb_build_object('reason', btrim(p_reason), 'change_count', jsonb_array_length(p_changes)), auth.uid()
  );
  return jsonb_build_object(
    'change_request_id', v_change_request_id,
    'rent_schedule', v_after_schedule
  );
end;
$$;

revoke all on function public.apply_contract_unit_rent_schedule(uuid, integer, jsonb, text) from public, anon;
grant execute on function public.apply_contract_unit_rent_schedule(uuid, integer, jsonb, text) to authenticated;

comment on table public.lease_contract_unit_rent_change_log is
  '適用日付き賃料・共益費変更の監査履歴。変更理由と変更前後の金額を保持する。';
comment on function public.apply_contract_unit_rent_schedule(uuid, integer, jsonb, text) is
  '契約区画の賃料・共益費の適用日別スケジュールを追加・修正し、適用前の予定を取消する。';
