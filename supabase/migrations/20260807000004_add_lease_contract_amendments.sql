-- Contract amendments are the legal source of changes after the original lease.
-- A change affects reporting only after its memorandum has been executed.

alter table public.lease_contract_unit
  add column if not exists lease_start_date date,
  add column if not exists lease_end_date date;

alter table public.lease_contract_unit drop constraint if exists ck_lease_contract_unit_dates;
alter table public.lease_contract_unit add constraint ck_lease_contract_unit_dates check (lease_end_date is null or lease_start_date is null or lease_end_date >= lease_start_date);

update public.lease_contract_unit as unit
set lease_start_date = coalesce(unit.lease_start_date, contract.contract_start_date, unit.created_at::date)
from public.lease_contract as contract
where contract.lease_contract_id = unit.lease_contract_id and unit.lease_start_date is null;

create table if not exists public.lease_contract_amendment (
  lease_contract_amendment_id uuid primary key default gen_random_uuid(),
  lease_contract_id uuid not null references public.lease_contract(lease_contract_id) on delete cascade,
  appsuite_record_id uuid unique references public.appsuite_record(appsuite_record_id) on delete restrict,
  amendment_type varchar(30) not null,
  status varchar(20) not null default 'draft',
  effective_date date not null,
  executed_date date,
  memorandum_file_path text,
  ringi_number varchar(100), approval_status varchar(100), approved_at timestamptz,
  appsuite_snapshot jsonb not null default '{}'::jsonb, notes text,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  updated_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint ck_lease_contract_amendment_type check (amendment_type in ('increase', 'decrease', 'rent_revision', 'other')),
  constraint ck_lease_contract_amendment_status check (status in ('draft', 'approved', 'executed', 'void')),
  constraint ck_lease_contract_amendment_execution check ((status <> 'executed') or (executed_date is not null and memorandum_file_path is not null and length(trim(memorandum_file_path)) > 0)),
  constraint ck_lease_contract_amendment_snapshot check (jsonb_typeof(appsuite_snapshot) = 'object')
);

alter table public.lease_contract_unit
  add column if not exists created_by_amendment_id uuid references public.lease_contract_amendment(lease_contract_amendment_id) on delete restrict;

create table if not exists public.lease_contract_amendment_unit (
  lease_contract_amendment_unit_id uuid primary key default gen_random_uuid(),
  lease_contract_amendment_id uuid not null references public.lease_contract_amendment(lease_contract_amendment_id) on delete cascade,
  lease_contract_unit_id uuid not null references public.lease_contract_unit(lease_contract_unit_id) on delete restrict,
  change_type varchar(20) not null, created_at timestamptz not null default now(),
  constraint uq_lease_contract_amendment_unit unique (lease_contract_amendment_id, lease_contract_unit_id),
  constraint ck_lease_contract_amendment_unit_type check (change_type in ('add', 'remove', 'terms'))
);

create table if not exists public.lease_contract_unit_term (
  lease_contract_unit_term_id uuid primary key default gen_random_uuid(),
  lease_contract_unit_id uuid not null references public.lease_contract_unit(lease_contract_unit_id) on delete cascade,
  lease_contract_amendment_id uuid references public.lease_contract_amendment(lease_contract_amendment_id) on delete restrict,
  effective_from date not null, effective_to date,
  monthly_rent_amount numeric(14, 0), monthly_common_charge_amount numeric(14, 0),
  deposit_amount numeric(14, 0), security_deposit_amount numeric(14, 0),
  key_money_amount numeric(14, 0), renewal_fee_amount numeric(14, 0),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint uq_lease_contract_unit_term_start unique (lease_contract_unit_id, effective_from),
  constraint ck_lease_contract_unit_term_dates check (effective_to is null or effective_to >= effective_from),
  constraint ck_lease_contract_unit_term_amounts check ((monthly_rent_amount is null or monthly_rent_amount >= 0) and (monthly_common_charge_amount is null or monthly_common_charge_amount >= 0) and (deposit_amount is null or deposit_amount >= 0) and (security_deposit_amount is null or security_deposit_amount >= 0) and (key_money_amount is null or key_money_amount >= 0) and (renewal_fee_amount is null or renewal_fee_amount >= 0))
);

insert into public.lease_contract_unit_term (lease_contract_unit_id, effective_from, effective_to, monthly_rent_amount, monthly_common_charge_amount, deposit_amount, security_deposit_amount, key_money_amount, renewal_fee_amount)
select unit.lease_contract_unit_id, unit.lease_start_date, coalesce(unit.lease_end_date, contract.contract_end_date), unit.monthly_rent_amount, unit.monthly_common_charge_amount, unit.deposit_amount, unit.security_deposit_amount, unit.key_money_amount, unit.renewal_fee_amount
from public.lease_contract_unit as unit join public.lease_contract as contract on contract.lease_contract_id = unit.lease_contract_id
on conflict (lease_contract_unit_id, effective_from) do nothing;

create index if not exists ix_lease_contract_unit_term_effective on public.lease_contract_unit_term(lease_contract_unit_id, effective_from desc, effective_to);
create index if not exists ix_lease_contract_amendment_contract_effective on public.lease_contract_amendment(lease_contract_id, effective_date, status);

create or replace function public.set_lease_contract_amendment_updated_fields() returns trigger language plpgsql set search_path = public as $$ begin new.updated_at = now(); new.updated_by = auth.uid(); return new; end; $$;
create or replace function public.validate_lease_contract_amendment_unit() returns trigger language plpgsql set search_path = public as $$ begin
  if not exists (select 1 from public.lease_contract_amendment as amendment join public.lease_contract_unit as unit on unit.lease_contract_id = amendment.lease_contract_id where amendment.lease_contract_amendment_id = new.lease_contract_amendment_id and unit.lease_contract_unit_id = new.lease_contract_unit_id) then raise exception 'Amendment and contract unit must belong to the same lease contract'; end if;
  return new;
