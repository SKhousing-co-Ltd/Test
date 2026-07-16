#!/usr/bin/env python3
"""Import a current rent roll; run without --apply before writing to Supabase."""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import unicodedata
from dataclasses import asdict, dataclass, field
from datetime import date, datetime
from pathlib import Path
from typing import Any
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from openpyxl import load_workbook

SOURCE_SYSTEM = "rent_roll_xlsx"
SPECIAL_LAYOUT_SHEETS = {"神戸", "福島", "ORH", "中之島"}
PROPERTY_NAME_ALIASES: dict[str, str] = {}
EMPTY_TENANT_VALUES = {"", "空室", "空室（倉庫）", "空"}


@dataclass
class ImportIssue:
    source_sheet_name: str
    source_row_number: int | None
    issue_type: str
    message: str
    source_payload: dict[str, Any] = field(default_factory=dict)


@dataclass
class RentRollRecord:
    source_sheet_name: str
    source_row_number: int
    property_name: str
    wing_code: str | None
    floor_label: str | None
    unit_code: str
    unit_type: str
    tenant_code: str | None
    tenant_name: str | None
    area_sqm: float | None
    monthly_rent_amount: int | None
    monthly_common_charge_amount: int | None
    deposit_amount: int | None
    security_deposit_amount: int | None
    key_money_amount: int | None
    renewal_fee_amount: int | None
    contract_start_date: str | None
    contract_end_date: str | None
    renewal_terms: str | None
    payment_terms: str | None


def normalize_text(value: Any) -> str:
    if value is None:
        return ""
    return unicodedata.normalize("NFKC", str(value)).replace("\u3000", " ").strip()


def normalize_identifier(value: Any) -> str:
    return re.sub(r"\s+", "", normalize_text(value)).replace("～", "〜")


def normalize_tenant_name(value: Any) -> str:
    return re.sub(r"\s+", "", normalize_text(value)).lower()


def as_number(value: Any) -> int | float | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return value
    text = normalize_text(value).replace(",", "").replace("¥", "").replace("￥", "")
    return float(text) if re.fullmatch(r"-?\d+(?:\.\d+)?", text) else None


def as_date(value: Any) -> str | None:
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    text = normalize_text(value)
    for pattern in (r"(\d{4})[/-](\d{1,2})[/-](\d{1,2})", r"(\d{4})年(\d{1,2})月(\d{1,2})日"):
        match = re.fullmatch(pattern, text)
        if match:
            return date(*map(int, match.groups())).isoformat()
    return None


def infer_unit_type(unit_code: str) -> str:
    if "倉庫" in unit_code:
        return "storage"
    if any(token in unit_code for token in ("駐車", "車庫", "パーキング")):
        return "parking"
    if "ATM" in unit_code or "機械" in unit_code:
        return "equipment"
    return "office"


def get_property_name(sheet: Any) -> str | None:
    title = normalize_text(sheet.cell(1, 3).value)
    match = re.search(r"【(.+?)】", title)
    if match:
        return PROPERTY_NAME_ALIASES.get(match.group(1), match.group(1))
    return PROPERTY_NAME_ALIASES.get(sheet.title)


def find_column(headers: dict[int, str], candidates: tuple[str, ...]) -> int | None:
    for column, header in headers.items():
        compact = re.sub(r"\s+", "", header)
        if any(candidate in compact for candidate in candidates):
            return column
    return None


