"""Prepare the approved fixed-term building lease for Adobe Document Generation.

The original source is never changed.  This script makes a copy, replaces only
the variable contract slots with Adobe tags, and leaves all fixed legal clauses,
tables, styles, drawings, headers, and footers intact.
"""

from __future__ import annotations

import argparse
from pathlib import Path

from docx import Document
from docx.table import _Cell
from docx.text.paragraph import Paragraph


def replace_paragraph(paragraph: Paragraph, value: str) -> None:
    """Replace text without changing paragraph-level layout properties."""
    if paragraph.runs:
        paragraph.runs[0].text = value
        for run in paragraph.runs[1:]:
            run.text = ""
    else:
        paragraph.add_run(value)


def replace_cell(cell: _Cell, value: str) -> None:
    replace_paragraph(cell.paragraphs[0], value)
    for paragraph in cell.paragraphs[1:]:
        replace_paragraph(paragraph, "")


def find_paragraph(document: Document, expected: str) -> Paragraph:
    for paragraph in document.paragraphs:
        if paragraph.text == expected:
            return paragraph
    raise ValueError(f"Required source paragraph was not found: {expected}")


def remove_paragraph(paragraph: Paragraph) -> None:
    paragraph._element.getparent().remove(paragraph._element)


def replace_terms_with_tag(document: Document) -> str:
    """Extract Articles 1-28 and replace their source paragraphs with one tag."""
    paragraphs = list(document.paragraphs)
    terms_start_index = next(
        index
        for index, paragraph in enumerate(paragraphs)
        if paragraph.text.strip().startswith("第１条（")
    )
    terms_end_index = next(
        index
        for index, paragraph in enumerate(paragraphs[terms_start_index + 1 :], terms_start_index + 1)
        if paragraph.text.strip().startswith("本契約の証として")
    )
    terms_text = "\n".join(
        paragraph.text.strip()
        for paragraph in paragraphs[terms_start_index:terms_end_index]
        if paragraph.text.strip()
    )
    replace_paragraph(paragraphs[terms_start_index], "{{termsText}}")
    for paragraph in paragraphs[terms_start_index + 1 : terms_end_index]:
        remove_paragraph(paragraph)
    return terms_text


def create_template(source: Path, destination: Path) -> str:
    document = Document(source)
    if len(document.tables) != 3:
        raise ValueError("The approved source must contain the contract-summary and two restoration tables.")

    summary = document.tables[0]
    values = {
        2: "{{tenantName}}",
        3: "{{guarantorName}}（極度額 {{guarantorLimitAmount}} 円を上限とする）",
        4: "{{propertyName}}",
        5: "{{propertyLotAddress}}",
        6: "{{propertyAddress}}",
        7: "{{buildingStructure}}",
        8: "{{floorLabel}}階 {{unitNames}} {{leasedAreaSqm}}㎡（{{leasedAreaTsubo}}坪） （添付図面斜線部分）",
        9: "{{usePurpose}}",
        10: "{{contractStartDate}}から {{contractEndDate}}まで（{{contractDurationYears}}年）",
        11: "月額金 {{monthlyRentAmount}} 円（税別）",
        12: "{{rentPaymentDue}}",
        13: "{{dailyCalculationMethod}}",
        14: "金 {{depositAmount}} 円（月額賃料 {{depositMonths}} ヶ月分）",
        15: "{{specialProvisions}}",
    }
    for row_index, value in values.items():
        replace_cell(summary.rows[row_index].cells[1], value)

    terms_text = replace_terms_with_tag(document)

    replace_paragraph(find_paragraph(document, "賃借人\u3000"), "賃借人\u3000{{tenantName}}")
    replace_paragraph(
        find_paragraph(document, "賃貸人 ＳＫハウジング株式会社と、賃借人 〇〇との間に、貸室に関する賃貸借契約（以下「本契約」という）を次のとおり締結する。"),
        "賃貸人 ＳＫハウジング株式会社と、賃借人 {{tenantName}} との間に、貸室に関する賃貸借契約（以下「本契約」という）を次のとおり締結する。",
    )
    replace_paragraph(find_paragraph(document, "\t\t\t賃借人：\u3000\u3000"), "\t\t\t賃借人：\u3000\u3000{{tenantName}}")
    replace_paragraph(find_paragraph(document, "\t\t\u3000\u3000連帯保証人："), "\t\t\u3000\u3000連帯保証人：{{guarantorName}}")
    replace_paragraph(find_paragraph(document, "\t\t\u3000\u3000\u3000仲介業者："), "\t\t\u3000\u3000\u3000仲介業者：{{brokerName}}")
    replace_paragraph(find_paragraph(document, "\u3000\u3000階\u3000\u3000\u3000㎡（\u3000\u3000坪）"), "\u3000\u3000{{floorLabel}}階\u3000\u3000{{leasedAreaSqm}}㎡（{{leasedAreaTsubo}}坪）")

    # The approved template already reserves the following page for the plan.
    # This paragraph is intentionally flow-based so Adobe can place the selected
    # contract-unit snapshot without changing the legal clauses or restoration tables.
    plan_heading = find_paragraph(document, "【本物件平面図】")
    next_element = plan_heading._element.getnext()
    while next_element is not None and not next_element.tag.endswith("}p"):
        next_element = next_element.getnext()
    if next_element is None:
        raise ValueError("No paragraph is available below the floor-plan heading.")
    replace_paragraph(Paragraph(next_element, plan_heading._parent), "{{planImage}}")

    destination.parent.mkdir(parents=True, exist_ok=True)
    document.save(destination)
    return terms_text


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--terms-output", type=Path)
    args = parser.parse_args()
    terms_text = create_template(args.source, args.destination)
    if args.terms_output:
        args.terms_output.parent.mkdir(parents=True, exist_ok=True)
        args.terms_output.write_text(terms_text, encoding="utf-8")


if __name__ == "__main__":
    main()