end; $$;
create or replace function public.validate_lease_contract_unit_term() returns trigger language plpgsql set search_path = public as $$ begin
  if new.lease_contract_amendment_id is not null and not exists (select 1 from public.lease_contract_amendment as amendment join public.lease_contract_unit as unit on unit.lease_contract_id = amendment.lease_contract_id where amendment.lease_contract_amendment_id = new.lease_contract_amendment_id and unit.lease_contract_unit_id = new.lease_contract_unit_id) then raise exception 'Term amendment and contract unit must belong to the same lease contract'; end if;
  return new;
end; $$;
drop trigger if exists set_lease_contract_amendment_updated_fields on public.lease_contract_amendment;
create trigger set_lease_contract_amendment_updated_fields before update on public.lease_contract_amendment for each row execute procedure public.set_lease_contract_amendment_updated_fields();
drop trigger if exists set_lease_contract_unit_term_updated_at on public.lease_contract_unit_term;
create trigger set_lease_contract_unit_term_updated_at before update on public.lease_contract_unit_term for each row execute procedure public.set_updated_at();
drop trigger if exists validate_lease_contract_amendment_unit on public.lease_contract_amendment_unit;
create trigger validate_lease_contract_amendment_unit before insert or update on public.lease_contract_amendment_unit for each row execute procedure public.validate_lease_contract_amendment_unit();
drop trigger if exists validate_lease_contract_unit_term on public.lease_contract_unit_term;
create trigger validate_lease_contract_unit_term before insert or update on public.lease_contract_unit_term for each row execute procedure public.validate_lease_contract_unit_term();

create or replace function public.create_lease_contract_amendment_from_appsuite(
  p_appsuite_record_id uuid,
  p_lease_contract_id uuid,
  p_amendment_type varchar,
  p_effective_date date
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not exists (select 1 from public.user_profiles where user_id = auth.uid() and account_status = 'active' and role in ('admin', 'manager', 'staff')) then
    raise exception 'Contract amendment management permission required';
  end if;
  if not exists (
    select 1 from public.appsuite_record
    where appsuite_record_id = p_appsuite_record_id and is_present
      and approval_status in ('社長決裁済', '完了') and workflow_completed_at is not null
  ) then raise exception 'A completed AppSuite approval is required'; end if;
  insert into public.lease_contract_amendment (
    lease_contract_id, appsuite_record_id, amendment_type, status, effective_date,
    ringi_number, approval_status, approved_at, appsuite_snapshot
  )
  select p_lease_contract_id, record.appsuite_record_id, p_amendment_type, 'approved', p_effective_date,
    record.ringi_number, record.approval_status, coalesce(record.source_updated_at, record.source_created_at), record.raw_payload
  from public.appsuite_record as record where record.appsuite_record_id = p_appsuite_record_id
  on conflict (appsuite_record_id) do update set lease_contract_id = excluded.lease_contract_id
  returning lease_contract_amendment_id into v_id;
  return v_id;
end;
$$;

create or replace function public.execute_lease_contract_amendment(
  p_lease_contract_amendment_id uuid,
  p_executed_date date,
  p_memorandum_file_path text
) returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.user_profiles where user_id = auth.uid() and account_status = 'active' and role in ('admin', 'manager', 'staff')) then
    raise exception 'Contract amendment management permission required';
  end if;
  update public.lease_contract_amendment
     set status = 'executed', executed_date = p_executed_date, memorandum_file_path = p_memorandum_file_path
   where lease_contract_amendment_id = p_lease_contract_amendment_id and status = 'approved';
  if not found then raise exception 'Only an approved amendment can be executed'; end if;
  update public.lease_contract_unit as unit
     set lease_end_date = amendment.effective_date - 1
    from public.lease_contract_amendment_unit as change
    join public.lease_contract_amendment as amendment on amendment.lease_contract_amendment_id = change.lease_contract_amendment_id
   where change.lease_contract_amendment_id = p_lease_contract_amendment_id
     and change.change_type = 'remove' and unit.lease_contract_unit_id = change.lease_contract_unit_id;
end;
$$;

alter table public.lease_contract_amendment enable row level security;
alter table public.lease_contract_amendment_unit enable row level security;
alter table public.lease_contract_unit_term enable row level security;
grant select, insert, update, delete on public.lease_contract_amendment, public.lease_contract_amendment_unit, public.lease_contract_unit_term to authenticated;
create policy "active users manage lease contract amendments" on public.lease_contract_amendment for all to authenticated using (public.current_account_is_active()) with check (public.current_account_is_active());
create policy "active users manage lease contract amendment units" on public.lease_contract_amendment_unit for all to authenticated using (public.current_account_is_active()) with check (public.current_account_is_active());
create policy "active users manage lease contract unit terms" on public.lease_contract_unit_term for all to authenticated using (public.current_account_is_active()) with check (public.current_account_is_active());

revoke all on function public.create_lease_contract_amendment_from_appsuite(uuid, uuid, varchar, date) from public;
revoke all on function public.execute_lease_contract_amendment(uuid, date, text) from public;
grant execute on function public.create_lease_contract_amendment_from_appsuite(uuid, uuid, varchar, date) to authenticated;
grant execute on function public.execute_lease_contract_amendment(uuid, date, text) to authenticated;

comment on table public.lease_contract_amendment is '増床・減床・賃料改定の覚書。executed かつ効力発生日到来後だけレントロールへ反映する。';
comment on table public.lease_contract_unit_term is '契約区画ごとの時限付き金額条件。覚書由来の行は親覚書の締結後だけ有効。';
