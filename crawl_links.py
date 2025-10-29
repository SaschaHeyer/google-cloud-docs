#!/usr/bin/env python3
"""
Crawl a documentation section and capture all internal links.

Usage:
    python crawl_links.py \
        https://cloud.google.com/retail/docs/overview \
        https://cloud.google.com/retail/docs \
        links.txt
"""

from __future__ import annotations

import argparse
import collections
import sys
import time
import ssl
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from typing import Iterable, Sequence, Set, TextIO

import certifi


class AnchorCollector(HTMLParser):
    """Collects unique anchor href attributes from an HTML document."""

    def __init__(self) -> None:
        super().__init__()
        self._hrefs: Set[str] = set()

    def handle_starttag(self, tag: str, attrs: Iterable[tuple[str, str]]) -> None:
        if tag != "a":
            return
        for attr, value in attrs:
            if attr == "href" and value:
                self._hrefs.add(value)

    def hrefs(self) -> Set[str]:
        return self._hrefs


_SSL_CONTEXT = ssl.create_default_context(cafile=certifi.where())


def fetch_html(url: str, timeout: float = 15.0) -> str:
    """Fetch the HTML content for a URL, returning an empty string on failure."""
    request = urllib.request.Request(
        url,
        headers={
            # Use a standard UA to avoid immediate blocking by some servers.
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


def normalize_url(url: str) -> str:
    """Normalize URL by removing fragments and redundant trailing slash."""
    parsed = urllib.parse.urlsplit(url)
    cleaned = parsed._replace(fragment="")
    normalized = urllib.parse.urlunsplit(cleaned)
    if normalized.endswith("/") and len(normalized) > len(cleaned.scheme) + 3:
        # Keep root slash (e.g. https://example.com/), trim only deeper paths.
        normalized = normalized.rstrip("/")
    return normalized


def is_allowed(url: str, base_prefix: str, excludes: Sequence[str]) -> bool:
    """Return True if the URL starts with base_prefix and is not excluded."""
    if not url.startswith(base_prefix):
        return False

    base_parts = urllib.parse.urlsplit(base_prefix)
    url_parts = urllib.parse.urlsplit(url)

    # Compute the path relative to the base prefix path.
    relative_path = url_parts.path[len(base_parts.path) :]
    for raw in excludes:
        normalized = raw if raw.startswith("/") else f"/{raw}"
        if relative_path.startswith(normalized):
            return False

    return True


def crawl(start_url: str, base_prefix: str, excludes: Sequence[str], sink: TextIO) -> Set[str]:
    """Breadth-first crawl starting from start_url within base_prefix."""
    visited: Set[str] = set()
    discovered: Set[str] = set()
    queue: collections.deque[str] = collections.deque()

    normalized_base = normalize_url(base_prefix)

    normalized_start = normalize_url(
        urllib.parse.urljoin(normalized_base + "/", start_url)
    )
    if not is_allowed(normalized_start, normalized_base, excludes):
        raise ValueError(
            f"Start URL {normalized_start} is outside the permitted prefix {normalized_base}"
        )

    queue.append(normalized_start)
    discovered.add(normalized_start)
    sink.write(f"{normalized_start}\n")
    sink.flush()
    print(f"queued start URL {normalized_start}", file=sys.stderr)

    while queue:
        current = queue.popleft()
        if current in visited:
            continue
        visited.add(current)

        print(
            f"[{len(visited)} processed | {len(discovered)} discovered | {len(queue)} pending] "
            f"fetching {current}",
            file=sys.stderr,
        )

        html = fetch_html(current)
        if not html:
            continue

        parser = AnchorCollector()
        parser.feed(html)

        for href in parser.hrefs():
            absolute = urllib.parse.urljoin(current + "/", href)
            absolute = normalize_url(absolute)
            if not absolute.startswith(("http://", "https://")):
                continue
            if not is_allowed(absolute, normalized_base, excludes):
                continue
            if absolute not in discovered:
                discovered.add(absolute)
                queue.append(absolute)
                sink.write(f"{absolute}\n")
                sink.flush()
        time.sleep(0.25)  # Be a little polite; adjust if necessary.

    return discovered


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Crawl documentation pages beneath a URL prefix."
    )
    parser.add_argument("start_url", help="Initial page to crawl")
    parser.add_argument(
        "base_prefix",
        help="Only follow links that begin with this prefix (e.g. https://cloud.google.com/retail/docs)",
    )
    parser.add_argument(
        "output",
        nargs="?",
        default="links.txt",
        help="Path for the newline-delimited link list (default: links.txt)",
    )
    parser.add_argument(
        "--exclude",
        "-x",
        action="append",
        default=[],
        help=(
            "Skip links whose path under the prefix starts with this segment "
            "(e.g. --exclude /reference/). Can be provided multiple times."
        ),
    )
    args = parser.parse_args(argv)

    try:
        with open(args.output, "w", encoding="utf-8") as handle:
            links = crawl(
                args.start_url,
                args.base_prefix.rstrip("/"),
                args.exclude,
                handle,
            )
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    print(f"Collected {len(links)} unique links into {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
