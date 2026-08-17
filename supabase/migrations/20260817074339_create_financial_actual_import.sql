-- Auditable CSV staging for historical and monthly financial actuals.
create table public.financial_actual_import_batch (
  financial_actual_import_batch_id uuid primary key default gen_random_uuid(),
  source_file_name varchar(500) not null,
  source_file_size bigint check (source_file_size is null or source_file_size >= 0),
  source_sha256 varchar(64) check (source_sha256 is null or source_sha256 ~ '^[0-9a-f]{64}$'),
  status varchar(20) not null default 'staged'
    check (status in ('staged', 'action_required', 'ready', 'applying', 'applied', 'failed')),
  row_count integer not null default 0 check (row_count >= 0),
  ready_count integer not null default 0 check (ready_count >= 0),
  issue_count integer not null default 0 check (issue_count >= 0),
  applied_count integer not null default 0 check (applied_count >= 0),
  error_message text,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  applied_by uuid references auth.users(id) on delete set null,
  applied_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.financial_actual_import_row (
  financial_actual_import_row_id uuid primary key default gen_random_uuid(),
  financial_actual_import_batch_id uuid not null references public.financial_actual_import_batch(financial_actual_import_batch_id) on delete cascade,
  source_row_number integer not null check (source_row_number >= 2),
  property_code text,
  property_name text,
  account_id_text text,
  account_name text,
  accounting_month_text text,
  entry_date_text text,
  amount_text text,
  description text,
  counterparty_name text,
  notes text,
  matched_property_id uuid references public.asset_master(asset_id) on delete set null,
  matched_account_id varchar(10) references public.income_expense_account_master(account_id) on delete set null,
  accounting_month date,
  entry_date date,
  amount numeric(14, 0),
  is_manually_resolved boolean not null default false,
  match_status varchar(20) not null default 'action_required'
    check (match_status in ('action_required', 'ready', 'applied', 'ignored')),
  issues text[] not null default '{}',
  raw_payload jsonb not null default '{}'::jsonb check (jsonb_typeof(raw_payload) = 'object'),
  applied_financial_entry_id uuid references public.property_monthly_financial_entry(financial_entry_id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (financial_actual_import_batch_id, source_row_number)
);

create index ix_financial_actual_import_batch_created on public.financial_actual_import_batch(created_at desc);
create index ix_financial_actual_import_row_batch_status on public.financial_actual_import_row(financial_actual_import_batch_id, match_status);
create index ix_financial_actual_import_row_property on public.financial_actual_import_row(matched_property_id) where matched_property_id is not null;
create index ix_financial_actual_import_row_account on public.financial_actual_import_row(matched_account_id) where matched_account_id is not null;
create index ix_financial_actual_import_row_entry on public.financial_actual_import_row(applied_financial_entry_id) where applied_financial_entry_id is not null;

create or replace function public.refresh_financial_actual_import_batch(target_batch_id uuid)
returns void
language plpgsql security invoker
set search_path = public
as $$
declare item public.financial_actual_import_row;
declare issue_list text[];
declare property_matches integer;
declare account_matches integer;
declare resolved_property_id uuid;
declare resolved_account_id varchar(10);
declare resolved_month date;
declare resolved_entry_date date;
declare resolved_amount numeric;
begin
  if not public.current_account_is_active() or public.current_account_role() not in ('admin', 'manager', 'staff') then
    raise exception '取込更新権限がありません';
  end if;
  if not exists (select 1 from public.financial_actual_import_batch where financial_actual_import_batch_id = target_batch_id) then
    raise exception '取込バッチが見つかりません';
  end if;

  for item in
    select * from public.financial_actual_import_row
    where financial_actual_import_batch_id = target_batch_id and match_status not in ('applied', 'ignored')
    order by source_row_number
  loop
    issue_list := '{}';
    resolved_month := public.parse_external_date(item.accounting_month_text);
    if resolved_month is not null then resolved_month := date_trunc('month', resolved_month)::date; end if;
    resolved_entry_date := public.parse_external_date(item.entry_date_text);
    resolved_amount := public.parse_external_amount(item.amount_text);

    if item.is_manually_resolved then
      resolved_property_id := item.matched_property_id;
      resolved_account_id := item.matched_account_id;
    else
      select count(*), min(asset.asset_id::text)::uuid into property_matches, resolved_property_id
      from public.asset_master as asset
      where (item.property_code ~ '^\s*[0-9]+\s*$' and asset.asset_code::text = btrim(item.property_code))
         or (nullif(btrim(item.property_name), '') is not null and (asset.asset_name = btrim(item.property_name) or asset.short_name = btrim(item.property_name)));
      if property_matches <> 1 then resolved_property_id := null; end if;

      select count(*), min(account.account_id) into account_matches, resolved_account_id
      from public.income_expense_account_master as account
      where (nullif(btrim(item.account_id_text), '') is not null and account.account_id = btrim(item.account_id_text))
         or (nullif(btrim(item.account_name), '') is not null and account.account_name = btrim(item.account_name));
      if account_matches <> 1 then resolved_account_id := null; end if;
    end if;

    if resolved_property_id is null then issue_list := array_append(issue_list, '物件を特定できません'); end if;
    if resolved_account_id is null then issue_list := array_append(issue_list, '収支科目を特定できません'); end if;
    if resolved_month is null then issue_list := array_append(issue_list, '計上月を確認してください'); end if;
    if nullif(btrim(coalesce(item.entry_date_text, '')), '') is not null and resolved_entry_date is null then issue_list := array_append(issue_list, '発生日を確認してください'); end if;
    if resolved_amount is null or resolved_amount <= 0 then issue_list := array_append(issue_list, '金額を確認してください'); end if;
    if nullif(btrim(coalesce(item.description, '')), '') is null then issue_list := array_append(issue_list, '内容を入力してください'); end if;
    if length(coalesce(item.description, '')) > 500 then issue_list := array_append(issue_list, '内容は500文字以内にしてください'); end if;
    if length(coalesce(item.counterparty_name, '')) > 200 then issue_list := array_append(issue_list, '相手先は200文字以内にしてください'); end if;

    update public.financial_actual_import_row
       set matched_property_id = resolved_property_id, matched_account_id = resolved_account_id,
           accounting_month = resolved_month, entry_date = resolved_entry_date, amount = resolved_amount,
           issues = issue_list, match_status = case when cardinality(issue_list) = 0 then 'ready' else 'action_required' end,
           updated_at = now()
     where financial_actual_import_row_id = item.financial_actual_import_row_id;
  end loop;

  update public.financial_actual_import_batch as batch
     set row_count = counts.row_count,
         ready_count = counts.ready_count,
         issue_count = counts.issue_count,
         applied_count = counts.applied_count,
         status = case
           when counts.row_count = 0 then 'action_required'
           when counts.issue_count > 0 then 'action_required'
           when counts.ready_count > 0 then 'ready'
           when counts.applied_count = counts.row_count then 'applied'
           else batch.status
         end,
         error_message = null,
         updated_at = now()
  from (
    select count(*)::integer as row_count,
      count(*) filter (where match_status = 'ready')::integer as ready_count,
      count(*) filter (where match_status = 'action_required')::integer as issue_count,
      count(*) filter (where match_status = 'applied')::integer as applied_count
    from public.financial_actual_import_row
    where financial_actual_import_batch_id = target_batch_id
  ) as counts
  where batch.financial_actual_import_batch_id = target_batch_id;
end;
$$;

create or replace function public.resolve_financial_actual_import_row(
  target_row_id uuid,
  target_property_id uuid,
  target_account_id varchar
)
returns void
language plpgsql security invoker
set search_path = public
as $$
declare batch_id uuid;
begin
  if not public.current_account_is_active() or public.current_account_role() not in ('admin', 'manager', 'staff') then
    raise exception '取込更新権限がありません';
  end if;
  if not exists (select 1 from public.asset_master where asset_id = target_property_id) then raise exception '物件が見つかりません'; end if;
  if not exists (select 1 from public.income_expense_account_master where account_id = target_account_id) then raise exception '収支科目が見つかりません'; end if;
  update public.financial_actual_import_row
     set matched_property_id = target_property_id, matched_account_id = target_account_id,
         is_manually_resolved = true, updated_at = now()
   where financial_actual_import_row_id = target_row_id and match_status = 'action_required'
   returning financial_actual_import_batch_id into batch_id;
  if batch_id is null then raise exception '未解決の取込行が見つかりません'; end if;
  perform public.refresh_financial_actual_import_batch(batch_id);
end;
$$;

create or replace function public.apply_financial_actual_import_batch(target_batch_id uuid)
returns integer
language plpgsql security invoker
set search_path = public
as $$
declare applied_rows integer;
begin
  if not public.current_account_is_active() or public.current_account_role() not in ('admin', 'manager', 'staff') then
    raise exception '取込確定権限がありません';
  end if;
  perform public.refresh_financial_actual_import_batch(target_batch_id);
  if exists (
    select 1 from public.financial_actual_import_row
    where financial_actual_import_batch_id = target_batch_id and match_status = 'action_required'
  ) then raise exception '未解決の行があるため確定できません'; end if;
  if not exists (
    select 1 from public.financial_actual_import_row
    where financial_actual_import_batch_id = target_batch_id and match_status = 'ready'
  ) then raise exception '確定対象の行がありません'; end if;

  update public.financial_actual_import_batch set status = 'applying', updated_at = now()
  where financial_actual_import_batch_id = target_batch_id and status in ('ready', 'action_required', 'failed');
  if not found then raise exception 'この取込バッチは確定できません'; end if;

  insert into public.property_monthly_financial_entry (
    property_id, account_id, accounting_month, amount, entry_date, description,
    counterparty_name, notes, source_system, source_record_id
  )
  select row.matched_property_id, row.matched_account_id, row.accounting_month, row.amount,
    row.entry_date, btrim(row.description), nullif(btrim(row.counterparty_name), ''), nullif(btrim(row.notes), ''),
    'financial_actual_import', row.financial_actual_import_row_id
  from public.financial_actual_import_row as row
  where row.financial_actual_import_batch_id = target_batch_id and row.match_status = 'ready'
  on conflict (source_system, source_record_id)
    where source_system is not null and source_record_id is not null
  do update set property_id = excluded.property_id, account_id = excluded.account_id,
    accounting_month = excluded.accounting_month, amount = excluded.amount,
    entry_date = excluded.entry_date, description = excluded.description,
    counterparty_name = excluded.counterparty_name, notes = excluded.notes;

  update public.financial_actual_import_row as row
     set match_status = 'applied',
         applied_financial_entry_id = entry.financial_entry_id,
         updated_at = now()
  from public.property_monthly_financial_entry as entry
  where row.financial_actual_import_batch_id = target_batch_id
    and row.match_status = 'ready'
    and entry.source_system = 'financial_actual_import'
    and entry.source_record_id = row.financial_actual_import_row_id;
  get diagnostics applied_rows = row_count;

  update public.financial_actual_import_batch
     set status = 'applied', applied_count = applied_rows, ready_count = 0, issue_count = 0,
         applied_by = auth.uid(), applied_at = now(), updated_at = now()
   where financial_actual_import_batch_id = target_batch_id;
  return applied_rows;
end;
$$;

alter table public.financial_actual_import_batch enable row level security;
alter table public.financial_actual_import_row enable row level security;

grant select, insert, update, delete on public.financial_actual_import_batch, public.financial_actual_import_row to authenticated;
revoke all on function public.refresh_financial_actual_import_batch(uuid),
  public.resolve_financial_actual_import_row(uuid, uuid, varchar),
  public.apply_financial_actual_import_batch(uuid) from public;
grant execute on function public.refresh_financial_actual_import_batch(uuid),
  public.resolve_financial_actual_import_row(uuid, uuid, varchar),
  public.apply_financial_actual_import_batch(uuid) to authenticated;
grant execute on function public.parse_external_amount(text), public.parse_external_date(text) to authenticated;

create policy "active users read financial import batches" on public.financial_actual_import_batch for select to authenticated
using ((select public.current_account_is_active()));
create policy "staff create financial import batches" on public.financial_actual_import_batch for insert to authenticated
with check ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager', 'staff') and created_by = (select auth.uid()));
create policy "staff update own financial import batches" on public.financial_actual_import_batch for update to authenticated
using ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager', 'staff') and (created_by = (select auth.uid()) or (select public.current_account_role()) in ('admin', 'manager')))
with check ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager', 'staff'));
create policy "managers delete financial import batches" on public.financial_actual_import_batch for delete to authenticated
using ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager'));

create policy "active users read financial import rows" on public.financial_actual_import_row for select to authenticated
using ((select public.current_account_is_active()));
create policy "staff create financial import rows" on public.financial_actual_import_row for insert to authenticated
with check ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager', 'staff') and exists (
  select 1 from public.financial_actual_import_batch as batch
  where batch.financial_actual_import_batch_id = financial_actual_import_row.financial_actual_import_batch_id
    and (batch.created_by = (select auth.uid()) or (select public.current_account_role()) in ('admin', 'manager'))
));
create policy "staff update financial import rows" on public.financial_actual_import_row for update to authenticated
using ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager', 'staff') and exists (
  select 1 from public.financial_actual_import_batch as batch
  where batch.financial_actual_import_batch_id = financial_actual_import_row.financial_actual_import_batch_id
    and (batch.created_by = (select auth.uid()) or (select public.current_account_role()) in ('admin', 'manager'))
))
with check ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager', 'staff') and exists (
  select 1 from public.financial_actual_import_batch as batch
  where batch.financial_actual_import_batch_id = financial_actual_import_row.financial_actual_import_batch_id
    and (batch.created_by = (select auth.uid()) or (select public.current_account_role()) in ('admin', 'manager'))
));

comment on table public.financial_actual_import_batch is '会計実績CSVの取込単位、照合件数、適用履歴を保持する。';
comment on table public.financial_actual_import_row is '会計実績CSVの原文、物件・科目照合、検証結果、適用先を行単位で保持する。';
