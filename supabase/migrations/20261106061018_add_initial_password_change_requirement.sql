alter table public.user_profiles
  add column if not exists must_change_password boolean not null default false;

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  matched_employee_id uuid;
  normalized_email citext;
begin
  normalized_email := lower(new.email)::citext;

  if normalized_email is null then
    raise exception 'メールアドレスがないアカウントは作成できません';
  end if;

  select employee_id
    into matched_employee_id
    from public.employee_master
   where email = normalized_email
     and employment_status = 'active';

  insert into public.user_profiles (
    user_id, employee_id, email, role, account_status, approved_at, must_change_password
  )
  values (
    new.id,
    matched_employee_id,
    normalized_email,
    case when matched_employee_id is null then 'viewer' else 'staff' end,
    case when matched_employee_id is null then 'pending' else 'active' end,
    case when matched_employee_id is null then null else now() end,
    true
  );

  return new;
end;
$$;

create or replace function public.current_account_is_active()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select account_status = 'active' and not must_change_password
    from public.user_profiles
    where user_id = auth.uid()
  ), false);
$$;

create or replace function public.current_account_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select account_status = 'active' and role = 'admin' and not must_change_password
    from public.user_profiles
    where user_id = auth.uid()
  ), false);
$$;
