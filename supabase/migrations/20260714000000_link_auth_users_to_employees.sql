-- Supabase Auth アカウントと従業員マスタの紐づけ
-- 初回管理者は、対象ユーザーが登録された後に SQL Editor で
-- update public.user_profiles set role = 'admin' where email = '管理者メールアドレス';
-- を実行して設定する。

create extension if not exists citext;

alter table public.employee_master
  add column if not exists email citext,
  add column if not exists employment_status varchar(10) not null default 'active';

alter table public.employee_master
  drop constraint if exists ck_employee_master_employment_status;

alter table public.employee_master
  add constraint ck_employee_master_employment_status
  check (employment_status in ('active', 'inactive'));

create unique index if not exists uq_employee_master_email
  on public.employee_master (email)
  where email is not null;

comment on column public.employee_master.email is 'ログインアカウントとの照合に使用するメールアドレス（大文字小文字を区別しない）';
comment on column public.employee_master.employment_status is '在籍状態。inactive の担当者はログインと担当者候補から除外する';

create table if not exists public.user_profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  employee_id uuid unique references public.employee_master (employee_id) on delete restrict,
  email citext not null unique,
  role varchar(10) not null default 'viewer'
    check (role in ('admin', 'manager', 'staff', 'viewer')),
  account_status varchar(10) not null default 'pending'
    check (account_status in ('pending', 'active', 'suspended')),
  approved_at timestamptz,
  approved_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_user_profiles_approval
    check (
      (account_status = 'active' and employee_id is not null)
      or account_status in ('pending', 'suspended')
    )
);

comment on table public.user_profiles is 'Supabase Auth アカウントの業務プロフィール、ロール、従業員紐づけを管理する';
comment on column public.user_profiles.employee_id is '担当者マスタとの1対1紐づけ。未照合アカウントは null';

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_user_profiles_updated_at on public.user_profiles;
create trigger set_user_profiles_updated_at
before update on public.user_profiles
for each row execute procedure public.set_updated_at();

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

  insert into public.user_profiles (user_id, employee_id, email, role, account_status, approved_at)
  values (
    new.id,
    matched_employee_id,
    normalized_email,
    case when matched_employee_id is null then 'viewer' else 'staff' end,
    case when matched_employee_id is null then 'pending' else 'active' end,
    case when matched_employee_id is null then null else now() end
  );

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_auth_user();

create or replace function public.suspend_inactive_employee_accounts()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.employment_status = 'inactive' and old.employment_status is distinct from new.employment_status then
    update public.user_profiles
       set account_status = 'suspended'
     where employee_id = new.employee_id
       and account_status <> 'suspended';
  end if;
  return new;
end;
$$;

drop trigger if exists suspend_inactive_employee_accounts on public.employee_master;
create trigger suspend_inactive_employee_accounts
after update of employment_status on public.employee_master
for each row execute procedure public.suspend_inactive_employee_accounts();

create or replace function public.current_account_role()
returns varchar
language sql
stable
security definer
set search_path = public
as $$
  select role from public.user_profiles where user_id = auth.uid();
$$;

create or replace function public.current_account_is_active()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select account_status = 'active' from public.user_profiles where user_id = auth.uid()), false);
$$;

create or replace function public.current_account_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select account_status = 'active' and role = 'admin' from public.user_profiles where user_id = auth.uid()), false);
$$;

alter table public.user_profiles enable row level security;

drop policy if exists "profiles: user reads own profile" on public.user_profiles;
create policy "profiles: user reads own profile"
on public.user_profiles for select to authenticated
using (user_id = auth.uid() or public.current_account_is_admin());

drop policy if exists "profiles: admin manages profiles" on public.user_profiles;
create policy "profiles: admin manages profiles"
on public.user_profiles for update to authenticated
using (public.current_account_is_admin())
with check (public.current_account_is_admin());

drop policy if exists "employees: active user reads employees" on public.employee_master;
create policy "employees: active user reads employees"
on public.employee_master for select to authenticated
using (public.current_account_is_active());

grant select on public.employee_master to authenticated;
grant select, update on public.user_profiles to authenticated;

-- 業務テーブルのRLSでは public.current_account_is_active() を追加条件として用いること。
