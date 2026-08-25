-- A tenant may use multiple external codes when billing accounts are invoiced separately.

create table public.tenant_billing_code (
  tenant_billing_code_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant_master(tenant_id) on delete cascade,
  billing_code varchar(100) not null,
  is_primary boolean not null default false,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_tenant_billing_code_code unique (billing_code),
  constraint uq_tenant_billing_code_tenant_pair unique (tenant_id, tenant_billing_code_id),
  constraint ck_tenant_billing_code_not_blank check (billing_code = btrim(billing_code) and billing_code <> ''),
  constraint ck_tenant_billing_code_primary_active check (not is_primary or is_active),
  constraint ck_tenant_billing_code_sort_order check (sort_order >= 0)
);

create unique index uq_tenant_billing_code_primary
  on public.tenant_billing_code(tenant_id)
  where is_primary;
create index ix_tenant_billing_code_tenant
  on public.tenant_billing_code(tenant_id, is_active, sort_order);

create table public.tenant_billing_code_account (
  tenant_id uuid not null references public.tenant_master(tenant_id) on delete cascade,
  account_id varchar(10) not null references public.income_expense_account_master(account_id) on delete restrict,
  tenant_billing_code_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, account_id),
  constraint fk_tenant_billing_code_account_code
    foreign key (tenant_id, tenant_billing_code_id)
    references public.tenant_billing_code(tenant_id, tenant_billing_code_id)
    on delete cascade
);

create index ix_tenant_billing_code_account_code
  on public.tenant_billing_code_account(tenant_billing_code_id);

create or replace function public.set_tenant_billing_code_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger set_tenant_billing_code_updated_at
before update on public.tenant_billing_code
for each row execute procedure public.set_tenant_billing_code_updated_at();

-- Preserve the current single code as each tenant's primary code.
insert into public.tenant_billing_code(tenant_id, billing_code, is_primary, is_active, sort_order)
select tenant_id, btrim(external_tenant_code), true, true, 0
from public.tenant_master
where nullif(btrim(external_tenant_code), '') is not null
on conflict (billing_code) do nothing;

insert into public.tenant_billing_code_account(tenant_id, account_id, tenant_billing_code_id)
select code.tenant_id, account.account_id, code.tenant_billing_code_id
from public.tenant_billing_code code
cross join public.income_expense_account_master account
where code.is_primary
  and account.income_expense_type = '収入'
on conflict (tenant_id, account_id) do nothing;

-- Recover every code recorded in outstanding multiple-code import issues.
create temporary table tenant_multi_code_stage (
  tenant_id uuid not null,
  billing_code text not null,
  ordinal bigint not null,
  primary key (tenant_id, billing_code)
) on commit drop;

insert into tenant_multi_code_stage(tenant_id, billing_code, ordinal)
select matched.tenant_id, parsed.billing_code, min(parsed.ordinal)
from public.rent_roll_import_issue issue
cross join lateral (
  select tenant.tenant_id
  from public.tenant_master tenant
  where tenant.tenant_name = issue.source_payload ->> 'tenant_name'
     or tenant.normalized_tenant_name = lower(regexp_replace(coalesce(issue.source_payload ->> 'tenant_name', ''), '[[:space:]　]+', '', 'g'))
  order by (tenant.tenant_name = issue.source_payload ->> 'tenant_name') desc
  limit 1
) matched
cross join lateral (
  select regexp_replace(btrim(part), '[[:space:]　]+', '', 'g') as billing_code, ordinal
  from regexp_split_to_table(coalesce(issue.source_payload ->> 'tenant_code', ''), E'[\n/]+') with ordinality split(part, ordinal)
) parsed
where issue.issue_type = 'multiple_tenant_codes'
  and issue.resolved_at is null
  and parsed.billing_code <> ''
group by matched.tenant_id, parsed.billing_code;

insert into public.tenant_billing_code(tenant_id, billing_code, is_primary, is_active, sort_order)
select staged.tenant_id,
       staged.billing_code,
       not exists (
         select 1 from public.tenant_billing_code existing
         where existing.tenant_id = staged.tenant_id and existing.is_primary
       ) and row_number() over (partition by staged.tenant_id order by staged.ordinal, staged.billing_code) = 1,
       true,
       coalesce((select max(existing.sort_order) + 1 from public.tenant_billing_code existing where existing.tenant_id = staged.tenant_id), 0)
         + row_number() over (partition by staged.tenant_id order by staged.ordinal, staged.billing_code)::integer - 1
