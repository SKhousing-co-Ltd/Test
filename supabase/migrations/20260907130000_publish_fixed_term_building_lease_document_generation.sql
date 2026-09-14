-- Publish the fixed-term building lease as a new immutable Word-template
-- revision.  The source legal clauses stay in the DOCX; only contract slots
-- are merged by Adobe Document Generation.
with template_row as (
  select contract_document_template_id
  from public.contract_document_template
  where document_type = 'fixed_term_building_lease'
), next_revision as (
  select template_row.contract_document_template_id,
         coalesce(max(revision.revision_no), 0) + 1 as revision_no
  from template_row
  left join public.contract_document_template_revision revision
    on revision.contract_document_template_id = template_row.contract_document_template_id
  group by template_row.contract_document_template_id
), inserted as (
  insert into public.contract_document_template_revision (
    contract_document_template_id, revision_no, status, generation_engine,
    template_docx_file_path, document_generation_schema, field_definitions,
    layout_definition, block_definitions, default_terms_text,
    default_restoration_criteria_text, published_at
  )
  select next_revision.contract_document_template_id,
    next_revision.revision_no, 'published', 'document_generation',
    'templates/fixed_term_building_lease/fixed_term_building_lease_document_generation_v1.docx',
    '{"templateVersion":"fixed_term_building_lease_docx_v1","planImageKey":"planImage","legalTerms":"approved_source_static"}'::jsonb,
    '[
      {"key":"tenantName","label":"賃借人","type":"text","required":true},
      {"key":"guarantorName","label":"連帯保証人","type":"text"},
      {"key":"guarantorLimitAmount","label":"連帯保証人極度額","type":"number"},
      {"key":"propertyName","label":"建物名称","type":"text","required":true},
      {"key":"propertyLotAddress","label":"所在地（地番）","type":"text"},
      {"key":"propertyAddress","label":"所在地（住居表示）","type":"text"},
      {"key":"buildingStructure","label":"構造規模","type":"text"},
      {"key":"floorLabel","label":"階","type":"integer","required":true},
      {"key":"unitNames","label":"区画","type":"text","required":true},
      {"key":"leasedAreaSqm","label":"賃貸借面積（㎡）","type":"number","required":true},
      {"key":"leasedAreaTsubo","label":"賃貸借面積（坪）","type":"number"},
      {"key":"usePurpose","label":"使用目的","type":"text"},
      {"key":"contractStartDate","label":"契約開始日","type":"date","required":true},
      {"key":"contractEndDate","label":"契約終了日","type":"date","required":true},
      {"key":"contractDurationYears","label":"契約年数","type":"number","required":true},
      {"key":"monthlyRentAmount","label":"月額賃料（税別）","type":"number"},
      {"key":"rentPaymentDue","label":"賃料の支払期日","type":"text"},
      {"key":"dailyCalculationMethod","label":"日割計算方法","type":"text"},
      {"key":"depositAmount","label":"敷金","type":"number"},
      {"key":"depositMonths","label":"敷金月数","type":"number"},
      {"key":"specialProvisions","label":"特約事項","type":"textarea"},
      {"key":"brokerName","label":"仲介業者","type":"text"}
    ]'::jsonb,
    '{}'::jsonb,
    '{"heading":{"enabled":true},"signature":{"enabled":true},"plan":{"enabled":true},"terms":{"enabled":false},"restoration":{"enabled":false}}'::jsonb,
    '', '', now()
  from next_revision
  where not exists (
    select 1
    from public.contract_document_template_revision existing
    where existing.template_docx_file_path = 'templates/fixed_term_building_lease/fixed_term_building_lease_document_generation_v1.docx'
  )
  returning contract_document_template_revision_id, contract_document_template_id
)
update public.contract_document_template template
set active_revision_id = inserted.contract_document_template_revision_id
from inserted
where template.contract_document_template_id = inserted.contract_document_template_id;
