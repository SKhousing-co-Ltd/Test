#!/usr/bin/env python3
"""発行コード.xlsxを billing_code へ取り込む。既定では確認レポートだけを出力する。"""
from __future__ import annotations

import argparse
import json
import os
import re
import unicodedata
from pathlib import Path
from typing import Any
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from openpyxl import load_workbook


def text(value: Any) -> str:
    return unicodedata.normalize("NFKC", str(value or "")).replace("\u3000", " ").strip()


def read_codes(path: Path) -> dict[str, list[dict[str, Any]]]:
    workbook = load_workbook(path, read_only=True, data_only=True)
    result: dict[str, list[dict[str, Any]]] = {}
    for sheet in workbook.worksheets:
        rows = list(sheet.iter_rows(values_only=True))
        header_index = next((index for index, row in enumerate(rows) if any(text(cell).startswith("発行先コード") for cell in row)), None)
        if header_index is None:
            continue
        headers = [text(cell) for cell in rows[header_index]]
        code_index = next(index for index, value in enumerate(headers) if value.startswith("発行先コード"))
        name_index = next((index for index, value in enumerate(headers) if "請求先会社" in value or "契約名義" in value), None)
        notes_index = next((index for index, value in enumerate(headers) if value == "備考"), None)
        if name_index is None:
            continue
        items: list[dict[str, Any]] = []
        for row_number, row in enumerate(rows[header_index + 2 :], start=header_index + 3):
            code, name = text(row[code_index] if code_index < len(row) else None), text(row[name_index] if name_index < len(row) else None)
            if not code or not name or not re.fullmatch(r"[0-9]+", code):
                continue
            notes = text(row[notes_index] if notes_index is not None and notes_index < len(row) else None)
            items.append({"issue_code": code, "recipient_name": name, "source_sheet_name": sheet.title, "source_row_number": row_number, "notes": notes or None, "is_active": not bool(re.search(r"解約|使用不可|空き番号", name + notes))})
        result[sheet.title] = items
    return result


class Rest:
    def __init__(self, url: str, key: str):
        self.base_url = url.rstrip("/") + "/rest/v1"
        self.headers = {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"}

    def request(self, method: str, table: str, query: dict[str, str] | None = None, body: Any = None, prefer: str | None = None) -> list[dict[str, Any]]:
        headers = dict(self.headers)
        if prefer:
            headers["Prefer"] = prefer
        url = f"{self.base_url}/{table}" + (f"?{urlencode(query)}" if query else "")
        request = Request(url, data=json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None, headers=headers, method=method)
        with urlopen(request) as response:
            payload = response.read().decode("utf-8")
        return json.loads(payload) if payload else []

    def property_for_code(self, code: str) -> str | None:
        rows = self.request("GET", "lease_contract_unit", {
            "select": "unit:unit_master!inner(property_id),contract:lease_contract!inner(tenant:tenant_master!inner(external_tenant_code))",
            "contract.tenant.external_tenant_code": f"eq.{code}", "limit": "1",
        })
        if not rows:
            return None
        unit = rows[0].get("unit") or {}
        if isinstance(unit, list):
            unit = unit[0] if unit else {}
        return unit.get("property_id")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("workbook", type=Path)
    parser.add_argument("--apply", action="store_true", help="Supabaseへ登録する")
    parser.add_argument("--supabase-url", default=os.getenv("VITE_SUPABASE_URL"))
    parser.add_argument("--service-role-key", default=os.getenv("SUPABASE_SERVICE_ROLE_KEY"))
    args = parser.parse_args()
    by_sheet = read_codes(args.workbook)
    report = {"sheets": {sheet: {"rows": len(rows), "property_id": None} for sheet, rows in by_sheet.items()}, "unmatched_sheets": []}
    if not args.apply:
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return
    if not args.supabase_url or not args.service_role_key:
        raise SystemExit("--apply には SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY が必要です。")
    client = Rest(args.supabase_url, args.service_role_key)
    for sheet, rows in by_sheet.items():
        property_id = None
        for row in rows:
            property_id = client.property_for_code(row["issue_code"])
            if property_id:
                break
        report["sheets"][sheet]["property_id"] = property_id
        if not property_id:
            report["unmatched_sheets"].append(sheet)
            continue
        payload = [{**row, "property_id": property_id} for row in rows]
        client.request("POST", "billing_code", {"on_conflict": "property_id,issue_code"}, payload, "resolution=merge-duplicates")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
