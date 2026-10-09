-- 入金期日・請求期間（年払い含む）は請求コードではなく契約が持つ。
-- 20261009100000 で billing_code に追加した列（全件既定値のまま未使用）を lease_contract へ移す。
-- 既存の契約はすべて既定値（当月末日・土日祝は前日／翌月分・年払いなし）になる。

alter table public.lease_contract
  add column if not exists due_month_offset smallint not null default 0 check (due_month_offset in (0, 1)),
  add column if not exists due_day_of_month smallint not null default 0 check (due_day_of_month between 0 and 31),
  add column if not exists due_holiday_adjustment text not null default 'previous' check (due_holiday_adjustment in ('previous', 'next')),
  add column if not exists period_month_offset smallint not null default 1 check (period_month_offset in (-1, 0, 1)),
  add column if not exists is_annual_billing boolean not null default false,
  add column if not exists annual_billing_month smallint check (annual_billing_month between 1 and 12),
  add column if not exists annual_start_offset smallint check (annual_start_offset in (1, 2));

alter table public.lease_contract drop constraint if exists lease_contract_annual_terms_check;
alter table public.lease_contract add constraint lease_contract_annual_terms_check
  check (not is_annual_billing or (annual_billing_month is not null and annual_start_offset is not null));

comment on column public.lease_contract.due_month_offset is '入金期日の月（0=当月、1=翌月）';
comment on column public.lease_contract.due_day_of_month is '入金期日の日（1〜31、0=末日）';
comment on column public.lease_contract.due_holiday_adjustment is '入金期日が土日祝のとき（previous=前日、next=翌日）';
comment on column public.lease_contract.period_month_offset is '請求期間（-1=前月分、0=当月分、1=翌月分）。年払いでないときに使う';
comment on column public.lease_contract.is_annual_billing is '年払い。請求月だけ1年分（月額×12）を請求し、他の月は0円';
comment on column public.lease_contract.annual_billing_month is '年払いの請求月（1〜12）';
comment on column public.lease_contract.annual_start_offset is '年払いの請求期間の開始（1=翌月〜1年分、2=翌々月〜1年分）';

drop function if exists public.update_billing_code_terms(uuid, smallint, smallint, text, smallint, boolean, smallint, smallint);
alter table public.billing_code
  drop constraint if exists billing_code_annual_terms_check,
  drop column if exists due_month_offset,
  drop column if exists due_day_of_month,
  drop column if exists due_holiday_adjustment,
  drop column if exists period_month_offset,
  drop column if exists is_annual_billing,
  drop column if exists annual_billing_month,
  drop column if exists annual_start_offset;

create or replace function public.update_lease_contract_billing_terms(
  p_lease_contract_id uuid,
  p_due_month_offset smallint,
  p_due_day_of_month smallint,
  p_due_holiday_adjustment text,
  p_period_month_offset smallint,
  p_is_annual_billing boolean,
  p_annual_billing_month smallint,
  p_annual_start_offset smallint
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.current_account_is_active()
     or not (public.current_account_role() = 'admin' or public.current_account_is_accounting_department()) then
    raise exception '請求条件を更新する権限がありません';
  end if;

  update public.lease_contract
  set due_month_offset = p_due_month_offset,
      due_day_of_month = p_due_day_of_month,
      due_holiday_adjustment = p_due_holiday_adjustment,
      period_month_offset = p_period_month_offset,
      is_annual_billing = p_is_annual_billing,
      annual_billing_month = case when p_is_annual_billing then p_annual_billing_month end,
      annual_start_offset = case when p_is_annual_billing then p_annual_start_offset end,
      updated_at = now()
  where lease_contract_id = p_lease_contract_id;

  if not found then
    raise exception '契約が見つかりません';
  end if;
end;
$$;

revoke all on function public.update_lease_contract_billing_terms(uuid, smallint, smallint, text, smallint, boolean, smallint, smallint) from public, anon;
grant execute on function public.update_lease_contract_billing_terms(uuid, smallint, smallint, text, smallint, boolean, smallint, smallint) to authenticated;
comment on function public.update_lease_contract_billing_terms(uuid, smallint, smallint, text, smallint, boolean, smallint, smallint) is '契約の入金期日・請求期間（年払い含む）を設定する。総務経理部所属者とadminロールのみ実行できる。';
