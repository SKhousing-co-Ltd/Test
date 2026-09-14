"""Build the data migration that registers approved lease terms and template v2."""

from __future__ import annotations

import argparse
import base64
from pathlib import Path


def encoded(path: Path) -> str:
    return base64.b64encode(path.read_bytes()).decode("ascii")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("migration", type=Path)
    parser.add_argument("ordinary_terms", type=Path)
    parser.add_argument("fixed_terms", type=Path)
    args = parser.parse_args()
    ordinary = encoded(args.ordinary_terms)
    fixed = encoded(args.fixed_terms)
    args.migration.write_text(
        f'''-- Register approved default terms and publish an editable fixed-term Word template.
with terms as (
  select
    convert_from(decode('{ordinary}', 'base64'), 'UTF8') as ordinary_terms,
    convert_from(decode('{fixed}', 'base64'), 'UTF8') as fixed_terms
), ordinary_template as (
  select contract_document_template_id
  from public.contract_document_template
  where document_type = 'ordinary_lease'
), fixed_template as (
  select contract_document_template_id
  from public.contract_document_template
  where document_type = 'fixed_term_building_lease'
), updated_defaults as (
  update public.contract_document_template_revision revision
  set default_terms_text = case
    when revision.contract_document_template_id = (select contract_document_template_id from ordinary_template)
      then terms.ordinary_terms
    else terms.fixed_terms
  end
  from terms
  where revision.contract_document_template_id in (
    select contract_document_template_id from ordinary_template
    union all
    select contract_document_template_id from fixed_template
  )
    and btrim(revision.default_terms_text) = ''
), source_revision as (
  select revision.*
  from public.contract_document_template_revision revision
  join fixed_template on fixed_template.contract_document_template_id = revision.contract_document_template_id
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
    source.revision_no + 1, 'published', 'document_generation',
    'templates/fixed_term_building_lease/fixed_term_building_lease_document_generation_v2.docx',
    '{{"templateVersion":"fixed_term_building_lease_docx_v2","planImageKey":"planImage","legalTerms":"editable"}}'::jsonb,
    source.field_definitions, source.layout_definition,
    jsonb_set(source.block_definitions, '{{terms,enabled}}', 'true'::jsonb, true),
    terms.fixed_terms, source.default_restoration_criteria_text,
    source.created_by, now()
  from source_revision source
  cross join terms
  where not exists (
    select 1
    from public.contract_document_template_revision existing
    where existing.contract_document_template_id = source.contract_document_template_id
      and existing.template_docx_file_path = 'templates/fixed_term_building_lease/fixed_term_building_lease_document_generation_v2.docx'
  )
  returning contract_document_template_revision_id, contract_document_template_id
), activated as (
  update public.contract_document_template template
  set active_revision_id = inserted.contract_document_template_revision_id
  from inserted
  where template.contract_document_template_id = inserted.contract_document_template_id
  returning inserted.contract_document_template_revision_id
)
update public.lease_contract_document document
set contract_document_template_revision_id = activated.contract_document_template_revision_id,
    terms_text = case when btrim(document.terms_text) = '' then terms.fixed_terms else document.terms_text end
from activated
cross join terms
where document.document_type = 'fixed_term_building_lease';
''',
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
