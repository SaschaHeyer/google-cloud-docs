"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

import { DEFAULT_MAX_PAGES, MAX_PAGE_LIMIT } from "@/lib/harvest-config";

const DEFAULT_URL = "https://cloud.google.com/retail/docs/overview";

type StreamProgress = {
  processed: number;
  discovered: number;
  pending: number;
  current: string | null;
};

type StreamEvent =
  | { type: "progress"; processed: number; discovered: number; pending: number; current?: string }
  | { type: "page"; url: string; index: number }
  | {
      type: "result";
      filename: string;
      combinedText: string;
      pages: string[];
      pageCount: number;
      perPageZipBase64?: string | null;
      perPageZipFilename?: string | null;
    }
  | { type: "error"; message: string };

function deriveBasePrefix(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length <= 1) {
      return segments[0] ? `${url.origin}/${segments[0]}` : url.origin;
    }
    return `${url.origin}/${segments.slice(0, -1).join("/")}`;
  } catch {
    return "";
  }
}

function parseExcludeInput(raw: string) {
  return raw
    .split(/[\n,]/)
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => (value.startsWith("/") ? value : `/${value}`));
}

function fallbackFilename(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    const slug = `${url.hostname}${url.pathname}`
      .replace(/[^a-zA-Z0-9-_]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    return slug ? `${slug}.txt` : "page.txt";
  } catch {
    return "page.txt";
  }
}