def detect_columns(sheet: Any) -> tuple[dict[str, int | None], int]:
    headers: dict[int, str] = {}
    header_row = 0
    for column in range(1, sheet.max_column + 1):
        # レントロールの見出しは先頭 3 行まで。データ行まで走査すると、
        # 「入居中」などの値に含まれる「室」を区画列と誤認してしまう。
        values = [normalize_text(sheet.cell(row, column).value) for row in range(1, min(sheet.max_row, 3) + 1)]
        headers[column] = " ".join(value for value in values if value)
        if any(value in {"室", "テナント名", "コード", "棟"} for value in values):
            header_row = max(header_row, max(index + 1 for index, value in enumerate(values) if value))
    columns = {
        "wing": find_column(headers, ("棟",)), "floor": find_column(headers, ("階-室", "階")),
        "unit": find_column(headers, ("階-室", "室")), "tenant_code": find_column(headers, ("コード",)),
        "tenant_name": find_column(headers, ("テナント名",)), "area": find_column(headers, ("面積",)),
        "rent": find_column(headers, ("賃料",)), "common_charge": find_column(headers, ("共益費",)),
        "deposit": find_column(headers, ("敷金",)), "security_deposit": find_column(headers, ("保証金",)),
        "key_money": find_column(headers, ("礼金",)), "renewal_fee": find_column(headers, ("更新料",)),
        "contract_start": find_column(headers, ("契約開始", "開始日", "始期", "契約日")),
        "contract_end": find_column(headers, ("契約終了", "終了日", "満了日", "終期", "更新日")),
        "renewal_terms": find_column(headers, ("更新条件", "更新周期")), "payment_terms": find_column(headers, ("支払条件", "支払期日")),
    }
    # 新大阪・横浜などは「室」の見出しが空欄だが、階の右隣が区画列である。
    if columns["unit"] is None and columns["floor"] and columns["tenant_name"] and columns["area"]:
        columns["unit"] = columns["floor"] + 1
    return columns, header_row


def cell(row: tuple[Any, ...], column: int | None) -> Any:
    return row[column - 1] if column and column <= len(row) else None


def read_workbook(path: Path) -> tuple[list[RentRollRecord], list[ImportIssue]]:
    workbook = load_workbook(path, read_only=True, data_only=True)
    records: list[RentRollRecord] = []
    issues: list[ImportIssue] = []
    seen_units: set[tuple[str, str | None, str]] = set()
    for sheet in workbook.worksheets:
        if sheet.title in SPECIAL_LAYOUT_SHEETS:
            issues.append(ImportIssue(sheet.title, None, "layout_not_supported", "棟・住居用の専用レイアウトのため、設定を追加するまで自動取込の対象外です。"))
            continue
        property_name = get_property_name(sheet)
        if not property_name:
            issues.append(ImportIssue(sheet.title, None, "property_not_detected", "タイトルから物件名を取得できません。PROPERTY_NAME_ALIASES に対応を追加してください。"))
            continue
        columns, header_row = detect_columns(sheet)
        if not header_row or any(columns[name] is None for name in ("unit", "tenant_name", "area")):
            issues.append(ImportIssue(sheet.title, None, "layout_not_supported", "必須列（室・テナント名・面積）を特定できません。", {"columns": columns}))
            continue
        inherited_floor: str | None = None
        inherited_wing: str | None = None
        for row_number, row in enumerate(sheet.iter_rows(min_row=header_row + 1, values_only=True), start=header_row + 1):
            unit_code = normalize_identifier(cell(row, columns["unit"]))
            if not unit_code or "合計" in unit_code:
                continue
            floor = normalize_text(cell(row, columns["floor"]))
            wing = normalize_text(cell(row, columns["wing"]))
            inherited_floor = floor or inherited_floor
            inherited_wing = wing or inherited_wing
            tenant_name = normalize_text(cell(row, columns["tenant_name"])) or None
            tenant_code = normalize_text(cell(row, columns["tenant_code"])) or None
            payload = {"floor": inherited_floor, "unit": unit_code, "tenant_code": tenant_code, "tenant_name": tenant_name}
            key = (property_name, inherited_wing, unit_code)
            if key in seen_units:
                issues.append(ImportIssue(sheet.title, row_number, "duplicate_unit_candidate", "同じ物件・棟・区画コードが複数行にあります。", payload))
            seen_units.add(key)
            if any(marker in unit_code for marker in ("〜", "~", "・")):
                issues.append(ImportIssue(sheet.title, row_number, "combined_unit", "結合区画のため、区画分割または結合区画としての扱いを確認してください。", payload))
            if tenant_code and re.search(r"[\n/]", tenant_code):
                issues.append(ImportIssue(sheet.title, row_number, "multiple_tenant_codes", "テナントコードが複数記載されているため、契約は自動登録しません。", payload))
            records.append(RentRollRecord(
                sheet.title, row_number, property_name, inherited_wing, inherited_floor, unit_code, infer_unit_type(unit_code),
                tenant_code, tenant_name, as_number(cell(row, columns["area"])), as_number(cell(row, columns["rent"])),
                as_number(cell(row, columns["common_charge"])), as_number(cell(row, columns["deposit"])),
                as_number(cell(row, columns["security_deposit"])), as_number(cell(row, columns["key_money"])),
                as_number(cell(row, columns["renewal_fee"])), as_date(cell(row, columns["contract_start"])),
                as_date(cell(row, columns["contract_end"])), normalize_text(cell(row, columns["renewal_terms"])) or None,
                normalize_text(cell(row, columns["payment_terms"])) or None))
    return records, issues


