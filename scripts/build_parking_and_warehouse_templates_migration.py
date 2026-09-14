"""Write the data-only migration that publishes parking and warehouse templates."""

from __future__ import annotations

import argparse
import base64
import json
from pathlib import Path


PARKING_FIELDS = [
    {"key": "tenantName", "label": "賃借人", "type": "text", "required": True},
    {"key": "propertyName", "label": "建物名称", "type": "text", "required": True},
    {"key": "propertyLotAddress", "label": "所在地（地番）", "type": "text"},
    {"key": "propertyAddress", "label": "所在地（住居表示）", "type": "text"},
    {"key": "usePurpose", "label": "使用目的", "type": "text", "required": True},
    {"key": "contractStartDate", "label": "契約開始日", "type": "date", "required": True},
    {"key": "contractEndDate", "label": "契約終了日", "type": "date", "required": True},
    {"key": "contractDurationYears", "label": "契約年数", "type": "number"},
    {"key": "parkingContractCount", "label": "契約台数", "type": "integer", "required": True},
    {"key": "monthlyRentAmount", "label": "月額賃料", "type": "number", "required": True},
    {"key": "monthlyRentPerSpaceAmount", "label": "1台あたり月額賃料", "type": "number"},
    {"key": "rentPaymentDue", "label": "賃料支払期日", "type": "text"},
    {"key": "dailyCalculationMethod", "label": "日割計算方法", "type": "text"},
    {"key": "depositAmount", "label": "敷金", "type": "number"},
    {"key": "depositMonths", "label": "敷金月数", "type": "number"},
    {"key": "parkingCertificateFeeAmount", "label": "車庫証明発行料", "type": "number"},
    {"key": "specialProvisions", "label": "特約事項", "type": "textarea"},
]

WAREHOUSE_FIELDS = [
    {"key": "tenantName", "label": "賃借人", "type": "text", "required": True},
    {"key": "guarantorName", "label": "連帯保証人", "type": "text"},
    {"key": "guarantorLimitAmount", "label": "連帯保証人極度額", "type": "number"},
    {"key": "propertyName", "label": "建物名称", "type": "text", "required": True},
    {"key": "propertyLotAddress", "label": "所在地（地番）", "type": "text"},
    {"key": "propertyAddress", "label": "所在地（住居表示）", "type": "text"},
    {"key": "buildingStructure", "label": "構造規模", "type": "text"},
    {"key": "floorLabel", "label": "階", "type": "text"},
    {"key": "unitNames", "label": "賃貸借物件", "type": "text", "required": True},
    {"key": "leasedAreaSqm", "label": "賃貸借面積㎡", "type": "number"},
    {"key": "leasedAreaTsubo", "label": "賃貸借面積坪", "type": "number"},
    {"key": "usePurpose", "label": "使用目的", "type": "text", "required": True},
    {"key": "contractStartDate", "label": "契約開始日", "type": "date", "required": True},
    {"key": "contractEndDate", "label": "契約終了日", "type": "date", "required": True},
    {"key": "contractDurationYears", "label": "契約年数", "type": "number"},
    {"key": "monthlyRentAmount", "label": "月額賃料", "type": "number", "required": True},
    {"key": "rentPaymentDue", "label": "賃料支払期日", "type": "text"},
    {"key": "dailyCalculationMethod", "label": "日割計算方法", "type": "text"},
    {"key": "depositAmount", "label": "敷金", "type": "number"},
    {"key": "depositMonths", "label": "敷金月数", "type": "number"},
    {"key": "specialProvisions", "label": "特約事項", "type": "textarea"},
]


def encoded(path: Path) -> str:
    return base64.b64encode(path.read_text(encoding="utf-8").encode("utf-8")).decode("ascii")


def sql_for(kind: str, terms: str, fields: list[dict[str, object]]) -> str:
    display = "駐車場" if kind == "parking" else "倉庫"
    version = f"{kind}_lease_docx_v1"
    path = f"templates/{kind}/{kind}_lease_document_generation_v1.docx"
    return f"""
with source as (
  select convert_from(decode('{terms}', 'base64'), 'UTF8') as default_terms
), template_row as (
  select contract_document_template_id
  from public.contract_document_template
  where document_type = '{kind}'
), inserted as (
  insert into public.contract_document_template_revision (
    contract_document_template_id, revision_no, status, generation_engine,
    template_docx_file_path, document_generation_schema, field_definitions,
    layout_definition, block_definitions, default_terms_text,
    default_restoration_criteria_text, published_at
  )
  select template_row.contract_document_template_id,
    coalesce((select max(revision_no) from public.contract_document_template_revision where contract_document_template_id = template_row.contract_document_template_id), 0) + 1,
    'published', 'document_generation', '{path}',
    '{{"templateVersion":"{version}","legalTerms":"editable"}}'::jsonb,
    '{json.dumps(fields, ensure_ascii=False, separators=(',', ':'))}'::jsonb,
    '{{}}'::jsonb,
    '{{"heading":{{"enabled":true}},"signature":{{"enabled":true}},"plan":{{"enabled":false}},"terms":{{"enabled":true}},"restoration":{{"enabled":false}}}}'::jsonb,
    source.default_terms, '', now()
  from template_row cross join source
  where not exists (
    select 1 from public.contract_document_template_revision
    where template_docx_file_path = '{path}'
  )
  returning contract_document_template_revision_id, contract_document_template_id
), activated as (
  update public.contract_document_template template
  set active_revision_id = inserted.contract_document_template_revision_id,
      requires_plan = false,
      updated_at = now()
  from inserted
  where template.contract_document_template_id = inserted.contract_document_template_id
  returning inserted.contract_document_template_revision_id
)
update public.lease_contract_document document
set contract_document_template_revision_id = activated.contract_document_template_revision_id,
    terms_text = case when btrim(document.terms_text) = '' then source.default_terms else document.terms_text end
from activated cross join source
where document.document_type = '{kind}';

update public.contract_document_template
set requires_plan = false, updated_at = now()
where document_type = '{kind}';
"""


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--parking-terms", type=Path, required=True)
    parser.add_argument("--warehouse-terms", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    header = "-- Publish editable, no-plan Word templates derived from approved parking and warehouse sources.\n"
    args.output.write_text(header + sql_for("parking", encoded(args.parking_terms), PARKING_FIELDS) + sql_for("warehouse", encoded(args.warehouse_terms), WAREHOUSE_FIELDS), encoding="utf-8")


if __name__ == "__main__":
    main()
