-- Publish the revised ordinary-lease template without mutating the v2
-- template referenced by already-generated Word/PDF output history.
with template_row as (
  select contract_document_template_id
  from public.contract_document_template
  where document_type = 'ordinary_lease'
), source_revision as (
  select revision.*
  from public.contract_document_template_revision revision
  join template_row on template_row.contract_document_template_id = revision.contract_document_template_id
  where revision.generation_engine = 'document_generation'
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
    'templates/ordinary_lease/ordinary_lease_document_generation_v3.docx',
    '{"templateVersion":"ordinary_lease_docx_v3","planImageKey":"planImage"}'::jsonb,
    source.field_definitions, source.layout_definition, source.block_definitions,
    source.default_terms_text, source.default_restoration_criteria_text,
    source.created_by, now()
  from source_revision source
  where not exists (
    select 1
    from public.contract_document_template_revision existing
    where existing.contract_document_template_id = source.contract_document_template_id
      and existing.template_docx_file_path = 'templates/ordinary_lease/ordinary_lease_document_generation_v3.docx'
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
  and revision.template_docx_file_path = 'templates/ordinary_lease/ordinary_lease_document_generation_v3.docx';