class SupabaseRest:
    def __init__(self, url: str, service_role_key: str):
        self.url = url.rstrip("/") + "/rest/v1"
        self.headers = {"apikey": service_role_key, "Authorization": f"Bearer {service_role_key}", "Content-Type": "application/json"}

    def request(self, method: str, table: str, *, query: dict[str, str] | None = None, body: Any = None, prefer: str | None = None) -> Any:
        url = f"{self.url}/{table}" + (("?" + urlencode(query)) if query else "")
        headers = dict(self.headers)
        if prefer:
            headers["Prefer"] = prefer
        request = Request(url, data=json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None, headers=headers, method=method)
        try:
            with urlopen(request) as response:
                payload = response.read().decode("utf-8")
                return json.loads(payload) if payload else None
        except HTTPError as error:
            raise RuntimeError(f"{method} {table} failed: {error.read().decode('utf-8', 'replace')}") from error

    def one(self, table: str, query: dict[str, str]) -> dict[str, Any] | None:
        rows = self.request("GET", table, query={**query, "limit": "1"})
        return rows[0] if rows else None


def persist(records: list[RentRollRecord], issues: list[ImportIssue], source_file_name: str, client: SupabaseRest) -> tuple[int, list[ImportIssue]]:
    persisted = 0
    runtime_issues = list(issues)
    for record in records:
        property_row = client.one("property_master", {"select": "property_id", "property_name": f"eq.{record.property_name}"})
        if not property_row:
            runtime_issues.append(ImportIssue(record.source_sheet_name, record.source_row_number, "property_not_matched", "property_master に一致する物件がありません。", asdict(record)))
            continue
        property_id = property_row["property_id"]
        unit_query = {"select": "unit_id", "property_id": f"eq.{property_id}", "unit_code": f"eq.{record.unit_code}"}
        unit_payload: dict[str, Any] = {"property_id": property_id, "unit_code": record.unit_code, "floor_label": record.floor_label, "unit_type": record.unit_type, "rentable_area_sqm": record.area_sqm}
        if record.wing_code:
            wing = client.one("building_wing_master", {"select": "building_wing_id", "property_id": f"eq.{property_id}", "wing_code": f"eq.{record.wing_code}"})
            if not wing:
                wing = client.request("POST", "building_wing_master", body={"property_id": property_id, "wing_code": record.wing_code, "wing_name": record.wing_code}, prefer="return=representation")[0]
            unit_query["building_wing_id"] = f"eq.{wing['building_wing_id']}"
            unit_payload["building_wing_id"] = wing["building_wing_id"]
        else:
            unit_query["building_wing_id"] = "is.null"
            unit_payload["building_wing_id"] = None
        unit = client.one("unit_master", unit_query)
        if unit:
            client.request("PATCH", "unit_master", query={"unit_id": f"eq.{unit['unit_id']}"}, body=unit_payload)
        else:
            unit = client.request("POST", "unit_master", body=unit_payload, prefer="return=representation")[0]
        if not record.tenant_name or record.tenant_name in EMPTY_TENANT_VALUES or (record.tenant_code and re.search(r"[\n/]", record.tenant_code)):
            persisted += 1
            continue
        normalized_name = normalize_tenant_name(record.tenant_name)
        tenant = client.one("tenant_master", {"select": "tenant_id", "normalized_tenant_name": f"eq.{normalized_name}"})
        tenant_payload = {"external_tenant_code": record.tenant_code, "tenant_name": record.tenant_name, "normalized_tenant_name": normalized_name}
        if tenant:
            client.request("PATCH", "tenant_master", query={"tenant_id": f"eq.{tenant['tenant_id']}"}, body=tenant_payload)
        else:
            tenant = client.request("POST", "tenant_master", body=tenant_payload, prefer="return=representation")[0]
        source_key = f"{record.source_sheet_name}:{record.source_row_number}"
        contract = client.one("lease_contract", {"select": "lease_contract_id", "source_system": f"eq.{SOURCE_SYSTEM}", "source_record_key": f"eq.{source_key}"})
        contract_payload = {"tenant_id": tenant["tenant_id"], "contract_status": "active", "contract_start_date": record.contract_start_date, "contract_end_date": record.contract_end_date, "renewal_terms": record.renewal_terms, "payment_terms": record.payment_terms, "source_system": SOURCE_SYSTEM, "source_record_key": source_key}
        if contract:
            client.request("PATCH", "lease_contract", query={"lease_contract_id": f"eq.{contract['lease_contract_id']}"}, body=contract_payload)
        else:
            contract = client.request("POST", "lease_contract", body=contract_payload, prefer="return=representation")[0]
        allocation = client.one("lease_contract_unit", {"select": "lease_contract_unit_id", "lease_contract_id": f"eq.{contract['lease_contract_id']}", "unit_id": f"eq.{unit['unit_id']}"})
        allocation_payload = {"lease_contract_id": contract["lease_contract_id"], "unit_id": unit["unit_id"], "leased_area_sqm": record.area_sqm, "monthly_rent_amount": record.monthly_rent_amount, "monthly_common_charge_amount": record.monthly_common_charge_amount, "deposit_amount": record.deposit_amount, "security_deposit_amount": record.security_deposit_amount, "key_money_amount": record.key_money_amount, "renewal_fee_amount": record.renewal_fee_amount}
        if allocation:
            client.request("PATCH", "lease_contract_unit", query={"lease_contract_unit_id": f"eq.{allocation['lease_contract_unit_id']}"}, body=allocation_payload)
        else:
            client.request("POST", "lease_contract_unit", body=allocation_payload)
        persisted += 1
    for issue in runtime_issues:
        client.request("POST", "rent_roll_import_issue", body={"source_file_name": source_file_name, **asdict(issue)})
    return persisted, runtime_issues


def main() -> int:
    parser = argparse.ArgumentParser(description="Import a rent-roll workbook into Supabase.")
    parser.add_argument("workbook", type=Path)
    parser.add_argument("--report", type=Path, default=Path("rent_roll_import_report.json"))
    parser.add_argument("--apply", action="store_true", help="Write to Supabase after reviewing the report.")
    args = parser.parse_args()
    records, issues = read_workbook(args.workbook)
    report = {"source_file": args.workbook.name, "record_count": len(records), "issue_count": len(issues), "records": [asdict(record) for record in records], "issues": [asdict(issue) for issue in issues]}
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Dry-run report: {args.report} ({len(records)} records, {len(issues)} issues)")
    if not args.apply:
        return 0
    url = os.getenv("SUPABASE_URL")
    service_role_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not service_role_key:
        print("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required with --apply.", file=sys.stderr)
        return 2
    persisted, all_issues = persist(records, issues, args.workbook.name, SupabaseRest(url, service_role_key))
    print(f"Imported {persisted} unit rows. Recorded {len(all_issues)} review issues.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
