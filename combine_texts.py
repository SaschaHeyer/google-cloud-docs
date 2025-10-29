#!/usr/bin/env python3
"""
Combine plain-text exports into a single aggregate file while preserving originals.

Usage:
    python combine_texts.py pages all.txt

If the output path is omitted it defaults to `all.txt`.
"""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Iterable


def gather_text_files(root: Path) -> Iterable[Path]:
    """Yield all .txt files beneath root, sorted for deterministic ordering."""
    for path in sorted(root.rglob("*.txt")):
        yield path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Concatenate text files from a directory into a single file."
    )
    parser.add_argument(
        "input_dir",
        nargs="?",
        default="pages",
        help="Directory containing per-page .txt files (default: pages)",
    )
    parser.add_argument(
        "output_file",
        nargs="?",
        default="all.txt",
        help="Aggregated output file path (default: all.txt)",
    )
    args = parser.parse_args(argv)

    root = Path(args.input_dir)
    if not root.exists():
        parser.error(f"input directory {root} does not exist")

    output_path = Path(args.output_file)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with output_path.open("w", encoding="utf-8") as destination:
        count = 0
        for text_file in gather_text_files(root):
            if text_file == output_path:
                continue
            destination.write(f"# Source: {text_file.relative_to(root)}\n")
            destination.write(text_file.read_text(encoding="utf-8"))
            destination.write("\n\n")
            count += 1

    print(f"Combined {count} files into {output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
