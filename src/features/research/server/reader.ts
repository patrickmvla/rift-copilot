/* eslint-disable @typescript-eslint/no-explicit-any */
import "server-only";
import Firecrawl from "@mendable/firecrawl-js";
import { env } from "@/lib/env";
import { logger, logError, startSpan } from "@/lib/logger";
import { sanitizeText } from "@/lib/text";

export type ReaderOptions = {
  timeoutMs?: number;
  maxBytes?: number;
  prefer?: "jina" | "raw"; // 'jina' = external reader (Firecrawl)
  signal?: AbortSignal;
  userAgent?: string;
};

export type ReadResult = {
  text: string;
  html: string | null;
  finalUrl?: string;
  title?: string | null;
  lang?: string | null;
  contentType?: string | null;
  httpStatus?: number;
  from: "jina" | "raw";
};

const DEFAULT_TIMEOUT = env.REQUEST_TIMEOUT_MS;
const DEFAULT_MAX_BYTES = 2_500_000;
const UA_DEFAULT =
  "EvidenceCopilot/1.0 (+research-copilot; https://example.com)";

// Module-wide pause window after rate-limit
let FIRECRAWL_PAUSED_UNTIL = 0;

/* ------------------------------- Public API -------------------------------- */

export async function readUrl(
  url: string,
  options: ReaderOptions = {}
): Promise<ReadResult> {
  const log = logger.child({ mod: "reader" });
  const span = startSpan(log, "readUrl");

  const normalized = normalizeUrl(url);
  const prefer = options.prefer ?? "jina";

  try {
    const paused = Date.now() < FIRECRAWL_PAUSED_UNTIL;
    if (prefer === "jina" && !paused) {
      try {
        const res = await fetchViaFirecrawl(normalized, options);
        span.end({ from: "jina", bytes: res.text.length });
        return res;
      } catch (e) {
        logError(log, e, "Firecrawl reader failed; falling back to raw fetch", {
          url: normalized,
        });
      }
    }

    const raw = await fetchRawHtml(normalized, options);
    span.end({
      from: "raw",
      bytes: (raw.html?.length ?? 0) + raw.text.length,
    });
    return raw;
  } catch (e) {
    logError(log, e, "readUrl failed", { url: normalized });
    span.end({ error: true });
    throw e instanceof Error ? e : new Error(String(e));
  }
}

/* ------------------------------- Firecrawl --------------------------------- */

let firecrawlClient: Firecrawl | null = null;
function getFirecrawl(): Firecrawl | null {
  if (firecrawlClient) return firecrawlClient;
  const apiKey = process.env.FIRECRAWL_API_KEY || env.FIRECRAWL_API_KEY;
  if (!apiKey) return null;
  firecrawlClient = new Firecrawl({ apiKey });
  return firecrawlClient;
}

async function fetchViaFirecrawl(
  url: string,
  opts: ReaderOptions
): Promise<ReadResult> {
  const client = getFirecrawl();
  if (!client) throw new Error("FIRECRAWL_API_KEY missing");

  const maxAgeEnv = process.env.FIRECRAWL_MAX_AGE_MS ?? "";
  const maxAge =
    Number.isFinite(Number(maxAgeEnv)) && maxAgeEnv !== ""
      ? Number(maxAgeEnv)
      : undefined;

  const country = process.env.FIRECRAWL_COUNTRY;
  const langsCsv = process.env.FIRECRAWL_LANGS;
  const languages =
    langsCsv
      ?.split(",")
      .map((x) => x.trim())
      .filter(Boolean) ?? undefined;

  const scrapeOptions: any = {
    formats: ["markdown", "html"],
    onlyMainContent: true,
    ...(maxAge !== undefined ? { maxAge } : {}),
    ...(country || languages
      ? {
          location: {
            ...(country ? { country } : {}),
            ...(languages ? { languages } : {}),
          },
        }
      : {}),
  };

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;

  let res: any;
  try {
    res = await withTimeout(client.scrape(url, scrapeOptions), timeoutMs, opts.signal);
  } catch (e: any) {
    // Auto-pause Firecrawl for ~45s on rate limit, then rethrow so caller falls back to raw
    const msg = String(e?.message || "").toLowerCase();
    if (msg.includes("rate limit")) {
      FIRECRAWL_PAUSED_UNTIL = Date.now() + 45_000;
    }
    throw e;
  }

  const data = (res as any)?.data ?? res ?? {};
  const html: string | null =
    typeof data.html === "string"
      ? data.html
      : typeof data.rawHtml === "string"
      ? data.rawHtml
      : null;

  const textCandidate: string | null =
    typeof data.markdown === "string"
      ? data.markdown
      : typeof data.content === "string"
      ? data.content
      : typeof data.text === "string"
      ? data.text
      : null;

  const meta = data.metadata ?? {};
  const finalUrl =
    (meta.sourceURL as string) ||
    (meta.url as string) ||
    (meta.ogUrl as string) ||
    url;
  const contentType =
    (meta.contentType as string) ||
    (meta.content_type as string) ||
    "text/html";
  const providedTitle =
    (meta.title as string) ||
    (meta.pageTitle as string) ||
    (meta.ogTitle as string) ||
    null;
  const providedLang =
    (meta.language as string) ||
    (meta.lang as string) ||
    (meta.ogLocale as string) ||
    null;
  const httpStatus: number | undefined =
    typeof meta.statusCode === "number" ? meta.statusCode : undefined;

  const extracted =
    html && (!providedTitle || !providedLang)
      ? extractMetaFromHtml(html)
      : { title: null, lang: null };

  const rawText = textCandidate ?? (html ? htmlToText(html) : "");
  const clean = sanitizeText(rawText, {
    normalize: "NFKC",
    removeControl: true,
    collapseWhitespace: false,
    preserveNewlines: true,
    decodeEntities: true,
    stripMarkdownSyntax: false,
  });

  return {
    text: clean,
    html,
    finalUrl,
    title: providedTitle ?? extracted.title,
    lang: (providedLang ? providedLang.toLowerCase() : null) ?? extracted.lang,
    contentType,
    httpStatus,
    from: "jina", // keep literal for compatibility
  };
}

