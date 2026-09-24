#!/usr/bin/env python3
"""Summarize rent-roll dry-run reports into a human review list."""
from __future__ import annotations

import json
from collections import Counter, defaultdict
from pathlib import Path


REPORT_DIR = Path("data/rent-roll-history/reports/xlsx-dry-runs")
OUTPUT = Path("data/rent-roll-history/reports/review-summary.md")


def main() -> None:
    reports = []
    for path in sorted(REPORT_DIR.glob("*.json")):
        with path.open(encoding="utf-8") as handle:
            reports.append((path.name, json.load(handle)))

    issue_counts = Counter()
    issue_files: dict[str, set[str]] = defaultdict(set)
    issue_examples: dict[str, list[dict]] = defaultdict(list)
    lines = [
        "# 過去レントロール照合レビュー一覧",
        "",
        f"対象ドライランファイル数: {len(reports)}",
        f"抽出レコード数: {sum(r.get('record_count', 0) for _, r in reports):,}",
        f"要確認件数: {sum(r.get('issue_count', 0) for _, r in reports):,}",
        "",
        "## こちらで確認が必要な分類",
        "",
        "| 分類 | 件数 | 対象ファイル数 | 判断内容 |",
        "|---|---:|---:|---|",
    ]
    descriptions = {
        "temporary_unit_discriminator": "同一階・同一区画が複数行。別区画か複数契約かを確認",
        "combined_unit": "結合区画。分割区画として扱うか、1区画として扱うかを確認",
        "layout_not_supported": "帳票レイアウト未対応。列対応を追加するか手作業で補正",
        "property_not_detected": "物件名を特定できない。物件名の対応表を追加",
    }
    for _, report in reports:
        for issue in report.get("issues", []):
            kind = issue.get("issue_type", "unknown")
            issue_counts[kind] += 1
            issue_files[kind].add(report.get("source_file", ""))
            if len(issue_examples[kind]) < 8:
                issue_examples[kind].append({
                    "file": report.get("source_file", ""),
                    "sheet": issue.get("source_sheet_name"),
                    "row": issue.get("source_row_number"),
                    "message": issue.get("message"),
                    "payload": issue.get("source_payload", {}),
                })
    for kind, count in issue_counts.most_common():
        lines.append(f"| `{kind}` | {count:,} | {len(issue_files[kind])} | {descriptions.get(kind, '内容を確認')} |")

    lines += ["", "## 代表的な確認例", ""]
    for kind, examples in issue_examples.items():
        lines += [f"### `{kind}`", ""]
        for example in examples:
            lines.append(
                f"- {example['file']} / シート `{example['sheet']}` / 行 `{example['row']}`: "
                f"{example['message']} / {json.dumps(example['payload'], ensure_ascii=False)}"
            )
        lines.append("")

    lines += [
        "## 確認の優先順位", "",
        "1. `layout_not_supported` と `property_not_detected` を先に対応する。",
        "2. `combined_unit` は区画マスタとの対応方針を決める。",
        "3. `temporary_unit_discriminator` は同一表内の重複理由を確認する。",
        "4. 判断結果をルール化してから、全期間へ展開する。",
    ]
    OUTPUT.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Wrote {OUTPUT} from {len(reports)} reports")


if __name__ == "__main__":
    main()