from tenant_multi_code_stage staged
where not exists (
  select 1 from public.tenant_billing_code existing where existing.billing_code = staged.billing_code
)
on conflict (billing_code) do nothing;

update public.tenant_master tenant
set external_tenant_code = code.billing_code,
    updated_at = now()
from public.tenant_billing_code code
where code.tenant_id = tenant.tenant_id
  and code.is_primary
  and tenant.external_tenant_code is distinct from code.billing_code;

insert into public.tenant_billing_code_account(tenant_id, account_id, tenant_billing_code_id)
select code.tenant_id, account.account_id, code.tenant_billing_code_id
from public.tenant_billing_code code
cross join public.income_expense_account_master account
where code.is_primary
  and account.income_expense_type = '収入'
on conflict (tenant_id, account_id) do nothing;

-- Link existing workbench requests to the matched tenant without closing them.
update public.change_request request
set proposed_payload = request.proposed_payload || jsonb_build_object(
      'tenant_id', matched.tenant_id,
      'tenant_billing_configuration_required', true
    )
from public.change_request_item item
join public.rent_roll_import_issue issue
  on issue.rent_roll_import_issue_id = item.rent_roll_import_issue_id
cross join lateral (
  select tenant.tenant_id
  from public.tenant_master tenant
  where tenant.tenant_name = issue.source_payload ->> 'tenant_name'
     or tenant.normalized_tenant_name = lower(regexp_replace(coalesce(issue.source_payload ->> 'tenant_name', ''), '[[:space:]　]+', '', 'g'))
  order by (tenant.tenant_name = issue.source_payload ->> 'tenant_name') desc
  limit 1
) matched
where request.change_request_id = item.change_request_id
  and issue.issue_type = 'multiple_tenant_codes'
  and request.status not in ('applied', 'excluded');

create or replace function public.resolve_tenant_billing_code(
  p_tenant_id uuid,
  p_account_id varchar
) returns text
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_code text;
begin
  if not public.current_account_is_active() then
    raise exception '有効なアカウントが必要です';
  end if;

  select code.billing_code into v_code
  from public.tenant_billing_code_account assignment
  join public.tenant_billing_code code
    on code.tenant_billing_code_id = assignment.tenant_billing_code_id
   and code.tenant_id = assignment.tenant_id
  join public.income_expense_account_master account
    on account.account_id = assignment.account_id
  where assignment.tenant_id = p_tenant_id
    and assignment.account_id = p_account_id
    and account.income_expense_type = '収入'
    and code.is_active;

  if v_code is null then
    raise exception 'テナントと収入科目に対応する有効な請求コードが設定されていません';
  end if;
  return v_code;
end;
$$;

create or replace function public.replace_tenant_billing_code_config(
  p_tenant_id uuid,
  p_codes jsonb
) returns setof public.tenant_billing_code
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code jsonb;
  v_account_id text;
  v_code_id uuid;
  v_primary_code text;
