create table public.revenue_posting_batch (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.asset_master(asset_id),
  billing_month date not null,
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now()
);
create table public.revenue_posting_source (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.asset_master(asset_id),
  billing_month date not null,
  source_kind text not null check (source_kind in ('monthly','spot')),
  source_key text not null,
  version integer not null,
  invoice_snapshot jsonb not null,
  confirmed_batch_id uuid not null references public.revenue_posting_batch(id),
  confirmed_at timestamptz not null default now(),
  confirmed_by uuid not null default auth.uid() references auth.users(id),
  released_at timestamptz,
  released_by uuid references auth.users(id),
  unique(asset_id, billing_month, source_kind, source_key, version)
);
create unique index revenue_posting_source_active_idx on public.revenue_posting_source(asset_id,source_kind,source_key) where released_at is null;
create table public.revenue_posting_entry (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.revenue_posting_source(id),
  posting_month date not null,
  sort_order integer not null,
  csv_cells jsonb not null check (jsonb_typeof(csv_cells) = 'array' and jsonb_array_length(csv_cells) = 31),
  is_immediate boolean not null,
  exported_batch_id uuid references public.revenue_posting_batch(id),
  exported_at timestamptz,
  cancelled_at timestamptz
);
create index revenue_posting_entry_due_idx on public.revenue_posting_entry(posting_month,source_id) where exported_at is null and cancelled_at is null;
alter table public.revenue_posting_batch enable row level security;
alter table public.revenue_posting_source enable row level security;
alter table public.revenue_posting_entry enable row level security;
grant select on public.revenue_posting_batch, public.revenue_posting_source, public.revenue_posting_entry to authenticated;
create policy revenue_posting_batch_read on public.revenue_posting_batch for select to authenticated using (public.current_account_is_active());
create policy revenue_posting_source_read on public.revenue_posting_source for select to authenticated using (public.current_account_is_active());
create policy revenue_posting_entry_read on public.revenue_posting_entry for select to authenticated using (public.current_account_is_active());

create function public.confirm_revenue_posting_export(p_asset_id uuid, p_billing_month date, p_sources jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  batch_id uuid;
  src jsonb;
  entry jsonb;
  source_id uuid;
  next_version integer;
  row_number integer;
  source_count integer := 0;
  row_count integer;
  output_rows jsonb;
begin
  if not public.current_account_is_active() then raise exception '利用権限がありません'; end if;
  if p_billing_month <> date_trunc('month', p_billing_month)::date then raise exception '計上月が不正です'; end if;
  if jsonb_typeof(p_sources) <> 'array' then raise exception '請求データが不正です'; end if;
  perform pg_advisory_xact_lock(hashtext(p_asset_id::text));
  insert into public.revenue_posting_batch(asset_id,billing_month,created_by) values (p_asset_id,p_billing_month,auth.uid()) returning id into batch_id;
  for src in select value from jsonb_array_elements(p_sources) loop
    if src->>'sourceKind' not in ('monthly','spot') or nullif(src->>'sourceKey','') is null or jsonb_typeof(src->'entries') <> 'array' then raise exception '請求データが不正です'; end if;
    select coalesce(max(version),0)+1 into next_version from public.revenue_posting_source where asset_id=p_asset_id and billing_month=p_billing_month and source_kind=src->>'sourceKind' and source_key=src->>'sourceKey';
    insert into public.revenue_posting_source(asset_id,billing_month,source_kind,source_key,version,invoice_snapshot,confirmed_batch_id,confirmed_by)
    values (p_asset_id,p_billing_month,src->>'sourceKind',src->>'sourceKey',next_version,src->'snapshot',batch_id,auth.uid()) returning id into source_id;
    row_number := 0;
    for entry in select value from jsonb_array_elements(src->'entries') loop
      row_number := row_number + 1;
      if jsonb_typeof(entry->'cells') <> 'array' or jsonb_array_length(entry->'cells') <> 31 then raise exception '仕訳行が不正です'; end if;
      insert into public.revenue_posting_entry(source_id,posting_month,sort_order,csv_cells,is_immediate,exported_batch_id,exported_at)
      values (source_id,(entry->>'postingMonth')::date,row_number,entry->'cells',(entry->>'immediate')::boolean,
        case when (entry->>'immediate')::boolean then batch_id else null end,
        case when (entry->>'immediate')::boolean then now() else null end);
    end loop;
    source_count := source_count + 1;
  end loop;
  update public.revenue_posting_entry e set exported_batch_id=batch_id, exported_at=now()
  from public.revenue_posting_source s
  where e.source_id=s.id and s.asset_id=p_asset_id and s.released_at is null
    and e.is_immediate=false and e.exported_at is null and e.cancelled_at is null
    and e.posting_month<=p_billing_month;
  select count(*),coalesce(jsonb_agg(e.csv_cells order by s.billing_month,s.source_key,e.sort_order),'[]'::jsonb)
    into row_count,output_rows from public.revenue_posting_entry e join public.revenue_posting_source s on s.id=e.source_id where e.exported_batch_id=batch_id;
  if row_count=0 then raise exception '出力対象の仕訳がありません'; end if;
  return jsonb_build_object('batchId',batch_id,'sourceCount',source_count,'rows',output_rows);
end; $$;
revoke all on function public.confirm_revenue_posting_export(uuid,date,jsonb) from public;
grant execute on function public.confirm_revenue_posting_export(uuid,date,jsonb) to authenticated;

create function public.release_revenue_posting_source(p_source_id uuid)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.current_account_is_active() then raise exception '利用権限がありません'; end if;
  update public.revenue_posting_source set released_at=now(),released_by=auth.uid() where id=p_source_id and released_at is null;
  if not found then return false; end if;
  update public.revenue_posting_entry set cancelled_at=now() where source_id=p_source_id and exported_at is null;
  return true;
end; $$;
revoke all on function public.release_revenue_posting_source(uuid) from public;
grant execute on function public.release_revenue_posting_source(uuid) to authenticated;
