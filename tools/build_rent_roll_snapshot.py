#!/usr/bin/env python3
"""Build a reviewable snapshot dataset from rent-roll dry-run reports."""
from __future__ import annotations

import csv
import json
import re
from collections import defaultdict
from datetime import date
from pathlib import Path

REPORT_DIR = Path("data/rent-roll-history/reports/xlsx-dry-runs")
OUT_DIR = Path("data/rent-roll-history/normalized")
ROWS_OUT = OUT_DIR / "rent_roll_snapshot_rows.csv"
ROWS_JSON_OUT = OUT_DIR / "rent_roll_snapshot_rows.json"
SUMMARY_OUT = OUT_DIR / "rent_roll_snapshot_property_summary.csv"


def as_of(source_file: str) -> str | None:
    match = re.search(r"(20\d{2})[.年-](\d{1,2})[.月-](\d{1,2})", source_file)
    if not match:
        return None
    try:
        return date(*map(int, match.groups())).isoformat()
    except ValueError:
        return None


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    rows = []
    excluded = []
    summaries = defaultdict(lambda: {"record_count": 0, "occupied_count": 0, "vacant_count": 0, "rent": 0, "common": 0, "parking": 0, "other": 0})
    for report_path in sorted(REPORT_DIR.glob("report-*.json")):
        report = json.loads(report_path.read_text(encoding="utf-8"))
        source_file = report.get("source_file", report_path.name)
        snapshot_date = as_of(source_file)
        issue_types = {(i.get("source_sheet_name"), i.get("issue_type")) for i in report.get("issues", [])}
        excluded_sheets = {sheet for sheet, kind in issue_types if kind == "layout_not_supported"}
        unknown_sheets = {sheet for sheet, kind in issue_types if kind == "property_not_detected"}
        for record in report.get("records", []):
            sheet = record.get("source_sheet_name")
            if sheet in excluded_sheets:
                excluded.append({"source_file": source_file, "sheet": sheet, "reason": "layout_not_supported"})
                continue
            property_name = record.get("property_name")
            if not property_name or sheet in unknown_sheets:
                excluded.append({"source_file": source_file, "sheet": sheet, "reason": "property_not_detected"})
                continue
            status = record.get("source_status") or ""
            tenant_name = record.get("tenant_name") or ""
            vacant_marker = any(marker in tenant_name or marker in status for marker in ("空室", "空き", "空"))
            occupied = bool(tenant_name) and not vacant_marker
            row = {
                "snapshot_date": snapshot_date,
                "source_file": source_file,
                "source_sheet_name": sheet,
                "source_row_number": record.get("source_row_number"),
                "property_name": property_name,
                "wing_code": record.get("wing_code"),
                "floor_label": record.get("floor_label"),
                "unit_code": record.get("unit_code"),
                "unit_type": record.get("unit_type"),
                "tenant_name": tenant_name,
                "source_status": status,
                "occupancy_status": "occupied" if occupied else "vacant",
                "area_sqm": record.get("area_sqm"),
                "monthly_rent_amount": record.get("monthly_rent_amount"),
                "monthly_common_charge_amount": record.get("monthly_common_charge_amount"),
                "monthly_parking_amount": record.get("monthly_parking_amount"),
                "other_monthly_amount": record.get("other_monthly_amount"),
                "deposit_amount": record.get("deposit_amount"),
                "security_deposit_amount": record.get("security_deposit_amount"),
                "key_money_amount": record.get("key_money_amount"),
                "renewal_fee_amount": record.get("renewal_fee_amount"),
                "contract_start_date": record.get("contract_start_date"),
                "contract_end_date": record.get("contract_end_date"),
                "review_flags": ";".join(sorted(kind for s, kind in issue_types if s == sheet)),
            }
            rows.append(row)
            key = (snapshot_date, property_name)
            summary = summaries[key]
            summary["record_count"] += 1
            summary["occupied_count"] += int(occupied)
            summary["vacant_count"] += int(not occupied)
            summary["rent"] += (record.get("monthly_rent_amount") or 0) if occupied else 0
            summary["common"] += (record.get("monthly_common_charge_amount") or 0) if occupied else 0
            summary["parking"] += (record.get("monthly_parking_amount") or 0) if occupied else 0
            summary["other"] += (record.get("other_monthly_amount") or 0) if occupied else 0
    if rows:
        with ROWS_OUT.open("w", encoding="utf-8-sig", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
            writer.writeheader()
            writer.writerows(rows)
        ROWS_JSON_OUT.write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")
    with SUMMARY_OUT.open("w", encoding="utf-8-sig", newline="") as handle:
        fields = ["snapshot_date", "property_name", *next(iter(summaries.values())).keys()] if summaries else ["snapshot_date", "property_name"]
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for (snapshot_date, property_name), summary in sorted(summaries.items()):
            writer.writerow({"snapshot_date": snapshot_date, "property_name": property_name, **summary})
    (OUT_DIR / "excluded_rows.json").write_text(json.dumps(excluded, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"rows={len(rows)} summaries={len(summaries)} excluded={len(excluded)}")


if __name__ == "__main__":
    main()
