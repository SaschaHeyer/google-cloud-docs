# Google Cloud Docs Harvester

Automate harvesting of Google Cloud documentation into reusable plain-text archives. The workflow consists of three Python scripts managed with [uv](https://github.com/astral-sh/uv).

## Prerequisites

- Python 3.12 (uv creates and manages the virtual environment for you)
- [uv CLI](https://github.com/astral-sh/uv) installed

Initialize the project (only once):

```bash
uv init
uv add beautifulsoup4 certifi
```

These commands are already reflected in `pyproject.toml` if you cloned this repo.

## 1. Crawl Documentation Links

`crawl_links.py` traverses a documentation section and streams every matching URL to `links.txt`.

```bash
uv run crawl_links.py \
  https://cloud.google.com/retail/docs/overview \
  https://cloud.google.com/retail/docs \
  links.txt \
  -x /reference/ \
  -x /pricing/
```

- **start_url**: initial page to visit.
- **base_prefix**: only URLs under this prefix are enqueued.
- **output** (optional): file to append discovered links (default `links.txt`).
- `-x/--exclude`: skip paths relative to the prefix (repeatable).
- Progress appears on stderr; links are appended as they are found.

## 2. Extract Plain Text for Each Page

`extract_text.py` downloads every link listed in `links.txt`, removes markup with BeautifulSoup, and writes the page text to `pages/<domain>/.../*.txt`.

```bash
uv run extract_text.py links.txt pages --sleep 0.25
```

- **link_file** (optional): source list (default `links.txt`).
- **output_dir** (optional): destination directory (default `pages`).
- `--sleep`: throttle between requests (seconds).

## 3. Combine Individual Exports

`combine_texts.py` concatenates every `.txt` beneath `pages/` into a single `all.txt`, keeping the originals intact.

```bash
uv run combine_texts.py pages all.txt
```

- **input_dir** (optional): folder containing the per-page files.
- **output_file** (optional): combined output path.
- Each section is prefixed with `# Source: relative/path.txt` for traceability.

## Suggested Workflow

1. Crawl the docs to refresh `links.txt`.
2. Extract text for each URL.
3. Combine all text files into a single corpus for downstream processing (search, indexing, LLM fine-tuning, etc.).

Feel free to adjust the scripts (e.g., different exclusions, output formats) to match your documentation harvesting needs. PRs welcome!
