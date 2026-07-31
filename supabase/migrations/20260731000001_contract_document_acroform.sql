-- AcroForm contract document data.
alter table public.contract_document_template_revision
  add column if not exists default_terms_text text not null default '',
  add column if not exists default_restoration_criteria_text text not null default '',
  add column if not exists block_definitions jsonb not null default '{"heading":{"enabled":true},"terms":{"enabled":true},"signature":{"enabled":true},"plan":{"enabled":false},"restoration":{"enabled":true}}'::jsonb;
alter table public.contract_document_template_revision
  add constraint ck_contract_document_template_revision_blocks check (jsonb_typeof(block_definitions) = 'object');
alter table public.lease_contract_document
  add column if not exists terms_text text not null default '',
  add column if not exists restoration_criteria_text text not null default '';
update public.lease_contract_document document set terms_text = revision.default_terms_text, restoration_criteria_text = revision.default_restoration_criteria_text from public.contract_document_template_revision revision where document.contract_document_template_revision_id = revision.contract_document_template_revision_id and document.terms_text = '' and document.restoration_criteria_text = '';
comment on column public.contract_document_template_revision.template_file_path is 'Storage path of the AcroForm PDF template.';
comment on column public.contract_document_template_revision.field_definitions is 'Field metadata: screen block, label, type, required flag, DeskNets mapping and AcroForm name.';
comment on column public.contract_document_template_revision.default_terms_text is 'Default terms copied to a new contract document.';
comment on column public.contract_document_template_revision.default_restoration_criteria_text is 'Default restoration criteria copied to a new contract document.';
comment on column public.contract_document_template_revision.block_definitions is 'Enabled document blocks and PDF settings.';
comment on column public.lease_contract_document.terms_text is 'Contract-specific terms text.';
comment on column public.lease_contract_document.restoration_criteria_text is 'Contract-specific restoration criteria text.';
