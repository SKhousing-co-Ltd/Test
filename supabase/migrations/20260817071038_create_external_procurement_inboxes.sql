-- AppSuite repair approvals and Bill One invoices are staged, matched, and explicitly committed.
create table public.appsuite_procurement_inbox (
  appsuite_procurement_inbox_id uuid primary key default gen_random_uuid(),
  appsuite_record_id uuid not null references public.appsuite_record (appsuite_record_id) on delete cascade,
  line_number smallint not null check (line_number between 1 and 3),
  ringi_number varchar(100),
  property_code varchar(100),
  property_name varchar(200),
  vendor_name varchar(200),
  title varchar(300),
  description text,
  gross_amount numeric(14, 0),
  expected_payment_date date,
  matched_property_id uuid references public.asset_master (asset_id) on delete set null,
  matched_vendor_id uuid references public.vendor_master (vendor_id) on delete set null,
  matched_account_id varchar(10) references public.income_expense_account_master (account_id) on delete set null,
  match_status varchar(20) not null default 'action_required'
    check (match_status in ('action_required', 'ready', 'imported', 'ignored')),
  issues text[] not null default '{}',
  imported_procurement_order_id uuid references public.procurement_order (procurement_order_id) on delete set null,
  source_payload jsonb not null default '{}'::jsonb check (jsonb_typeof(source_payload) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (appsuite_record_id, line_number)
);

alter table public.procurement_order
  add column if not exists appsuite_record_id uuid references public.appsuite_record (appsuite_record_id) on delete set null,
  add column if not exists appsuite_line_number smallint;

create unique index if not exists uq_procurement_order_appsuite_source
  on public.procurement_order (appsuite_record_id, appsuite_line_number)
  where appsuite_record_id is not null and appsuite_line_number is not null;

create table public.billone_invoice_inbox (
  billone_invoice_inbox_id uuid primary key default gen_random_uuid(),
  source_invoice_id varchar(100) not null unique,
  invoice_number varchar(100),
  supplier_id varchar(100),
  supplier_name varchar(200),
  invoice_date date,
  received_date date not null default current_date,
  due_date date,
  subtotal_amount numeric(14, 0),
  tax_amount numeric(14, 0),
  gross_amount numeric(14, 0),
  document_url text,
  order_number varchar(100),
  ringi_number varchar(100),
  property_code varchar(100),
  property_name varchar(200),
  account_id varchar(10),
  matched_property_id uuid references public.asset_master (asset_id) on delete set null,
  matched_vendor_id uuid references public.vendor_master (vendor_id) on delete set null,
  matched_account_id varchar(10) references public.income_expense_account_master (account_id) on delete set null,
  matched_procurement_order_id uuid references public.procurement_order (procurement_order_id) on delete set null,
  match_status varchar(20) not null default 'action_required'
    check (match_status in ('action_required', 'ready', 'imported', 'ignored')),
  issues text[] not null default '{}',
  imported_vendor_invoice_id uuid references public.vendor_invoice (vendor_invoice_id) on delete set null,
  raw_payload jsonb not null default '{}'::jsonb check (jsonb_typeof(raw_payload) = 'object'),
  first_received_at timestamptz not null default now(),
  last_received_at timestamptz not null default now(),
  imported_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_billone_inbox_amounts check (
    gross_amount is null or subtotal_amount is null or tax_amount is null or gross_amount = subtotal_amount + tax_amount
  )
);

create index ix_appsuite_procurement_inbox_status on public.appsuite_procurement_inbox (match_status, updated_at desc);
create index ix_appsuite_procurement_inbox_property on public.appsuite_procurement_inbox (matched_property_id) where matched_property_id is not null;
create index ix_appsuite_procurement_inbox_vendor on public.appsuite_procurement_inbox (matched_vendor_id) where matched_vendor_id is not null;
create index ix_appsuite_procurement_inbox_order on public.appsuite_procurement_inbox (imported_procurement_order_id) where imported_procurement_order_id is not null;
create index ix_billone_invoice_inbox_status on public.billone_invoice_inbox (match_status, last_received_at desc);
create index ix_billone_invoice_inbox_property on public.billone_invoice_inbox (matched_property_id) where matched_property_id is not null;
create index ix_billone_invoice_inbox_vendor on public.billone_invoice_inbox (matched_vendor_id) where matched_vendor_id is not null;
create index ix_billone_invoice_inbox_account on public.billone_invoice_inbox (matched_account_id) where matched_account_id is not null;
create index ix_billone_invoice_inbox_order on public.billone_invoice_inbox (matched_procurement_order_id) where matched_procurement_order_id is not null;
create index ix_billone_invoice_inbox_imported on public.billone_invoice_inbox (imported_vendor_invoice_id) where imported_vendor_invoice_id is not null;

create or replace function public.appsuite_text_value(payload jsonb, field_name text)
returns text
language sql immutable parallel safe
set search_path = public
as $$
  select nullif(btrim(coalesce(payload -> field_name ->> 'val', payload ->> field_name)), '')
$$;

create or replace function public.parse_external_amount(value text)
returns numeric
language sql immutable parallel safe
set search_path = public
as $$
  select case
    when nullif(regexp_replace(coalesce(value, ''), '[^0-9.-]', '', 'g'), '') is null then null
    else regexp_replace(value, '[^0-9.-]', '', 'g')::numeric
  end
$$;

create or replace function public.parse_external_date(value text)
returns date
language plpgsql immutable
set search_path = public
as $$
declare normalized text := btrim(coalesce(value, ''));
begin
  if normalized = '' then return null; end if;
  normalized := replace(replace(replace(normalized, '年', '-'), '月', '-'), '日', '');
  normalized := replace(normalized, '/', '-');
  begin return normalized::date; exception when others then return null; end;
end;
$$;

create or replace function public.reconcile_appsuite_procurement_inbox(target_id uuid)
returns void
language plpgsql
set search_path = public
as $$
declare item public.appsuite_procurement_inbox;
declare issue_list text[] := '{}';
declare property_matches integer := 0;
declare vendor_matches integer := 0;
declare property_id uuid;
declare vendor_id uuid;
begin
  select * into item from public.appsuite_procurement_inbox where appsuite_procurement_inbox_id = target_id;
  if not found or item.match_status in ('imported', 'ignored') then return; end if;

  select count(*), min(asset_id) into property_matches, property_id
  from public.asset_master
  where (item.property_code is not null and asset_code::text = regexp_replace(item.property_code, '[^0-9]', '', 'g'))
     or (item.property_name is not null and (asset_name = item.property_name or short_name = item.property_name));
  if property_matches <> 1 then issue_list := array_append(issue_list, case when property_matches = 0 then '物件を特定できません' else '物件候補が複数あります' end); end if;

  select count(*), min(vendor_id) into vendor_matches, vendor_id
  from public.vendor_master
  where is_active and item.vendor_name is not null
    and regexp_replace(lower(vendor_name), '[[:space:]　株式会社（）()]', '', 'g') = regexp_replace(lower(item.vendor_name), '[[:space:]　株式会社（）()]', '', 'g');
  if vendor_matches <> 1 then issue_list := array_append(issue_list, case when vendor_matches = 0 then '取引先を登録してください' else '取引先候補が複数あります' end); end if;
  if item.gross_amount is null or item.gross_amount <= 0 then issue_list := array_append(issue_list, '発注金額を確認してください'); end if;
  if item.title is null then issue_list := array_append(issue_list, '発注内容を確認してください'); end if;

  update public.appsuite_procurement_inbox
     set matched_property_id = case when property_matches = 1 then property_id else null end,
         matched_vendor_id = case when vendor_matches = 1 then vendor_id else null end,
         matched_account_id = 'M08', issues = issue_list,
         match_status = case when cardinality(issue_list) = 0 then 'ready' else 'action_required' end,
         updated_at = now()
   where appsuite_procurement_inbox_id = target_id;
end;
$$;

create or replace function public.stage_appsuite_procurement_record()
returns trigger
language plpgsql
set search_path = public
as $$
declare line_no integer;
declare vendor_value text;
declare amount_value numeric;
declare title_value text;
declare inbox_id uuid;
begin
  if new.app_id <> '87' or not new.is_present or coalesce(new.approval_status, '') not in ('完了', '承認', '決裁済み') then return new; end if;
  for line_no in 1..3 loop
    vendor_value := public.appsuite_text_value(new.raw_payload, format('発注業者%s', line_no));
    if vendor_value is null and line_no = 1 then vendor_value := public.appsuite_text_value(new.raw_payload, '発注先'); end if;
    amount_value := public.parse_external_amount(public.appsuite_text_value(new.raw_payload, format('発注金額%s（税込）', line_no)));
    title_value := coalesce(public.appsuite_text_value(new.raw_payload, format('発注内容%s', line_no)), public.appsuite_text_value(new.raw_payload, '不具合内容'), public.appsuite_text_value(new.raw_payload, '詳細'));
    if vendor_value is not null or amount_value is not null then
      insert into public.appsuite_procurement_inbox (
        appsuite_record_id, line_number, ringi_number, property_code, property_name,
        vendor_name, title, description, gross_amount, expected_payment_date, source_payload
      ) values (
        new.appsuite_record_id, line_no, new.ringi_number,
        public.appsuite_text_value(new.raw_payload, '物件コード'),
        coalesce(public.appsuite_text_value(new.raw_payload, '建物名称'), public.appsuite_text_value(new.raw_payload, '物件名')),
        vendor_value, title_value, public.appsuite_text_value(new.raw_payload, '詳細'), amount_value,
        public.parse_external_date(public.appsuite_text_value(new.raw_payload, format('支払予定日%s', line_no))), new.raw_payload
      )
      on conflict (appsuite_record_id, line_number) do update set
        ringi_number = excluded.ringi_number, property_code = excluded.property_code, property_name = excluded.property_name,
        vendor_name = excluded.vendor_name, title = excluded.title, description = excluded.description,
        gross_amount = excluded.gross_amount, expected_payment_date = excluded.expected_payment_date,
        source_payload = excluded.source_payload, updated_at = now()
      where public.appsuite_procurement_inbox.match_status not in ('imported', 'ignored')
      returning appsuite_procurement_inbox_id into inbox_id;
      if inbox_id is not null then perform public.reconcile_appsuite_procurement_inbox(inbox_id); end if;
    end if;
  end loop;
  return new;
end;
$$;

create trigger stage_appsuite_procurement_record
after insert or update of raw_payload, approval_status, is_present, ringi_number on public.appsuite_record
for each row execute function public.stage_appsuite_procurement_record();

create or replace function public.reconcile_billone_invoice_inbox(target_id uuid)
returns void
language plpgsql
set search_path = public
as $$
declare item public.billone_invoice_inbox;
declare issue_list text[] := '{}';
declare property_matches integer := 0;
declare vendor_matches integer := 0;
declare order_matches integer := 0;
declare property_id uuid;
declare vendor_id uuid;
declare resolved_account_id varchar(10);
declare order_id uuid;
begin
  select * into item from public.billone_invoice_inbox where billone_invoice_inbox_id = target_id;
  if not found or item.match_status in ('imported', 'ignored') then return; end if;

  select count(*), min(procurement_order_id) into order_matches, order_id
  from public.procurement_order
  where (item.order_number is not null and order_number = item.order_number)
     or (item.ringi_number is not null and appsuite_ringi_number = item.ringi_number);
  if order_matches = 1 then
    select property_id, vendor_id, account_id into property_id, vendor_id, resolved_account_id
      from public.procurement_order where procurement_order_id = order_id;
  else
    select count(*), min(asset_id) into property_matches, property_id from public.asset_master
      where (item.property_code is not null and asset_code::text = regexp_replace(item.property_code, '[^0-9]', '', 'g'))
         or (item.property_name is not null and (asset_name = item.property_name or short_name = item.property_name));
    select count(*), min(vendor_id) into vendor_matches, vendor_id from public.vendor_master
      where is_active and ((item.supplier_id is not null and billone_supplier_id = item.supplier_id)
        or (item.supplier_name is not null and regexp_replace(lower(vendor_name), '[[:space:]　株式会社（）()]', '', 'g') = regexp_replace(lower(item.supplier_name), '[[:space:]　株式会社（）()]', '', 'g')));
    resolved_account_id := item.account_id;
    if property_matches <> 1 then property_id := null; end if;
    if vendor_matches <> 1 then vendor_id := null; end if;
  end if;

  if property_id is null then issue_list := array_append(issue_list, '物件を特定できません'); end if;
  if vendor_id is null then issue_list := array_append(issue_list, '取引先を特定できません'); end if;
  if resolved_account_id is null or not exists (select 1 from public.income_expense_account_master where account_id = resolved_account_id) then issue_list := array_append(issue_list, '収支科目を特定できません'); end if;
  if item.invoice_date is null then issue_list := array_append(issue_list, '請求日を確認してください'); end if;
  if item.due_date is null or (item.invoice_date is not null and item.due_date < item.invoice_date) then issue_list := array_append(issue_list, '支払期日を確認してください'); end if;
  if item.gross_amount is null or item.gross_amount <= 0 then issue_list := array_append(issue_list, '請求金額を確認してください'); end if;
  if coalesce(item.subtotal_amount, 0) + coalesce(item.tax_amount, 0) <> coalesce(item.gross_amount, -1) then issue_list := array_append(issue_list, '税抜額・消費税・税込額が一致しません'); end if;

  update public.billone_invoice_inbox
     set matched_property_id = property_id, matched_vendor_id = vendor_id,
         matched_account_id = resolved_account_id,
         matched_procurement_order_id = case when order_matches = 1 then order_id else null end,
         issues = issue_list, match_status = case when cardinality(issue_list) = 0 then 'ready' else 'action_required' end,
         updated_at = now()
   where billone_invoice_inbox_id = target_id;
end;
$$;

create or replace function public.refresh_external_procurement_inboxes()
returns void
language plpgsql security invoker
set search_path = public
as $$
declare target_id uuid;
begin
  if not public.current_account_is_active() or public.current_account_role() not in ('admin', 'manager', 'staff') then raise exception '更新権限がありません'; end if;
  for target_id in select appsuite_procurement_inbox_id from public.appsuite_procurement_inbox where match_status = 'action_required'
  loop perform public.reconcile_appsuite_procurement_inbox(target_id); end loop;
  for target_id in select billone_invoice_inbox_id from public.billone_invoice_inbox where match_status = 'action_required'
  loop perform public.reconcile_billone_invoice_inbox(target_id); end loop;
end;
$$;

create or replace function public.commit_appsuite_procurement_inbox(target_id uuid)
returns uuid
language plpgsql security invoker
set search_path = public
as $$
declare item public.appsuite_procurement_inbox;
declare record_item public.appsuite_record;
declare order_id uuid;
begin
  if not public.current_account_is_active() or public.current_account_role() not in ('admin', 'manager', 'staff') then raise exception '登録権限がありません'; end if;
  select * into item from public.appsuite_procurement_inbox where appsuite_procurement_inbox_id = target_id for update;
  if not found or item.match_status <> 'ready' then raise exception '照合が完了した発注だけ登録できます'; end if;
  select * into record_item from public.appsuite_record where appsuite_record_id = item.appsuite_record_id;
  insert into public.procurement_order (
    property_id, account_id, vendor_id, order_type, title, description, gross_amount,
    expected_payment_date, status, appsuite_app_id, appsuite_ringi_number, appsuite_record_id, appsuite_line_number, notes
  ) values (
    item.matched_property_id, item.matched_account_id, item.matched_vendor_id, 'repair', item.title, item.description, item.gross_amount,
    item.expected_payment_date, 'approved', record_item.app_id, item.ringi_number, item.appsuite_record_id, item.line_number,
    'AppSuiteの決裁済み修繕発注稟議から登録'
  ) returning procurement_order_id into order_id;
  update public.appsuite_procurement_inbox set match_status = 'imported', imported_procurement_order_id = order_id, updated_at = now()
  where appsuite_procurement_inbox_id = target_id;
  return order_id;
end;
$$;

create or replace function public.commit_billone_invoice_inbox(target_id uuid)
returns uuid
language plpgsql security invoker
set search_path = public
as $$
declare item public.billone_invoice_inbox;
declare invoice_id uuid;
begin
  if not public.current_account_is_active() or public.current_account_role() not in ('admin', 'manager', 'staff') then raise exception '登録権限がありません'; end if;
  select * into item from public.billone_invoice_inbox where billone_invoice_inbox_id = target_id for update;
  if not found or item.match_status <> 'ready' then raise exception '照合が完了した請求書だけ登録できます'; end if;
  invoice_id := public.register_vendor_invoice(
    item.matched_property_id, item.matched_account_id, item.matched_vendor_id, item.invoice_number, item.source_invoice_id,
    item.invoice_date, item.due_date, date_trunc('month', item.invoice_date)::date,
    item.subtotal_amount, item.tax_amount, item.matched_procurement_order_id, 'Bill One連携受信APIから登録'
  );
  update public.vendor_invoice set billone_document_url = item.document_url where vendor_invoice_id = invoice_id;
  update public.billone_invoice_inbox set match_status = 'imported', imported_vendor_invoice_id = invoice_id, imported_at = now(), updated_at = now()
  where billone_invoice_inbox_id = target_id;
  return invoice_id;
end;
$$;

alter table public.appsuite_procurement_inbox enable row level security;
alter table public.billone_invoice_inbox enable row level security;

grant select, insert, update, delete on public.appsuite_procurement_inbox, public.billone_invoice_inbox to authenticated, service_role;
revoke all on function public.appsuite_text_value(jsonb, text), public.parse_external_amount(text), public.parse_external_date(text),
  public.reconcile_appsuite_procurement_inbox(uuid), public.reconcile_billone_invoice_inbox(uuid),
  public.stage_appsuite_procurement_record(), public.refresh_external_procurement_inboxes(),
  public.commit_appsuite_procurement_inbox(uuid), public.commit_billone_invoice_inbox(uuid) from public;
grant execute on function public.reconcile_appsuite_procurement_inbox(uuid), public.reconcile_billone_invoice_inbox(uuid),
  public.refresh_external_procurement_inboxes(), public.commit_appsuite_procurement_inbox(uuid), public.commit_billone_invoice_inbox(uuid) to authenticated;
grant execute on function public.appsuite_text_value(jsonb, text), public.parse_external_amount(text), public.parse_external_date(text),
  public.reconcile_appsuite_procurement_inbox(uuid), public.reconcile_billone_invoice_inbox(uuid) to service_role;

create policy "active users read AppSuite procurement inbox" on public.appsuite_procurement_inbox for select to authenticated
using ((select public.current_account_is_active()));
create policy "staff update AppSuite procurement inbox" on public.appsuite_procurement_inbox for update to authenticated
using ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager', 'staff'))
with check ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager', 'staff'));
create policy "service role manages AppSuite procurement inbox" on public.appsuite_procurement_inbox for all to service_role using (true) with check (true);

create policy "active users read Bill One invoice inbox" on public.billone_invoice_inbox for select to authenticated
using ((select public.current_account_is_active()));
create policy "staff update Bill One invoice inbox" on public.billone_invoice_inbox for update to authenticated
using ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager', 'staff'))
with check ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager', 'staff'));
create policy "service role manages Bill One invoice inbox" on public.billone_invoice_inbox for all to service_role using (true) with check (true);

comment on table public.appsuite_procurement_inbox is 'AppSuiteの決裁済み修繕発注を、物件・取引先・科目照合後に発注へ反映する受信箱。';
comment on table public.billone_invoice_inbox is 'Bill Oneまたは連携サービスから受信した請求書を、発注・物件・取引先・科目照合後に確定する受信箱。';

update public.appsuite_application set is_sync_enabled = true where app_id = '87';