/* --------------------------------- Raw mode -------------------------------- */

async function fetchRawHtml(
  url: string,
  opts: ReaderOptions
): Promise<ReadResult> {
  const { signal, cancel } = timeoutSignal(
    opts.timeoutMs ?? DEFAULT_TIMEOUT,
    opts.signal
  );

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
        "User-Agent": opts.userAgent ?? UA_DEFAULT,
      },
      redirect: "follow",
      signal,
      cache: "no-store" as any,
    });

    const httpStatus = res.status;
    if (!res.ok) throw new Error(`Fetch HTTP ${res.status}`);

    const finalUrl = (res as any).url || url;
    const contentType = res.headers.get("content-type") ?? null;

    if (contentType && isBinaryContent(contentType)) {
      throw new Error(`Unsupported content-type: ${contentType}`);
    }

    const html = await readBodyAsTextWithLimit(
      res as any,
      opts.maxBytes ?? DEFAULT_MAX_BYTES
    );

    const { title, lang } = extractMetaFromHtml(html);
    const text = htmlToText(html);

    const clean = sanitizeText(text, {
      normalize: "NFKC",
      removeControl: true,
      collapseWhitespace: false,
      preserveNewlines: true,
      decodeEntities: true,
      stripMarkdownSyntax: false,
    });

    return {
      text: clean,
      html,
      finalUrl,
      title,
      lang,
      contentType,
      httpStatus,
      from: "raw",
    };
  } finally {
    cancel();
  }
}

/* -------------------------------- Utilities -------------------------------- */

function normalizeUrl(input: string): string {
  const s = input.trim();
  if (/^https?:\/\//i.test(s)) return s;
  return `https://${s.replace(/^\/+/, "")}`;
}

function timeoutSignal(
  timeoutMs: number,
  ext?: AbortSignal
): { signal: AbortSignal; cancel: () => void } {
  const ac = new AbortController();
  const timer = setTimeout(
    () => ac.abort(new DOMException("Timeout", "TimeoutError")),
    timeoutMs
  );
  const onAbort = () =>
    ac.abort(ext?.reason ?? new DOMException("Aborted", "AbortError"));
  if (ext) {
    if (ext.aborted) onAbort();
    else ext.addEventListener("abort", onAbort, { once: true });
  }
  return { signal: ac.signal, cancel: () => clearTimeout(timer) };
}

function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  signal?: AbortSignal
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new DOMException("Timeout", "TimeoutError")),
      ms
    );
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
    }
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

async function readBodyAsTextWithLimit(
  res: Response,
  maxBytes: number
): Promise<string> {
  const len = parseInt(res.headers.get("content-length") || "0", 10);
  if (Number.isFinite(len) && len > 0 && len > maxBytes) {
    throw new Error(`Response too large: ${len} bytes (limit ${maxBytes})`);
  }

  const reader = (res as any).body?.getReader?.();
  if (!reader) {
    const txt = await (res as any).text();
    if (byteLength(txt) > maxBytes)
      throw new Error("Response exceeded byte limit after decode");
    return txt;
  }

  const decoder = new TextDecoder("utf-8");
  let received = 0;
  let out = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      received += value.byteLength;
      if (received > maxBytes) {
        try {
          reader.cancel();
        } catch {}
        throw new Error(`Response exceeded byte limit: > ${maxBytes} bytes`);
      }
      out += decoder.decode(value, { stream: true });
    }
  }
  out += decoder.decode();
  return out;
}

function byteLength(str: string): number {
  return new TextEncoder().encode(str).byteLength;
}

function isBinaryContent(ct: string): boolean {
  const lower = ct.toLowerCase();
  if (lower.includes("pdf")) return true; // PDFs: consider routing to Firecrawl to control cost
  if (lower.startsWith("image/")) return true;
  if (lower.startsWith("video/")) return true;
  if (lower.startsWith("audio/")) return true;
  if (lower.includes("octet-stream")) return true;
  return false;
}

function extractMetaFromHtml(html: string): {
  title: string | null;
  lang: string | null;
} {
  let title: string | null = null;
  let lang: string | null = null;

  try {
    const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    title = m ? stripTags(m[1]).trim() : null;
  } catch {
    title = null;
  }

  try {
    const lm = html.match(/<html[^>]*\blang=["']?([a-zA-Z-]{2,})["']?[^>]*>/i);
    lang = lm ? lm[1].toLowerCase() : null;
  } catch {
    lang = null;
  }

  return { title, lang };
}

function htmlToText(html: string): string {
  let s = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, "");
  s = s.replace(/<(?:br|br\/|br\s*\/)>/gi, "\n");
  s = s.replace(/<\/p>/gi, "\n\n");
  s = stripTags(s);
  s = s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "");
}
 