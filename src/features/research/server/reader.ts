/* eslint-disable @typescript-eslint/no-explicit-any */
import "server-only";
import { env } from "@/lib/env";
import { logger, logError, startSpan } from "@/lib/logger";
import { sanitizeText } from "@/lib/text";

export type ReaderOptions = {
  timeoutMs?: number;
  maxBytes?: number;
  prefer?: "jina" | "raw";
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

export async function readUrl(
  url: string,
  options: ReaderOptions = {}
): Promise<ReadResult> {
  const log = logger.child({ mod: "reader" });
  const span = startSpan(log, "readUrl");

  const normalized = normalizeUrl(url);
  const prefer = options.prefer ?? "jina";

  try {
    if (prefer === "jina") {
      try {
        const res = await fetchViaJina(normalized, options);
        span.end({ from: "jina", bytes: res.text.length });
        return res;
      } catch (e) {
        logError(log, e, "Jina reader failed; falling back to raw fetch", {
          url: normalized,
        });
      }
    }

    const raw = await fetchRawHtml(normalized, options);
    span.end({ from: "raw", bytes: (raw.html?.length ?? 0) + raw.text.length });
    return raw;
  } catch (e) {
    logError(log, e, "readUrl failed", { url: normalized });
    span.end({ error: true });
    throw e instanceof Error ? e : new Error(String(e));
  }
}

async function getFetch(): Promise<typeof fetch> {
  if (typeof fetch !== "undefined") return fetch;
  const mod = (await import("node-fetch")) as any;
  return (mod.default ?? mod) as typeof fetch;
}

/* Jina mode */

async function fetchViaJina(
  url: string,
  opts: ReaderOptions
): Promise<ReadResult> {
  const f = await getFetch();
  const readerUrl = toJinaReaderUrl(url);
  const { signal, cancel } = timeoutSignal(
    opts.timeoutMs ?? DEFAULT_TIMEOUT,
    opts.signal
  );

  try {
    const headers: Record<string, string> = {
      Accept: "text/plain, */*;q=0.8",
      "User-Agent": opts.userAgent ?? UA_DEFAULT,
    };
    if (env.JINA_API_KEY) {
      headers.Authorization = `Bearer ${env.JINA_API_KEY}`;
    }

    const res = await f(readerUrl, {
      method: "GET",
      headers,
      signal,
      cache: "no-store" as any,
    });

    const httpStatus = res.status;
    if (!res.ok) throw new Error(`Jina Reader HTTP ${res.status}`);

    const contentType = res.headers.get("content-type") ?? null;
    const text = await readBodyAsTextWithLimit(
      res as any,
      opts.maxBytes ?? DEFAULT_MAX_BYTES
    );

    const clean = sanitizeText(text, {
      normalize: "NFKC",
      removeControl: true,
      collapseWhitespace: false,
      preserveNewlines: true,
      decodeEntities: true,
    });

    return {
      text: clean,
      html: null,
      finalUrl: url,
      title: null,
      lang: null,
      contentType,
      httpStatus,
      from: "jina",
    };
  } finally {
    cancel();
  }
}

/* Raw mode */

async function fetchRawHtml(
  url: string,
  opts: ReaderOptions
): Promise<ReadResult> {
  const f = await getFetch();
  const { signal, cancel } = timeoutSignal(
    opts.timeoutMs ?? DEFAULT_TIMEOUT,
    opts.signal
  );

  try {
    const res = await f(url, {
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

/* Utilities */

function normalizeUrl(input: string): string {
  const s = input.trim();
  if (/^https?:\/\//i.test(s)) return s;
  return `https://${s.replace(/^\/+/, "")}`;
}

function toJinaReaderUrl(targetUrl: string): string {
  const base = (env as any).JINA_READER_BASE || "https://r.jina.ai";
  // Preserve original protocol in path: e.g., r.jina.ai/https://example.com
  const baseClean = String(base).replace(/\/+$/, "");
  return `${baseClean}/${targetUrl}`;
}

function timeoutSignal(
  timeoutMs: number,
  ext?: AbortSignal
): {
  signal: AbortSignal;
  cancel: () => void;
} {
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

  return {
    signal: ac.signal,
    cancel: () => clearTimeout(timer),
  };
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
  if (lower.includes("pdf")) return true;
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
