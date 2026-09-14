"""Extract the Article 1 onward terms body from an approved lease DOCX."""

from __future__ import annotations

import argparse
from pathlib import Path

from docx import Document


def extract_terms(source: Path) -> str:
    document = Document(source)
    paragraphs = list(document.paragraphs)
    start = next(
        index
        for index, paragraph in enumerate(paragraphs)
        if paragraph.text.strip().startswith("第１条（")
    )
    end = next(
        index
        for index, paragraph in enumerate(paragraphs[start + 1 :], start + 1)
        if paragraph.text.strip().startswith("本契約の証として")
    )
    return "\n".join(
        paragraph.text.strip()
        for paragraph in paragraphs[start:end]
        if paragraph.text.strip()
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(extract_terms(args.source), encoding="utf-8")


if __name__ == "__main__":
    main()
