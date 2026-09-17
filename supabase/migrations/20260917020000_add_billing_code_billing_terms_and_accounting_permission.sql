-- 請求コードに、物件単位の入金期日パターン・請求期間パターンを割り当てられるようにする。
-- 編集は「総務経理部」所属の担当者と admin ロールのみに限定する。

alter table public.billing_code
  add column if not exists billing_due_date_pattern_id uuid references public.asset_billing_due_date_pattern(billing_due_date_pattern_id) on delete set null,
  add column if not exists billing_period_pattern_id uuid references public.asset_billing_period_pattern(billing_period_pattern_id) on delete set null;

comment on column public.billing_code.billing_due_date_pattern_id is 'この請求コードに適用する入金期日パターン（物件単位の asset_billing_due_date_pattern）';
comment on column public.billing_code.billing_period_pattern_id is 'この請求コードに適用する請求期間パターン（物件単位の asset_billing_period_pattern）';

create or replace function public.current_account_department_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select employee.department_id
  from public.user_profiles profile
  join public.employee_master employee on employee.employee_id = profile.employee_id
  where profile.user_id = auth.uid();
$$;

create or replace function public.current_account_is_accounting_department()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    public.current_account_is_active()
    and public.current_account_department_id() = (
      select department_id from public.department_master where department_name = '総務経理部'
    ),
    false
  );
$$;

-- 請求コードの支払期日・請求スパンは、総務経理部所属者とadminロールのみが更新できる。
-- 対象パターンが請求コードと同じ物件のものであることをここで検証する。
create or replace function public.update_billing_code_billing_terms(
  p_billing_code_id uuid,
  p_billing_due_date_pattern_id uuid,
  p_billing_period_pattern_id uuid
)
returns public.billing_code
language plpgsql
security definer
set search_path = public
as $$
declare
  v_billing_code public.billing_code%rowtype;
  v_due_pattern_asset_id uuid;
  v_period_pattern_asset_id uuid;
begin
  if not public.current_account_is_active()
     or not (public.current_account_role() = 'admin' or public.current_account_is_accounting_department()) then
    raise exception '支払期日・請求スパンを更新する権限がありません';
  end if;

  select * into v_billing_code from public.billing_code where billing_code_id = p_billing_code_id;
  if not found then
    raise exception '請求コードが見つかりません';
  end if;

  if p_billing_due_date_pattern_id is not null then
    select asset_id into v_due_pattern_asset_id
    from public.asset_billing_due_date_pattern
    where billing_due_date_pattern_id = p_billing_due_date_pattern_id;
    if v_due_pattern_asset_id is null or v_due_pattern_asset_id <> v_billing_code.property_id then
      raise exception '入金期日パターンがこの物件のものではありません';
    end if;
  end if;

  if p_billing_period_pattern_id is not null then
    select asset_id into v_period_pattern_asset_id
    from public.asset_billing_period_pattern
    where billing_period_pattern_id = p_billing_period_pattern_id;
    if v_period_pattern_asset_id is null or v_period_pattern_asset_id <> v_billing_code.property_id then
      raise exception '請求期間パターンがこの物件のものではありません';
    end if;
  end if;

  update public.billing_code
  set billing_due_date_pattern_id = p_billing_due_date_pattern_id,
      billing_period_pattern_id = p_billing_period_pattern_id,
      updated_at = now()
  where billing_code_id = p_billing_code_id
  returning * into v_billing_code;

  return v_billing_code;
end;
$$;

revoke all on function public.current_account_department_id() from public, anon;
revoke all on function public.current_account_is_accounting_department() from public, anon;
revoke all on function public.update_billing_code_billing_terms(uuid, uuid, uuid) from public, anon;
grant execute on function public.current_account_department_id() to authenticated;
grant execute on function public.current_account_is_accounting_department() to authenticated;
grant execute on function public.update_billing_code_billing_terms(uuid, uuid, uuid) to authenticated;

comment on function public.current_account_department_id() is 'ログイン中アカウントに紐づく担当者の所属部門IDを返す。担当者が未紐づけの場合はnull。';
comment on function public.current_account_is_accounting_department() is 'ログイン中アカウントが有効かつ総務経理部所属かどうかを判定する。';
comment on function public.update_billing_code_billing_terms(uuid, uuid, uuid) is '請求コードへ入金期日パターン・請求期間パターンを設定する。総務経理部所属者とadminロールのみ実行できる。';