begin
  if not public.current_account_is_active()
     or public.current_account_role() not in ('admin', 'manager') then
    raise exception 'テナントコードを更新する権限がありません';
  end if;
  if not exists (select 1 from public.tenant_master tenant where tenant.tenant_id = p_tenant_id) then
    raise exception 'テナントが見つかりません';
  end if;
  if p_codes is null or jsonb_typeof(p_codes) <> 'array' or jsonb_array_length(p_codes) = 0 then
    raise exception '請求コードを1件以上設定してください';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_codes) code
    where jsonb_typeof(code) <> 'object'
       or nullif(btrim(code ->> 'billing_code'), '') is null
       or length(btrim(code ->> 'billing_code')) > 100
       or jsonb_typeof(coalesce(code -> 'account_ids', '[]'::jsonb)) <> 'array'
  ) then
    raise exception '請求コードの入力形式が正しくありません';
  end if;
  if (select count(*) from jsonb_array_elements(p_codes)) <>
     (select count(distinct btrim(code ->> 'billing_code')) from jsonb_array_elements(p_codes) code) then
    raise exception '同じ請求コードが重複しています';
  end if;
  if (select count(*) from jsonb_array_elements(p_codes) code where coalesce((code ->> 'is_primary')::boolean, false)) <> 1
     or exists (
       select 1 from jsonb_array_elements(p_codes) code
       where coalesce((code ->> 'is_primary')::boolean, false)
         and not coalesce((code ->> 'is_active')::boolean, true)
     ) then
    raise exception '有効な主コードを1件設定してください';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_codes) code
    where not coalesce((code ->> 'is_active')::boolean, true)
      and jsonb_array_length(coalesce(code -> 'account_ids', '[]'::jsonb)) > 0
  ) then
    raise exception '無効なコードには科目を割り当てられません';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_codes) code
    cross join lateral jsonb_array_elements_text(coalesce(code -> 'account_ids', '[]'::jsonb)) account_value(account_id)
    left join public.income_expense_account_master account on account.account_id = account_value.account_id
    where account.account_id is null or account.income_expense_type <> '収入'
  ) then
    raise exception '収入科目だけを請求コードへ割り当てられます';
  end if;
  if exists (
    select account_value.account_id
    from jsonb_array_elements(p_codes) code
    cross join lateral jsonb_array_elements_text(coalesce(code -> 'account_ids', '[]'::jsonb)) account_value(account_id)
    group by account_value.account_id
    having count(*) > 1
  ) then
    raise exception '同じ収入科目を複数のコードへ割り当てることはできません';
  end if;
  if exists (
    select 1
    from public.income_expense_account_master account
    where account.income_expense_type = '収入'
      and not exists (
        select 1
        from jsonb_array_elements(p_codes) code
        cross join lateral jsonb_array_elements_text(coalesce(code -> 'account_ids', '[]'::jsonb)) account_value(account_id)
        where account_value.account_id = account.account_id
      )
  ) then
    raise exception 'すべての収入科目に請求コードを割り当ててください';
  end if;
  if exists (
    select 1
    from public.tenant_billing_code existing
    join jsonb_array_elements(p_codes) code on existing.billing_code = btrim(code ->> 'billing_code')
    where existing.tenant_id <> p_tenant_id
  ) then
    raise exception '別のテナントで使用中の請求コードがあります';
  end if;

  delete from public.tenant_billing_code where tenant_id = p_tenant_id;

  for v_code in select value from jsonb_array_elements(p_codes) with ordinality input(value, ordinal) order by ordinal loop
    insert into public.tenant_billing_code(
      tenant_id, billing_code, is_primary, is_active, sort_order
    ) values (
      p_tenant_id,
      btrim(v_code ->> 'billing_code'),
      coalesce((v_code ->> 'is_primary')::boolean, false),
      coalesce((v_code ->> 'is_active')::boolean, true),
      coalesce((v_code ->> 'sort_order')::integer, 0)
    ) returning tenant_billing_code_id into v_code_id;

    for v_account_id in
      select value from jsonb_array_elements_text(coalesce(v_code -> 'account_ids', '[]'::jsonb))
    loop
      insert into public.tenant_billing_code_account(tenant_id, account_id, tenant_billing_code_id)
      values (p_tenant_id, v_account_id, v_code_id);
    end loop;

    if coalesce((v_code ->> 'is_primary')::boolean, false) then
      v_primary_code := btrim(v_code ->> 'billing_code');
    end if;
  end loop;

  update public.tenant_master
  set external_tenant_code = v_primary_code, updated_at = now()
  where tenant_id = p_tenant_id;

  with candidates as (
    select distinct request.change_request_id, request.status as previous_status
    from public.change_request request
    join public.change_request_item item on item.change_request_id = request.change_request_id
    join public.rent_roll_import_issue issue on issue.rent_roll_import_issue_id = item.rent_roll_import_issue_id
    where request.source_type = 'initial_import'
      and request.request_type = 'rent_roll_correction'
      and request.status not in ('applied', 'excluded')
      and issue.issue_type = 'multiple_tenant_codes'
      and coalesce(request.proposed_payload ->> 'tenant_id', '') = p_tenant_id::text
      and (
        select count(*)
        from regexp_split_to_table(coalesce(issue.source_payload ->> 'tenant_code', ''), E'[\n/]+') part
        where regexp_replace(btrim(part), '[[:space:]　]+', '', 'g') <> ''
      ) >= 2
      and not exists (
        select 1
        from regexp_split_to_table(coalesce(issue.source_payload ->> 'tenant_code', ''), E'[\n/]+') part
        where regexp_replace(btrim(part), '[[:space:]　]+', '', 'g') <> ''
          and not exists (
            select 1 from public.tenant_billing_code code
            where code.tenant_id = p_tenant_id
              and code.billing_code = regexp_replace(btrim(part), '[[:space:]　]+', '', 'g')
          )
      )
  ), applied as (
    update public.change_request request
    set status = 'applied',
        resolution_payload = request.resolution_payload || jsonb_build_object(
          'reason', 'tenant_billing_configuration_completed',
          'tenant_id', p_tenant_id
        ),
        resolved_at = coalesce(request.resolved_at, now()),
        resolved_by = coalesce(request.resolved_by, auth.uid()),
        applied_at = now(),
        applied_by = auth.uid()
    from candidates
    where request.change_request_id = candidates.change_request_id
    returning request.change_request_id, candidates.previous_status
  )
  insert into public.change_request_action_log(
    change_request_id, action_type, previous_status, next_status, details, performed_by
  )
  select change_request_id, 'applied', previous_status, 'applied',
         jsonb_build_object('reason', 'tenant_billing_configuration_completed', 'tenant_id', p_tenant_id),
         auth.uid()
  from applied;

  update public.change_request_item item
  set validation_status = 'valid', validation_message = null
  where exists (
    select 1 from public.change_request request
    where request.change_request_id = item.change_request_id
      and request.status = 'applied'
      and request.resolution_payload ->> 'reason' = 'tenant_billing_configuration_completed'
      and request.resolution_payload ->> 'tenant_id' = p_tenant_id::text
  );

  update public.rent_roll_import_issue issue
  set resolved_at = now(), resolved_by = auth.uid()
  where issue.resolved_at is null
    and exists (
      select 1
      from public.change_request_item item
      join public.change_request request on request.change_request_id = item.change_request_id
      where item.rent_roll_import_issue_id = issue.rent_roll_import_issue_id
        and request.status = 'applied'
        and request.resolution_payload ->> 'reason' = 'tenant_billing_configuration_completed'
        and request.resolution_payload ->> 'tenant_id' = p_tenant_id::text
    );

  return query
  select * from public.tenant_billing_code
  where tenant_id = p_tenant_id
  order by sort_order, billing_code;