export default function Home() {
  const [targetUrl, setTargetUrl] = useState(DEFAULT_URL);
  const [basePrefix, setBasePrefix] = useState(deriveBasePrefix(DEFAULT_URL));
  const [baseTouched, setBaseTouched] = useState(false);
  const [excludesInput, setExcludesInput] = useState("/reference\n/pricing");
  const [preview, setPreview] = useState("");
  const [pages, setPages] = useState<string[]>([]);
  const [includePerPage, setIncludePerPage] = useState(false);
  const [maxPagesInput, setMaxPagesInput] = useState(String(DEFAULT_MAX_PAGES));
  const [progress, setProgress] = useState<StreamProgress>({
    processed: 0,
    discovered: 0,
    pending: 0,
    current: null,
  });
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [downloadName, setDownloadName] = useState("page.txt");
  const [zipDownloadUrl, setZipDownloadUrl] = useState<string | null>(null);
  const [zipDownloadName, setZipDownloadName] = useState("pages.zip");
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!baseTouched) {
      setBasePrefix(deriveBasePrefix(targetUrl));
    }
  }, [targetUrl, baseTouched]);

  useEffect(() => {
    return () => {
      if (downloadUrl) {
        URL.revokeObjectURL(downloadUrl);
      }
      if (zipDownloadUrl) {
        URL.revokeObjectURL(zipDownloadUrl);
      }
    };
  }, [downloadUrl, zipDownloadUrl]);

  useEffect(() => {
    if (!includePerPage && zipDownloadUrl) {
      URL.revokeObjectURL(zipDownloadUrl);
      setZipDownloadUrl(null);
    }
  }, [includePerPage, zipDownloadUrl]);

  useEffect(() => {
    return () => {
      if (abortRef.current) {
        abortRef.current.abort();
      }
    };
  }, []);

  const excludeList = useMemo(() => parseExcludeInput(excludesInput), [excludesInput]);

  const normalizedMaxPages = useMemo(() => {
    const parsed = Number(maxPagesInput);
    if (!Number.isFinite(parsed)) {
      return DEFAULT_MAX_PAGES;
    }
    return Math.max(1, Math.min(Math.floor(parsed), MAX_PAGE_LIMIT));
  }, [maxPagesInput]);

  const directDownloadHref = useMemo(() => {
    if (!targetUrl) {
      return null;
    }
    const params = new URLSearchParams();
    params.set("url", targetUrl);
    if (basePrefix) {
      params.set("base", basePrefix);
    }
    excludeList.forEach((value) => params.append("exclude", value));
    params.set("maxPages", String(normalizedMaxPages));
    return `/api/harvest?${params.toString()}`;
  }, [targetUrl, basePrefix, excludeList, normalizedMaxPages]);

  const directZipHref = useMemo(() => {
    if (!targetUrl || !includePerPage) {
      return null;
    }
    const params = new URLSearchParams();
    params.set("url", targetUrl);
    if (basePrefix) {
      params.set("base", basePrefix);
    }
    excludeList.forEach((value) => params.append("exclude", value));
    params.set("maxPages", String(normalizedMaxPages));
    params.set("includePerPage", "1");
    params.set("format", "zip");
    return `/api/harvest?${params.toString()}`;
  }, [targetUrl, basePrefix, excludeList, normalizedMaxPages, includePerPage]);

  const decodeBase64ToBlob = (base64: string, mime: string) => {
    const binary = atob(base64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type: mime });
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!targetUrl) {
      setError("Enter a start URL to harvest.");
      return;
    }
    if (!basePrefix) {
      setError(
        "Unable to derive a section prefix. Please provide the base path you want to crawl."
      );
      return;
    }

    setIsLoading(true);
    setError(null);
    setPreview("");
    setPages([]);
    setProgress({ processed: 0, discovered: 0, pending: 0, current: null });

    if (downloadUrl) {
      URL.revokeObjectURL(downloadUrl);
      setDownloadUrl(null);
    }
    if (zipDownloadUrl) {
      URL.revokeObjectURL(zipDownloadUrl);
      setZipDownloadUrl(null);
    }

    if (abortRef.current) {
      abortRef.current.abort();
    }

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch("/api/harvest/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: targetUrl,
          basePrefix,
          excludes: excludeList,
          includePerPage,
          maxPages: normalizedMaxPages,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        let message = `Failed to harvest URL (status ${response.status}).`;
        const contentType = response.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
          const data = await response.json().catch(() => null);
          if (data && typeof data.error === "string") {
            message = data.error;
          }
        } else {
          const text = await response.text().catch(() => "");
          if (text) {
            message = text;
          }
        }
        throw new Error(message);
      }

      if (!response.body) {
        throw new Error("Streaming not supported in this environment.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let resolved = false;

      const handleEvent = (raw: string) => {
        if (!raw.trim()) {
          return;
        }
        let event: StreamEvent;
        try {
          event = JSON.parse(raw);
        } catch {
          console.warn("Skipping malformed event", raw);
          return;
        }

        if (event.type === "progress") {
          setProgress({
            processed: event.processed,
            discovered: event.discovered,
            pending: event.pending,
            current: event.current ?? null,
          });
          return;
        }

        if (event.type === "page") {
          setPages((prev) => (prev.includes(event.url) ? prev : [...prev, event.url]));
          return;
        }

        if (event.type === "result") {
          resolved = true;
          setPreview(event.combinedText);
          setPages(event.pages);
          const filename = event.filename || fallbackFilename(basePrefix || targetUrl);
          const blob = new Blob([event.combinedText], { type: "text/plain;charset=utf-8" });
          const objectUrl = URL.createObjectURL(blob);
          setDownloadUrl(objectUrl);
          setDownloadName(filename);
          if (event.perPageZipBase64) {
            const zipBlob = decodeBase64ToBlob(event.perPageZipBase64, "application/zip");
            const perPageUrl = URL.createObjectURL(zipBlob);
            setZipDownloadUrl(perPageUrl);
            setZipDownloadName(event.perPageZipFilename || "pages.zip");
          }
          return;
        }

        if (event.type === "error") {
          throw new Error(event.message);
        }
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          handleEvent(line);
        }
      }

      if (buffer) {
        handleEvent(buffer);
      }

      if (!resolved) {
        throw new Error("Harvest stream ended without delivering results.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unexpected error.");
    } finally {
      setIsLoading(false);
      abortRef.current = null;
    }
  };

  return (
    <div className="min-h-screen bg-zinc-50 py-10 text-zinc-900">
      <main className="mx-auto grid max-w-6xl gap-8 rounded-3xl bg-white p-8 shadow-sm lg:grid-cols-[minmax(320px,1fr)_minmax(420px,1.4fr)] lg:p-12">
        <div className="flex flex-col gap-6 border-zinc-100 lg:border-r lg:pr-10">
          <section className="rounded-2xl border border-zinc-200 bg-zinc-50/60 p-5 text-sm text-zinc-700">
            <p className="text-base font-semibold text-zinc-900">Crawl progress</p>
            <dl className="mt-3 grid grid-cols-3 gap-4 text-center text-sm">
              <div>
                <dt className="text-xs uppercase tracking-wide text-zinc-500">Processed</dt>
                <dd className="text-2xl font-semibold text-zinc-900">{progress.processed}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-zinc-500">Discovered</dt>
                <dd className="text-2xl font-semibold text-zinc-900">{progress.discovered}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-zinc-500">Pending</dt>
                <dd className="text-2xl font-semibold text-zinc-900">{progress.pending}</dd>
              </div>
            </dl>
            {progress.current && (
              <p className="mt-3 truncate text-xs text-zinc-500">
                Currently crawling: <span className="font-mono text-zinc-700">{progress.current}</span>
              </p>
            )}
            <p className="mt-3 text-xs text-zinc-500">
              Saved {pages.length} page{pages.length === 1 ? "" : "s"} with extractable text so far. Crawl stops at {normalizedMaxPages} pages unless you raise the max-pages control.
            </p>
            {progress.processed >= normalizedMaxPages && (
              <p className="mt-1 text-xs text-amber-600">
                Reached the current max-pages limit. Increase it to capture the remaining documents.
              </p>
            )}
          </section>

          <section className="space-y-3">
            <div className="flex items-baseline justify-between">
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.2em] text-blue-500">
                  Pages processed
                </p>
                <p className="text-xs text-zinc-500">
                  {pages.length || progress.processed} page
                  {(pages.length || progress.processed) === 1 ? "" : "s"} crawled under the provided
                  prefix.
                </p>
              </div>
              <span className="text-3xl font-semibold text-zinc-900">
                {pages.length || progress.processed}
              </span>
            </div>
            <div className="rounded-2xl border border-zinc-200 bg-zinc-50/70 p-4">
              {pages.length ? (
                <ol className="space-y-1 text-sm text-zinc-700">
                  {pages.map((page) => (
                    <li key={page} className="font-mono text-xs text-zinc-600 break-all">
                      # {page}
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-sm text-zinc-500">
                  Pages will appear here as soon as the crawl begins.
                </p>
              )}
            </div>
          </section>

          <section className="rounded-2xl bg-zinc-50/70 p-5 text-sm text-zinc-600">
            <p className="text-base font-semibold text-zinc-900">How it works</p>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              <li>Breadth-first crawl with polite throttling under your section prefix.</li>
              <li>Cheerio removes markup, scripts, and styles from every page.</li>
              <li>All pages are concatenated with `# Source:` headers into one `.txt`.</li>
            </ul>
          </section>
        </div>

        <div className="flex flex-col gap-6">
          <header className="space-y-2">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-blue-500">
              Documentation Harvester
            </p>
            <h1 className="text-3xl font-semibold text-zinc-900">
              Crawl a docs section and receive a clean .txt bundle
            </h1>
            <p className="text-base text-zinc-600">
              We start at your seed page, follow links that stay within the same section prefix, skip
              any excluded subpaths, and combine every page into a single text file.
            </p>
          </header>

          <form onSubmit={handleSubmit} className="space-y-5">
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-zinc-700">Start URL</label>
            <input
              type="url"
              required
              value={targetUrl}
              onChange={(event) => setTargetUrl(event.target.value)}
              placeholder="https://cloud.google.com/retail/docs/overview"
              className="w-full rounded-lg border border-zinc-300 bg-white px-4 py-3 text-base shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            />
            <p className="text-xs text-zinc-500">
              Must belong to the docs section you want to mirror.
            </p>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium text-zinc-700">Section prefix</label>
            <input
              type="url"
              required
              value={basePrefix}
              onChange={(event) => {
                setBaseTouched(true);
                setBasePrefix(event.target.value);
              }}
              placeholder="https://cloud.google.com/retail/docs"
              className="w-full rounded-lg border border-zinc-300 bg-white px-4 py-3 text-base shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            />
            <p className="text-xs text-zinc-500">
              Only links that stay under this prefix will be enqueued.
            </p>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium text-zinc-700">Excluded subpaths</label>
            <textarea
              value={excludesInput}
              onChange={(event) => setExcludesInput(event.target.value)}
              rows={3}
              className="w-full rounded-lg border border-zinc-300 bg-white px-4 py-3 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            />
            <p className="text-xs text-zinc-500">
              One per line (or comma separated). Prefix with `/` to skip sections like
              `/reference` or `/pricing`.
            </p>
          </div>

          <div className="flex flex-col gap-2 rounded-xl border border-zinc-200 bg-zinc-50/70 px-4 py-3">
            <label className="inline-flex items-center gap-2 text-sm font-medium text-zinc-700">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-zinc-300 text-blue-600 focus:ring-blue-500"
                checked={includePerPage}
                onChange={(event) => setIncludePerPage(event.target.checked)}
              />
              Create a per-page ZIP bundle
            </label>
            <p className="text-xs text-zinc-500">
              When enabled, every crawled page is saved as its own `.txt` file and zipped alongside
              the combined corpus for download.
            </p>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium text-zinc-700">Max pages</label>
            <input
              type="number"
              min={1}
              max={MAX_PAGE_LIMIT}
              value={maxPagesInput}
              onChange={(event) => setMaxPagesInput(event.target.value)}
              className="w-full rounded-lg border border-zinc-300 bg-white px-4 py-3 text-base shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            />
            <p className="text-xs text-zinc-500">
              Stops after this many fetches (hard cap {MAX_PAGE_LIMIT}). Increase for larger sections.
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <button
              type="submit"
              disabled={isLoading}
              className="inline-flex items-center justify-center rounded-full bg-blue-600 px-6 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isLoading ? "Harvesting..." : "Preview & Generate"}
            </button>
            {directDownloadHref && (
              <a
                className="inline-flex items-center justify-center rounded-full border border-zinc-300 px-6 py-2.5 text-sm font-semibold text-zinc-700 transition hover:border-zinc-400 disabled:cursor-not-allowed disabled:opacity-60"
                href={downloadUrl ?? directDownloadHref}
                {...(downloadUrl
                  ? { download: downloadName, target: "_self" }
                  : { target: "_blank", rel: "noopener noreferrer" })}
              >
                Direct download
              </a>
            )}
            {includePerPage && directZipHref && (
              <a
                className="inline-flex items-center justify-center rounded-full border border-zinc-300 px-6 py-2.5 text-sm font-semibold text-zinc-700 transition hover:border-zinc-400 disabled:cursor-not-allowed disabled:opacity-60"
                href={zipDownloadUrl ?? directZipHref}
                {...(zipDownloadUrl
                  ? { download: zipDownloadName, target: "_self" }
                  : { target: "_blank", rel: "noopener noreferrer" })}
              >
                Per-page ZIP
              </a>
            )}
          </div>
        </form>

          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
              {error}
            </div>
          )}

          <section className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-base font-semibold text-zinc-900">Combined plain-text preview</h2>
              <div className="flex flex-wrap gap-3">
                {downloadUrl && (
                  <a
                    className="text-sm font-medium text-blue-600 underline offset-2"
                    href={downloadUrl}
                    download={downloadName}
                  >
                    Download {downloadName}
                  </a>
                )}
                {zipDownloadUrl && (
                  <a
                    className="text-sm font-medium text-blue-600 underline offset-2"
                    href={zipDownloadUrl}
                    download={zipDownloadName}
                  >
                    Download {zipDownloadName}
                  </a>
                )}
              </div>
            </div>
            <textarea
              readOnly
              value={preview}
              placeholder="Your cleaned documentation text will appear here."
              className="h-72 w-full resize-none rounded-xl border border-zinc-200 bg-zinc-50/80 px-4 py-3 text-sm font-mono leading-relaxed text-zinc-800"
            />
          </section>
        </div>
      </main>
    </div>
  );
}
