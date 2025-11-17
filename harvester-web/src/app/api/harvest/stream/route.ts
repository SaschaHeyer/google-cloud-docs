import { NextRequest } from "next/server";
import {
  DEFAULT_MAX_PAGES,
  MAX_PAGE_LIMIT,
  HarvestPayload,
  crawlAndExtract,
  combineSections,
  deriveBasePrefix,
  sanitizeFilename,
  toExcludeList,
  normalizeUrl,
  ProgressCallback,
} from "@/lib/crawler";
import { buildPerPageZip } from "@/lib/zip";

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

const encoder = new TextEncoder();

function encodeEvent(event: StreamEvent) {
  return encoder.encode(`${JSON.stringify(event)}\n`);
}

async function parsePayload(req: NextRequest): Promise<HarvestPayload | null> {
  const contentType = req.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    return null;
  }

  const data = await req.json().catch(() => null);
  if (!data || typeof data.url !== "string") {
    return null;
  }

  return {
    url: data.url,
    basePrefix:
      typeof data.basePrefix === "string" && data.basePrefix ? data.basePrefix : undefined,
    excludes: toExcludeList(data.excludes),
    maxPages:
      typeof data.maxPages === "number" && Number.isFinite(data.maxPages)
        ? data.maxPages
        : undefined,
    includePerPage: Boolean(data.includePerPage),
  };
}

export async function POST(req: NextRequest) {
  const payload = await parsePayload(req);
  if (!payload) {
    return Response.json({ error: "Provide a JSON body with at least a url field." }, { status: 400 });
  }

  if (!payload.url) {
    return Response.json({ error: "Provide a valid URL." }, { status: 400 });
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      (async () => {
        try {
          const start = new URL(payload.url);
          const basePrefix = payload.basePrefix
            ? normalizeUrl(payload.basePrefix)
            : deriveBasePrefix(start);
          const excludes = payload.excludes ?? [];
          const maxPages = Math.max(
            1,
            Math.min(payload.maxPages ?? DEFAULT_MAX_PAGES, MAX_PAGE_LIMIT)
          );

          const processedPages: string[] = [];
          const progressHandler: ProgressCallback = (event) => {
            controller.enqueue(
              encodeEvent({
                type: "progress",
                processed: event.processed,
                discovered: event.discovered,
                pending: event.pending,
                current: event.current,
              })
            );

            if (event.lastCompleted) {
              if (!processedPages.includes(event.lastCompleted)) {
                processedPages.push(event.lastCompleted);
                controller.enqueue(
                  encodeEvent({
                    type: "page",
                    url: event.lastCompleted,
                    index: processedPages.length,
                  })
                );
              }
            }
          };

          const sections = await crawlAndExtract(
            start.toString(),
            basePrefix,
            excludes,
            maxPages,
            progressHandler
          );
          if (!sections.length) {
            throw new Error("No textual content extracted from the crawl scope.");
          }

          const combined = combineSections(sections);
          const filename = sanitizeFilename(new URL(basePrefix));
          let perPageZipBase64: string | null = null;
          let perPageZipFilename: string | null = null;
          if (payload.includePerPage) {
            const bundle = await buildPerPageZip(sections, basePrefix);
            perPageZipBase64 = Buffer.from(bundle.content).toString("base64");
            perPageZipFilename = bundle.filename;
          }
          controller.enqueue(
            encodeEvent({
              type: "result",
              filename,
              combinedText: combined,
              pages: sections.map((section) => section.url),
              pageCount: sections.length,
              perPageZipBase64,
              perPageZipFilename,
            })
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Unexpected error occurred.";
          controller.enqueue(encodeEvent({ type: "error", message }));
        } finally {
          controller.close();
        }
      })();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
