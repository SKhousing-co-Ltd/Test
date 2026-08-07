-- レントロール契約に紐づく契約書（初回は普通賃貸借契約書）の管理

create table if not exists public.lease_contract_document (
  lease_contract_document_id uuid primary key default gen_random_uuid(),
  lease_contract_id uuid not null unique references public.lease_contract (lease_contract_id) on delete cascade,
  document_type varchar(50) not null default 'ordinary_lease',
  field_values jsonb not null default '{}'::jsonb,
  workflow_defaults jsonb not null default '{}'::jsonb,
  manually_edited_fields jsonb not null default '[]'::jsonb,
  desknets_application_id varchar(200),
  desknets_retrieved_at timestamptz,
  desknets_source_payload jsonb,
  pdf_file_path text,
  pdf_generated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_lease_contract_document_type check (document_type in ('ordinary_lease')),
  constraint ck_lease_contract_document_values check (jsonb_typeof(field_values) = 'object'),
  constraint ck_lease_contract_document_defaults check (jsonb_typeof(workflow_defaults) = 'object'),
  constraint ck_lease_contract_document_manual_fields check (jsonb_typeof(manually_edited_fields) = 'array')
);

create index if not exists ix_lease_contract_document_application
  on public.lease_contract_document (desknets_application_id)
  where desknets_application_id is not null;

comment on table public.lease_contract_document is 'レントロール契約ごとの契約書データと最新版PDFの保管情報。';
comment on column public.lease_contract_document.field_values is '編集後の契約書差し込み値。';
comment on column public.lease_contract_document.workflow_defaults is 'デスクネッツから取得した初期値。';
comment on column public.lease_contract_document.manually_edited_fields is '利用者が手修正した差し込み項目キーの配列。';

drop trigger if exists set_lease_contract_document_updated_at on public.lease_contract_document;
create trigger set_lease_contract_document_updated_at
before update on public.lease_contract_document
for each row execute procedure public.set_updated_at();

alter table public.lease_contract_document enable row level security;
grant select, insert, update on public.lease_contract_document to authenticated;

create policy "active users manage lease contract documents"
  on public.lease_contract_document for all to authenticated
  using (public.current_account_is_active())
  with check (public.current_account_is_active());

insert into storage.buckets (id, name, public)
values ('contract-documents', 'contract-documents', false)
on conflict (id) do nothing;

drop policy if exists "active users read contract document files" on storage.objects;
create policy "active users read contract document files"
  on storage.objects for select to authenticated
  using (bucket_id = 'contract-documents' and public.current_account_is_active());

drop policy if exists "active users upload contract document files" on storage.objects;
create policy "active users upload contract document files"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'contract-documents' and public.current_account_is_active());

drop policy if exists "active users update contract document files" on storage.objects;
create policy "active users update contract document files"
  on storage.objects for update to authenticated
  using (bucket_id = 'contract-documents' and public.current_account_is_active())
  with check (bucket_id = 'contract-documents' and public.current_account_is_active());
