import { NextRequest } from "next/server";
import {
  DEFAULT_MAX_PAGES,
  MAX_PAGE_LIMIT,
  HarvestPayload,
  ResponseType,
  crawlAndExtract,
  combineSections,
  deriveBasePrefix,
  sanitizeFilename,
  toExcludeList,
  normalizeUrl,
} from "@/lib/crawler";
import { buildPerPageZip } from "@/lib/zip";

function encodeBase64(content: Uint8Array) {
  return Buffer.from(content).toString("base64");
}

async function buildResponse(payload: HarvestPayload) {
  if (!payload.url) {
    throw new Error("Provide a valid URL.");
  }

  const start = new URL(payload.url);
  const basePrefix = payload.basePrefix
    ? normalizeUrl(payload.basePrefix)
    : deriveBasePrefix(start);
  const excludes = payload.excludes ?? [];
  const maxPages = Math.max(1, Math.min(payload.maxPages ?? DEFAULT_MAX_PAGES, MAX_PAGE_LIMIT));
  const includePerPage = payload.includePerPage || payload.responseType === "zip";

  const sections = await crawlAndExtract(start.toString(), basePrefix, excludes, maxPages);
  if (!sections.length) {
    throw new Error("No textual content extracted from the crawl scope.");
  }

  const combined = combineSections(sections);
  const filename = sanitizeFilename(new URL(basePrefix));
  const responseType: ResponseType = payload.responseType ?? "text";

  let zipBundle: { filename: string; content: Uint8Array } | null = null;
  if (includePerPage) {
    zipBundle = await buildPerPageZip(sections, basePrefix);
  }

  if (responseType === "json") {
    return Response.json({
      filename,
      combinedText: combined,
      pages: sections.map((section) => section.url),
      pageCount: sections.length,
      perPageZipBase64: zipBundle ? encodeBase64(zipBundle.content) : null,
      perPageZipFilename: zipBundle ? zipBundle.filename : null,
    });
  }

  if (responseType === "zip") {
    if (!zipBundle) {
      throw new Error("Zip bundle could not be created.");
    }
    return new Response(zipBundle.content, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${zipBundle.filename}"`,
      },
    });
  }

  return new Response(combined, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "X-Plaintext-Filename": filename,
      "X-Harvest-Page-Count": String(sections.length),
    },
  });
}

async function parseBodyPayload(req: NextRequest): Promise<HarvestPayload | null> {
  const contentType = req.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
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
      responseType: data.responseType === "json" ? "json" : undefined,
      includePerPage: Boolean(data.includePerPage),
    };
  }

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const form = await req.formData();
    const url = form.get("url");
    if (typeof url !== "string") {
      return null;
    }
    const base = form.get("base");
    const excludes = form
      .getAll("exclude")
      .filter((value): value is string => typeof value === "string");
    const maxPagesRaw = form.get("maxPages");
    return {
      url,
      basePrefix: typeof base === "string" && base ? base : undefined,
      excludes: excludes.length ? toExcludeList(excludes) : toExcludeList(form.get("excludes")),
      maxPages:
        typeof maxPagesRaw === "string" && maxPagesRaw ? Number(maxPagesRaw) : undefined,
      responseType:
        typeof form.get("responseType") === "string" && form.get("responseType") === "json"
          ? "json"
          : undefined,
      includePerPage: form.get("includePerPage") === "on",
    };
  }

  return null;
}

function parseBoolean(value: string | null): boolean | undefined {
  if (!value) {
    return undefined;
  }
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parseQueryPayload(req: NextRequest): HarvestPayload | null {
  const url = req.nextUrl.searchParams.get("url");
  if (!url) {
    return null;
  }

  const basePrefix = req.nextUrl.searchParams.get("base") || undefined;
  const maxPagesRaw = req.nextUrl.searchParams.get("maxPages");
  const excludes = req.nextUrl.searchParams.getAll("exclude");
  const fallbackExcludes = req.nextUrl.searchParams.get("excludes") || undefined;
  const includePerPage = parseBoolean(req.nextUrl.searchParams.get("includePerPage"));
  const format = req.nextUrl.searchParams.get("format");
  let responseType: ResponseType | undefined;
  if (format === "zip") {
    responseType = "zip";
  }

  return {
    url,
    basePrefix,
    excludes: excludes.length ? toExcludeList(excludes) : toExcludeList(fallbackExcludes),
    maxPages: maxPagesRaw ? Number(maxPagesRaw) : undefined,
    includePerPage: includePerPage ?? (responseType === "zip" ? true : undefined),
    responseType,
  };
}

async function handleRequest(payload: HarvestPayload | null) {
  if (!payload) {
    return Response.json({ error: "Provide at least a url parameter." }, { status: 400 });
  }

  try {
    return await buildResponse(payload);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected error occurred.";
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const payload = await parseBodyPayload(req);
  return handleRequest(payload);
}

export async function GET(req: NextRequest) {
  const payload = parseQueryPayload(req);
  return handleRequest(payload);
}
