-- Word/DOCX based contract-document generation and immutable output history.
alter table public.contract_document_template_revision
  add column if not exists generation_engine text not null default 'acroform_legacy',
  add column if not exists template_docx_file_path text,
  add column if not exists document_generation_schema jsonb not null default '{}'::jsonb,
  add constraint ck_contract_document_template_revision_generation_engine
    check (generation_engine in ('acroform_legacy', 'document_generation')),
  add constraint ck_contract_document_template_revision_generation_schema
    check (jsonb_typeof(document_generation_schema) = 'object');

alter table public.lease_contract_document
  add column if not exists content_version bigint not null default 1,
  add column if not exists latest_word_output_revision_id uuid,
  add column if not exists latest_formal_output_revision_id uuid;

create table if not exists public.lease_contract_document_output_revision (
  lease_contract_document_output_revision_id uuid primary key default gen_random_uuid(),
  lease_contract_document_id uuid not null references public.lease_contract_document(lease_contract_document_id) on delete cascade,
  contract_document_template_revision_id uuid not null references public.contract_document_template_revision(contract_document_template_revision_id),
  content_version bigint not null check (content_version > 0),
  status text not null check (status in ('word_generated', 'formalized', 'failed')),
  word_file_path text,
  pdf_file_path text,
  error_summary text,
  generated_by uuid references auth.users(id),
  generated_at timestamptz not null default now(),
  formalized_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_contract_output_revision_word_required check (
    status = 'failed' or word_file_path is not null
  ),
  constraint ck_contract_output_revision_pdf_formalized check (
    (status = 'formalized') = (pdf_file_path is not null)
  ),
  unique (lease_contract_document_id, content_version)
);

alter table public.lease_contract_document
  add constraint fk_contract_document_latest_word_output
    foreign key (latest_word_output_revision_id)
    references public.lease_contract_document_output_revision(lease_contract_document_output_revision_id)
    on delete set null,
  add constraint fk_contract_document_latest_formal_output
    foreign key (latest_formal_output_revision_id)
    references public.lease_contract_document_output_revision(lease_contract_document_output_revision_id)
    on delete set null;

create index if not exists ix_contract_document_output_revision_document
  on public.lease_contract_document_output_revision(lease_contract_document_id, content_version desc);

create or replace function public.bump_lease_contract_document_content_version()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  if row(NEW.document_type, NEW.contract_document_template_revision_id, NEW.field_values,
         NEW.workflow_defaults, NEW.manually_edited_fields, NEW.desknets_application_id,
         NEW.terms_text, NEW.restoration_criteria_text)
     is distinct from
     row(OLD.document_type, OLD.contract_document_template_revision_id, OLD.field_values,
         OLD.workflow_defaults, OLD.manually_edited_fields, OLD.desknets_application_id,
         OLD.terms_text, OLD.restoration_criteria_text) then
    NEW.content_version := OLD.content_version + 1;
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_bump_lease_contract_document_content_version on public.lease_contract_document;
create trigger trg_bump_lease_contract_document_content_version
before update on public.lease_contract_document
for each row execute function public.bump_lease_contract_document_content_version();

create or replace function public.bump_contract_document_version_from_plan()
returns trigger language plpgsql security invoker set search_path = public as $$
declare target_document_id uuid := coalesce(NEW.lease_contract_document_id, OLD.lease_contract_document_id);
begin
  update public.lease_contract_document
  set content_version = content_version + 1
  where lease_contract_document_id = target_document_id;
  return coalesce(NEW, OLD);
end;
$$;

drop trigger if exists trg_bump_contract_document_version_from_plan on public.lease_contract_document_plan;
create trigger trg_bump_contract_document_version_from_plan
after insert or update or delete on public.lease_contract_document_plan
for each row execute function public.bump_contract_document_version_from_plan();

alter table public.lease_contract_document_output_revision enable row level security;
grant select, insert, update on public.lease_contract_document_output_revision to authenticated;
create policy "active users manage contract document output revisions"
on public.lease_contract_document_output_revision for all to authenticated
using (public.current_account_is_active())
with check (public.current_account_is_active());

create trigger trg_contract_document_output_revision_updated_at
before update on public.lease_contract_document_output_revision
for each row execute function public.set_updated_at();

-- Publish a Word-generation revision for ordinary leases. Existing contracts
-- remain pinned to their legacy revision; only the known demo contract is
-- explicitly moved to the new revision.
with template_row as (
  select contract_document_template_id
  from public.contract_document_template
  where document_type = 'ordinary_lease'
), source_revision as (
  select revision.*
  from public.contract_document_template_revision revision
  join template_row on template_row.contract_document_template_id = revision.contract_document_template_id
  order by revision.revision_no desc
  limit 1
), inserted as (
  insert into public.contract_document_template_revision (
    contract_document_template_id, revision_no, status, generation_engine,
    template_docx_file_path, document_generation_schema, field_definitions,
    layout_definition, block_definitions, default_terms_text,
    default_restoration_criteria_text, created_by, published_at
  )
  select source.contract_document_template_id,
    source.revision_no + 1,
    'published',
    'document_generation',
    'templates/ordinary_lease/ordinary_lease_document_generation_v1.docx',
    '{"templateVersion":"ordinary_lease_docx_v1","planImageKey":"planImage"}'::jsonb,
    source.field_definitions, source.layout_definition,
    jsonb_set(jsonb_set(source.block_definitions, '{terms,acroformFieldName}', 'null'::jsonb, true), '{restoration,acroformFieldName}', 'null'::jsonb, true),
    source.default_terms_text, source.default_restoration_criteria_text,
    source.created_by, now()
  from source_revision source
  where not exists (
    select 1 from public.contract_document_template_revision existing
    where existing.contract_document_template_id = source.contract_document_template_id
      and existing.generation_engine = 'document_generation'
  )
  returning contract_document_template_revision_id, contract_document_template_id
)
update public.contract_document_template template
set active_revision_id = inserted.contract_document_template_revision_id
from inserted
where template.contract_document_template_id = inserted.contract_document_template_id;

update public.lease_contract_document document
set contract_document_template_revision_id = revision.contract_document_template_revision_id
from public.contract_document_template_revision revision
where document.lease_contract_id = '234fbe6a-4c74-484f-8a33-dfc6178234d9'
  and revision.generation_engine = 'document_generation'
  and revision.contract_document_template_id = (
    select contract_document_template_id from public.contract_document_template where document_type = 'ordinary_lease'
  );