end;
$$;

alter table public.tenant_billing_code enable row level security;
alter table public.tenant_billing_code_account enable row level security;

grant select, insert, update, delete on public.tenant_billing_code to authenticated;
grant select, insert, update, delete on public.tenant_billing_code_account to authenticated;

create policy "active users read tenant billing codes"
  on public.tenant_billing_code for select to authenticated
  using (public.current_account_is_active());
create policy "managers maintain tenant billing codes"
  on public.tenant_billing_code for all to authenticated
  using (public.current_account_is_active() and public.current_account_role() in ('admin', 'manager'))
  with check (public.current_account_is_active() and public.current_account_role() in ('admin', 'manager'));
create policy "active users read tenant billing account assignments"
  on public.tenant_billing_code_account for select to authenticated
  using (public.current_account_is_active());
create policy "managers maintain tenant billing account assignments"
  on public.tenant_billing_code_account for all to authenticated
  using (public.current_account_is_active() and public.current_account_role() in ('admin', 'manager'))
  with check (public.current_account_is_active() and public.current_account_role() in ('admin', 'manager'));

revoke all on function public.set_tenant_billing_code_updated_at() from public;
revoke all on function public.resolve_tenant_billing_code(uuid, varchar) from public;
revoke all on function public.replace_tenant_billing_code_config(uuid, jsonb) from public;
revoke all on function public.resolve_tenant_billing_code(uuid, varchar) from anon;
revoke all on function public.replace_tenant_billing_code_config(uuid, jsonb) from anon;
grant execute on function public.resolve_tenant_billing_code(uuid, varchar) to authenticated;
grant execute on function public.replace_tenant_billing_code_config(uuid, jsonb) to authenticated;

comment on table public.tenant_billing_code is 'テナントが請求書分割に使用する主コード・サブコード。';
comment on table public.tenant_billing_code_account is 'テナントの収入科目ごとに使用する請求コード。';
comment on function public.resolve_tenant_billing_code(uuid, varchar) is 'テナントと収入科目に対応する有効な請求コードを返す。未設定時はエラー。';
comment on function public.replace_tenant_billing_code_config(uuid, jsonb) is 'テナントの請求コードと収入科目割当を一括更新し、関連する複数コード対応依頼を完了する。';
