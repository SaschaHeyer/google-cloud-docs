#!/usr/bin/env python3
"""
Fetch text content from a list of documentation URLs and persist plain-text files.

Usage:
    python extract_text.py links.txt pages

If the output directory is omitted it defaults to `pages`.
"""

from __future__ import annotations

import argparse
import os
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Iterable

import certifi
from bs4 import BeautifulSoup


_SSL_CONTEXT = ssl.create_default_context(cafile=certifi.where())


def read_links(path: Path) -> Iterable[str]:
    """Yield normalized, non-empty URLs from the provided file."""
    with path.open("r", encoding="utf-8") as handle:
        for raw in handle:
            url = raw.strip()
            if url:
                yield url


def fetch_html(url: str, timeout: float = 20.0) -> str:
    """Fetch HTML for url returning empty string on failure."""
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": (
                "Mozilla/5.0 (X11; Linux x86_64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/129.0 Safari/537.36"
            )
        },
    )
    try:
        with urllib.request.urlopen(
            request, timeout=timeout, context=_SSL_CONTEXT
        ) as response:
            charset = response.headers.get_content_charset() or "utf-8"
            return response.read().decode(charset, errors="replace")
    except (urllib.error.URLError, urllib.error.HTTPError, UnicodeDecodeError) as exc:
        print(f"warning: failed to fetch {url} ({exc})", file=sys.stderr)
        return ""


def derive_output_path(base_dir: Path, url: str) -> Path:
    """Map a URL to a filesystem path within base_dir."""
    parsed = urllib.parse.urlsplit(url)

    # Build directory structure mirroring the URL path.
    segments = [seg for seg in parsed.path.strip("/").split("/") if seg]
    if not segments:
        segments = ["index"]

    filename = segments[-1]
    # Strip common extensions; default to index when necessary.
    name, _, _ = filename.partition(".")
    name = name or "index"
    segments[-1] = f"{name}.txt"

    # Include host to avoid collisions across different domains.
    return base_dir.joinpath(parsed.netloc, *segments)


def extract_text(html: str) -> str:
    """Convert HTML into cleaned text."""
    soup = BeautifulSoup(html, "html.parser")
    # Remove script and style elements that pollute text output.
    for tag in soup(["script", "style", "noscript"]):
        tag.decompose()
    return soup.get_text(separator="\n", strip=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Fetch each URL from a list and save its plain-text content."
    )
    parser.add_argument(
        "link_file",
        nargs="?",
        default="links.txt",
        help="Path to the newline-delimited link list (default: links.txt)",
    )
    parser.add_argument(
        "output_dir",
        nargs="?",
        default="pages",
        help="Directory where text files will be written (default: pages)",
    )
    parser.add_argument(
        "--sleep",
        type=float,
        default=0.25,
        help="Delay between requests in seconds (default: 0.25)",
    )
    args = parser.parse_args(argv)

    link_path = Path(args.link_file)
    if not link_path.exists():
        print(f"error: link file {link_path} does not exist", file=sys.stderr)
        return 1

    output_base = Path(args.output_dir)
    total = 0
    successes = 0

    for url in read_links(link_path):
        total += 1
        print(f"[{total}] fetching {url}", file=sys.stderr)
        html = fetch_html(url)
        if not html:
            continue

        text = extract_text(html)
        if not text:
            print(f"warning: no textual content extracted from {url}", file=sys.stderr)
            continue

        target_path = derive_output_path(output_base, url)
        target_path.parent.mkdir(parents=True, exist_ok=True)
        target_path.write_text(text, encoding="utf-8")
        successes += 1
        print(f"    wrote {target_path}", file=sys.stderr)
        time.sleep(args.sleep)

    print(f"Processed {total} URLs, stored {successes} text files in {output_base}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
