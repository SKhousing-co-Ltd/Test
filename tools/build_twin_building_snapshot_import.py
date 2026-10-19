#!/usr/bin/env python3
"""Prepare idempotent SQL to append Kobe/Fukushima rows to existing snapshots."""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from scripts.import_rent_roll import EMPTY_TENANT_VALUES, read_workbook  # noqa: E402


def as_of(source_file: str) -> date | None:
    match = re.search(r"(20\d{2})[.年-](\d{1,2})[.月-](\d{1,2})", source_file)
    if not match:
        return None
    try:
        return date(*map(int, match.groups()))
    except ValueError:
        return None


def quote_sql(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def snapshot_row(record: Any, issues: list[Any], source_file: str) -> dict[str, Any]:
    tenant_name = record.tenant_name or ""
    vacant = tenant_name in EMPTY_TENANT_VALUES or tenant_name.startswith("空室") or record.source_status.startswith("空室")
    flags = sorted({issue.issue_type for issue in issues if issue.source_sheet_name == record.source_sheet_name and issue.source_row_number == record.source_row_number})
    return {
        "source_sheet_name": record.source_sheet_name,
        "source_row_number": record.source_row_number,
        "property_name": record.property_name,
        "wing_code": record.wing_code,
        "floor_label": record.floor_label,
        "unit_code": record.unit_code,
        "unit_type": record.unit_type,
        "tenant_name": record.tenant_name,
        "source_status": record.source_status,
        "occupancy_status": "vacant" if vacant else "occupied",
        "area_sqm": record.area_sqm,
        "area_tsubo": record.area_tsubo,
        "monthly_rent_amount": record.monthly_rent_amount,
        "monthly_common_charge_amount": record.monthly_common_charge_amount,
        "monthly_parking_amount": record.monthly_parking_amount,
        "other_monthly_amount": record.other_monthly_amount,
        "deposit_amount": record.deposit_amount,
        "security_deposit_amount": record.security_deposit_amount,
        "key_money_amount": record.key_money_amount,
        "renewal_fee_amount": record.renewal_fee_amount,
        "contract_start_date": record.contract_start_date,
        "contract_end_date": record.contract_end_date,
        "review_flags": ";".join(flags) or None,
        "raw_payload": {
            "source_file_name": source_file,
            "tenant_code": record.tenant_code,
            "renewal_terms": record.renewal_terms,
            "payment_terms": record.payment_terms,
            "source_notes": record.source_notes,
        },
    }


def sql_for_batch(snapshot_date: date, source_file: str, rows: list[dict[str, Any]]) -> str:
    payload = json.dumps(rows, ensure_ascii=False, separators=(",", ":"))
    file_sql = quote_sql(source_file)
    date_sql = quote_sql(snapshot_date.isoformat())
    return f"""begin;
do $snapshot_import$
declare
  v_batch_id uuid;
  v_status text;
  v_expected integer := {len(rows)};
  v_inserted integer;
begin
  select rent_roll_snapshot_batch_id, status
    into v_batch_id, v_status
    from public.rent_roll_snapshot_batch
   where as_of_date = {date_sql}::date and source_file_name = {file_sql}
   for update;
  if v_batch_id is null then
    raise exception 'Existing snapshot batch not found: % (%).', {file_sql}, {date_sql};
  end if;
  if v_status = 'approved' then
    raise exception 'Snapshot batch is approved; refusing to replace target rows: % (%).', {file_sql}, {date_sql};
  end if;
  if (select count(distinct asset_name) from public.asset_master
       where asset_name in ('三共神戸ツインビル', '三共福島ビル')) <> 2 then
    raise exception 'Kobe/Fukushima asset mapping is incomplete.';
  end if;

  delete from public.rent_roll_snapshot_row
   where rent_roll_snapshot_batch_id = v_batch_id
     and source_sheet_name in ('神戸', '福島')
     and property_id in (select asset_id from public.asset_master
                          where asset_name in ('三共神戸ツインビル', '三共福島ビル'));

  insert into public.rent_roll_snapshot_row (
    rent_roll_snapshot_batch_id, source_sheet_name, source_row_number,
    property_name, property_id, wing_code, floor_label, unit_code,
    unit_type, tenant_name, source_status, occupancy_status, area_sqm,
    area_tsubo, monthly_rent_amount, monthly_common_charge_amount,
    monthly_parking_amount, other_monthly_amount, deposit_amount,
    security_deposit_amount, key_money_amount, renewal_fee_amount,
    contract_start_date, contract_end_date, review_flags, raw_payload
  )
  select v_batch_id, source.source_sheet_name, source.source_row_number,
         source.property_name, asset.asset_id, source.wing_code,
         source.floor_label, source.unit_code, source.unit_type,
         source.tenant_name, source.source_status, source.occupancy_status,
         source.area_sqm, source.area_tsubo, source.monthly_rent_amount,
         source.monthly_common_charge_amount, source.monthly_parking_amount,
         source.other_monthly_amount, source.deposit_amount,
         source.security_deposit_amount, source.key_money_amount,
         source.renewal_fee_amount, source.contract_start_date,
         source.contract_end_date, source.review_flags, source.raw_payload
    from jsonb_to_recordset($snapshot_rows${payload}$snapshot_rows$::jsonb) as source(
      source_sheet_name text, source_row_number integer, property_name text,
      wing_code text, floor_label text, unit_code text, unit_type text,
      tenant_name text, source_status text, occupancy_status text,
      area_sqm numeric, area_tsubo numeric, monthly_rent_amount numeric,
      monthly_common_charge_amount numeric, monthly_parking_amount numeric,
      other_monthly_amount numeric, deposit_amount numeric,
      security_deposit_amount numeric, key_money_amount numeric,
      renewal_fee_amount numeric, contract_start_date date,
      contract_end_date date, review_flags text, raw_payload jsonb
    )
    join public.asset_master asset on asset.asset_name = source.property_name;
  get diagnostics v_inserted = row_count;
  if v_inserted <> v_expected then
    raise exception 'Snapshot row count mismatch: expected %, inserted %.', v_expected, v_inserted;
  end if;

  update public.rent_roll_snapshot_batch
     set row_count = (select count(*) from public.rent_roll_snapshot_row where rent_roll_snapshot_batch_id = v_batch_id)
   where rent_roll_snapshot_batch_id = v_batch_id;
end;
$snapshot_import$;
commit;
"""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path, default=ROOT / "data/rent-roll-history/source-copy")
    parser.add_argument("--current-date", default="2026-09-01", help="Treat this date as the current snapshot; older dates remain historical snapshots.")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "tmp/twin-building-snapshot-sql")
    parser.add_argument("--summary", type=Path, default=ROOT / "tmp/twin-building-snapshot-summary.json")
    args = parser.parse_args()
    current_date = date.fromisoformat(args.current_date)

    candidates: dict[date, list[Path]] = defaultdict(list)
    ignored: list[str] = []
    for path in args.source_dir.rglob("*.xlsx"):
        parsed_date = as_of(path.name)
        if parsed_date is None or parsed_date > current_date:
            ignored.append(path.name)
            continue
        candidates[parsed_date].append(path)

    args.output_dir.mkdir(parents=True, exist_ok=True)
    summaries: list[dict[str, Any]] = []
    duplicate_dates: dict[str, list[str]] = {}
    for snapshot_date, paths in sorted(candidates.items()):
        paths.sort(key=lambda path: (path.stat().st_mtime_ns, path.name), reverse=True)
        source = paths[0]
        if len(paths) > 1:
            duplicate_dates[snapshot_date.isoformat()] = [path.name for path in paths]
        records, issues = read_workbook(source, {"神戸", "福島"})
        rows = [snapshot_row(record, issues, source.name) for record in records]
        if not rows:
            summaries.append({"as_of_date": snapshot_date.isoformat(), "source_file": source.name, "record_count": 0, "issue_count": len(issues), "error": "No target rows parsed"})
            continue
        invalid_amounts = [row for row in rows if any((row[field] or 0) < 0 for field in ("monthly_rent_amount", "monthly_common_charge_amount", "monthly_parking_amount", "other_monthly_amount"))]
        if invalid_amounts:
            raise ValueError(f"Negative monthly amounts violate the snapshot schema: {snapshot_date} ({len(invalid_amounts)} rows)")
        sql = sql_for_batch(snapshot_date, source.name, rows)
        (args.output_dir / f"{snapshot_date.isoformat()}.sql").write_text(sql, encoding="utf-8")
        by_property = Counter(row["property_name"] for row in rows)
        summaries.append({
            "as_of_date": snapshot_date.isoformat(),
            "source_file": source.name,
            "source_modified_ns": source.stat().st_mtime_ns,
            "record_count": len(rows),
            "by_property": dict(by_property),
            "issue_count": len(issues),
            "issue_types": dict(Counter(issue.issue_type for issue in issues)),
            "missing_area_count": sum(row["area_sqm"] is None for row in rows),
            "occupied_count": sum(row["occupancy_status"] == "occupied" for row in rows),
            "vacant_count": sum(row["occupancy_status"] == "vacant" for row in rows),
        })
    summary = {"current_date": current_date.isoformat(), "batch_count": len(summaries), "duplicate_dates": duplicate_dates, "ignored_files": len(ignored), "batches": summaries}
    args.summary.parent.mkdir(parents=True, exist_ok=True)
    args.summary.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    records_count = sum(item["record_count"] for item in summaries)
    print(f"Prepared {len(summaries)} date batches, {records_count} target rows, {len(duplicate_dates)} duplicate dates; summary: {args.summary}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
