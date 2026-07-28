create table if not exists public.appsuite_application (
  app_id varchar(100) primary key,
  app_name text not null,
  app_status varchar(30),
  is_sync_enabled boolean not null default false,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.appsuite_application (app_id, app_name, app_status, is_sync_enabled)
values ('65', '【営業】＜NSR＞オフィス貸室（単区画）新規契約稟議', 'running', true)
on conflict (app_id) do nothing;

create table if not exists public.appsuite_record (
  appsuite_record_id uuid primary key default gen_random_uuid(),
  app_id varchar(100) not null references public.appsuite_application (app_id) on delete restrict,
  data_id varchar(200) not null,
  revision varchar(100),
  workflow_type varchar(100) not null,
  approval_status varchar(100),
  property_name text,
  tenant_name text,
  source_created_at timestamptz,
  source_updated_at timestamptz,
  raw_payload jsonb not null,
  is_present boolean not null default true,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_appsuite_record_source unique (app_id, data_id)
);

create index if not exists ix_appsuite_record_app_present on public.appsuite_record (app_id, is_present);
create index if not exists ix_appsuite_record_workflow_type on public.appsuite_record (workflow_type);

create table if not exists public.appsuite_sync_run (
  appsuite_sync_run_id uuid primary key default gen_random_uuid(),
  app_id varchar(100) references public.appsuite_application (app_id) on delete set null,
  trigger_type varchar(20) not null,
  status varchar(20) not null,
  triggered_by uuid references auth.users (id) on delete set null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  fetched_count integer not null default 0,
  inserted_count integer not null default 0,
  updated_count integer not null default 0,
  unchanged_count integer not null default 0,
  missing_count integer not null default 0,
  error_message text
);

create table if not exists public.appsuite_sync_preview (
  appsuite_sync_preview_id uuid primary key default gen_random_uuid(),
  app_id varchar(100) not null references public.appsuite_application (app_id) on delete restrict,
  created_by uuid not null references auth.users (id) on delete cascade,
  status varchar(20) not null,
  expires_at timestamptz not null,
  snapshot jsonb not null,
  summary jsonb not null,
  error_message text,
  applied_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists ix_appsuite_sync_preview_owner on public.appsuite_sync_preview (created_by, created_at desc);

create or replace function public.claim_appsuite_sync_preview(p_preview_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  preview_row public.appsuite_sync_preview;
begin
  if not public.current_account_is_active() then
    raise exception 'Active account required';
  end if;

  update public.appsuite_sync_preview
     set status = 'expired'
   where appsuite_sync_preview_id = p_preview_id
     and status = 'pending'
     and expires_at <= now();

  update public.appsuite_sync_preview
     set status = 'applying', error_message = null
   where appsuite_sync_preview_id = p_preview_id
     and created_by = auth.uid()
     and status = 'pending'
     and expires_at > now()
  returning * into preview_row;

  if preview_row.appsuite_sync_preview_id is null then
    raise exception 'Preview unavailable, expired, or already applied';
  end if;

  return jsonb_build_object('preview_id', preview_row.appsuite_sync_preview_id, 'app_id', preview_row.app_id, 'snapshot', preview_row.snapshot, 'summary', preview_row.summary);
end;
$$;

alter table public.appsuite_application enable row level security;
alter table public.appsuite_record enable row level security;
alter table public.appsuite_sync_run enable row level security;
alter table public.appsuite_sync_preview enable row level security;

grant select on public.appsuite_application, public.appsuite_sync_run, public.appsuite_sync_preview to authenticated;
grant update, insert, delete on public.appsuite_application to authenticated;
grant execute on function public.claim_appsuite_sync_preview(uuid) to authenticated;
grant select, insert, update, delete on public.appsuite_application, public.appsuite_record, public.appsuite_sync_run, public.appsuite_sync_preview to service_role;

drop policy if exists "active users read AppSuite applications" on public.appsuite_application;
create policy "active users read AppSuite applications"
  on public.appsuite_application for select to authenticated using (public.current_account_is_active());
drop policy if exists "admins manage AppSuite applications" on public.appsuite_application;
create policy "admins manage AppSuite applications"
  on public.appsuite_application for all to authenticated using (public.current_account_is_admin()) with check (public.current_account_is_admin());
drop policy if exists "active users read AppSuite runs" on public.appsuite_sync_run;
create policy "active users read AppSuite runs"
  on public.appsuite_sync_run for select to authenticated using (public.current_account_is_active());
drop policy if exists "users read own AppSuite previews" on public.appsuite_sync_preview;
create policy "users read own AppSuite previews"
  on public.appsuite_sync_preview for select to authenticated using (created_by = auth.uid());

drop trigger if exists set_appsuite_application_updated_at on public.appsuite_application;
create trigger set_appsuite_application_updated_at before update on public.appsuite_application for each row execute procedure public.set_updated_at();
drop trigger if exists set_appsuite_record_updated_at on public.appsuite_record;
create trigger set_appsuite_record_updated_at before update on public.appsuite_record for each row execute procedure public.set_updated_at();
