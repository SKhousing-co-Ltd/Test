-- 法的な賃貸借形態を、既存の契約カテゴリ（lease / parking）から分離する。
-- 既存契約は推測で分類せず NULL のまま残す。

alter table public.lease_contract
  add column if not exists lease_term_type varchar(20),
  add column if not exists renewal_due_date date,
  add column if not exists actual_end_date date,
  add column if not exists renewed_from_contract_id uuid;

alter table public.lease_contract
  drop constraint if exists ck_lease_contract_term_type;
alter table public.lease_contract
  add constraint ck_lease_contract_term_type
  check (lease_term_type is null or lease_term_type in ('ordinary', 'fixed_term'));

alter table public.lease_contract
  drop constraint if exists ck_lease_contract_term_dates;
alter table public.lease_contract
  add constraint ck_lease_contract_term_dates check (
    (lease_term_type is distinct from 'ordinary' or contract_end_date is null)
    and (lease_term_type is distinct from 'fixed_term' or contract_end_date is not null)
    and (lease_term_type is distinct from 'fixed_term' or renewal_due_date is null)
    and (renewal_due_date is null or lease_term_type = 'ordinary')
    and (renewal_due_date is null or contract_start_date is null or renewal_due_date >= contract_start_date)
    and (actual_end_date is null or contract_start_date is null or actual_end_date >= contract_start_date)
    and (lease_term_type is distinct from 'fixed_term' or actual_end_date is null or actual_end_date <= contract_end_date)
    and (
      contract_type is distinct from 'parking'
      or (lease_term_type is null and renewal_due_date is null
          and actual_end_date is null and renewed_from_contract_id is null)
    )
  );

alter table public.lease_contract
  drop constraint if exists fk_lease_contract_renewed_from;
alter table public.lease_contract
  add constraint fk_lease_contract_renewed_from
  foreign key (renewed_from_contract_id)
  references public.lease_contract(lease_contract_id)
  on delete restrict;

alter table public.lease_contract
  drop constraint if exists ck_lease_contract_not_self_renewed;
alter table public.lease_contract
  add constraint ck_lease_contract_not_self_renewed
  check (renewed_from_contract_id is null or renewed_from_contract_id <> lease_contract_id);

create unique index if not exists uq_lease_contract_renewed_from
  on public.lease_contract(renewed_from_contract_id)
  where renewed_from_contract_id is not null and contract_status <> 'draft';
create index if not exists ix_lease_contract_ordinary_renewal_due
  on public.lease_contract(renewal_due_date, lease_contract_id)
  where lease_term_type = 'ordinary' and actual_end_date is null;
create index if not exists ix_lease_contract_fixed_term_end
  on public.lease_contract(contract_end_date, lease_contract_id)
  where lease_term_type = 'fixed_term' and actual_end_date is null;

create or replace function public.validate_lease_contract_renewal_link()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare predecessor public.lease_contract%rowtype;
begin
  if new.renewed_from_contract_id is null then return new; end if;
  select * into predecessor from public.lease_contract contract
  where contract.lease_contract_id = new.renewed_from_contract_id;
  if not found then raise exception '再契約元が見つかりません'; end if;
  if predecessor.tenant_id <> new.tenant_id then
    raise exception '再契約元と新契約のTenantが一致しません';
  end if;
  if predecessor.lease_term_type is distinct from 'fixed_term'
     or new.lease_term_type is distinct from 'fixed_term' then
    raise exception '定期賃貸借だけを再契約として関連付けられます';
  end if;
  if predecessor.contract_end_date is null
     or new.contract_start_date is null
     or new.contract_start_date <= predecessor.contract_end_date then
    raise exception '再契約開始日は旧契約終了日の翌日以降にしてください';
  end if;
  return new;
end;
$$;

drop trigger if exists validate_lease_contract_renewal_link on public.lease_contract;
create trigger validate_lease_contract_renewal_link
before insert or update of renewed_from_contract_id, tenant_id, lease_term_type,
  contract_start_date, contract_end_date
on public.lease_contract
for each row execute function public.validate_lease_contract_renewal_link();

revoke all on function public.validate_lease_contract_renewal_link()
  from public, anon, authenticated;

create table if not exists public.contract_deadline_notification_setting (
  issue_type varchar(40) primary key,
  lead_days integer not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null default auth.uid(),
  constraint ck_contract_deadline_setting_issue_type
    check (issue_type in ('ordinary_renewal', 'fixed_term_end')),
  constraint ck_contract_deadline_setting_lead_days
    check (lead_days between 0 and 3650)
);

insert into public.contract_deadline_notification_setting(issue_type, lead_days)
values ('ordinary_renewal', 180), ('fixed_term_end', 180)
on conflict (issue_type) do nothing;

create or replace function public.set_contract_deadline_setting_updated_fields()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;

drop trigger if exists set_contract_deadline_setting_updated_fields
  on public.contract_deadline_notification_setting;
create trigger set_contract_deadline_setting_updated_fields
before update on public.contract_deadline_notification_setting
for each row execute function public.set_contract_deadline_setting_updated_fields();

alter table public.contract_deadline_notification_setting enable row level security;
revoke all on table public.contract_deadline_notification_setting from public, anon;
grant select, update on table public.contract_deadline_notification_setting to authenticated;

create policy "active users read contract deadline settings"
  on public.contract_deadline_notification_setting for select to authenticated
  using ((select public.current_account_is_active()));
create policy "managers update contract deadline settings"
  on public.contract_deadline_notification_setting for update to authenticated
  using (
    (select public.current_account_is_active())
    and (select public.current_account_role()) in ('admin', 'manager')
  )
  with check (
    (select public.current_account_is_active())
    and (select public.current_account_role()) in ('admin', 'manager')
  );

revoke all on function public.set_contract_deadline_setting_updated_fields()
  from public, anon, authenticated;

comment on column public.lease_contract.lease_term_type
  is '法的な賃貸借形態。ordinary=普通賃貸借、fixed_term=定期賃貸借。既存契約は確認完了までNULL。';
comment on column public.lease_contract.renewal_due_date
  is '普通賃貸借の次回更新予定日。契約終了日やレントロール掲載期限ではない。';
comment on column public.lease_contract.actual_end_date
  is '解約・退去等による実際の契約終了日。';
comment on column public.lease_contract.renewed_from_contract_id
  is '定期賃貸借の再契約元。旧契約自体は変更せず履歴として保持する。';
comment on table public.contract_deadline_notification_setting
  is '契約期限対応依頼を何日前から生成するかを管理する。';
