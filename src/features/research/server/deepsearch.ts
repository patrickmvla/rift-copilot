/* eslint-disable @typescript-eslint/no-explicit-any */
import "server-only";
import { env } from "@/lib/env";
import { logger, logError, startSpan } from "@/lib/logger";

export type SearchResult = {
  url: string;
  title?: string;
  snippet?: string;
  score?: number;
  publishedAt?: string | null;
  source?: "jina";
};

export type DeepsearchOptions = {
  size?: number;
  timeRange?: { from?: string; to?: string };
  allowedDomains?: string[];
  disallowedDomains?: string[];
  region?: string;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  prewarm?: boolean; // NEW: hit s.jina.ai first to warm caches
};

export async function deepsearch(
  query: string,
  opts: DeepsearchOptions = {}
): Promise<SearchResult[]> {
  const log = logger.child({ mod: "deepsearch" });
  const span = startSpan(log, "deepsearch");
  if (!query || !query.trim()) return [];

  const f = await getFetch();
  const useChat = process.env.JINA_USE_CHAT === "1";
  const doPrewarm = opts.prewarm ?? process.env.JINA_PREWARM === "1";
  const timeout = opts.timeoutMs ?? env.REQUEST_TIMEOUT_MS;

  try {
    // Optional prewarm to s.jina.ai (no response body)
    if (doPrewarm) {
      await prewarmJina(query, timeout, f).catch((e) => {
        logError(log, e, "prewarm failed (non-fatal)");
      });
    }

    if (useChat) {
      const res = await deepsearchChat(query, opts, timeout, f);
      span.end({ count: res.length, via: "chat", prewarm: doPrewarm });
      return res;
    }

    const res = await deepsearchSearchApi(query, opts, timeout, f);
    if (res.kind === "ok") {
      span.end({ count: res.items.length, via: "search", prewarm: doPrewarm });
      return res.items;
    }

    if (res.nonRetryable) {
      const chat = await deepsearchChat(query, opts, timeout, f).catch((e) => {
        logError(log, e, "chat fallback failed");
        return [] as SearchResult[];
      });
      span.end({
        count: chat.length,
        via: "chat-fallback",
        prewarm: doPrewarm,
      });
      return chat;
    }

    span.end({ count: 0, error: true, via: "search", prewarm: doPrewarm });
    return [];
  } catch (e) {
    logError(log, e, "deepsearch failed", { query });
    span.end({ error: true });
    return [];
  }
}

export async function deepsearchBatch(
  queries: string[],
  opts: DeepsearchOptions & { concurrency?: number } = {}
): Promise<SearchResult[]> {
  const conc = Math.max(1, Math.min(6, opts.concurrency ?? 3));
  const all = await mapLimit(queries, conc, (q) => deepsearch(q, opts));
  return dedupeResults(all.flat());
}

/* -------------------------------- Search API ------------------------------- */

async function deepsearchSearchApi(
  query: string,
  opts: DeepsearchOptions,
  timeoutMs: number,
  f: typeof fetch
): Promise<
  { kind: "ok"; items: SearchResult[] } | { kind: "err"; nonRetryable: boolean }
> {
  const base = (env.JINA_SEARCH_BASE || "https://api.jina.ai").replace(
    /\/+$/,
    ""
  );
  const url = `${base}/v1/search`;

  const topK = Math.max(1, Math.min(50, opts.size ?? 8));
  const payload: Record<string, unknown> = {
    query,
    top_k: topK,
    allow: opts.allowedDomains?.length ? opts.allowedDomains : undefined,
    deny: opts.disallowedDomains?.length ? opts.disallowedDomains : undefined,
    time_range: normalizeTimeRange(opts.timeRange),
    region: opts.region,
    use_cache: true,
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (env.JINA_API_KEY) headers.Authorization = `Bearer ${env.JINA_API_KEY}`;

  const { signal, cancel } = timeoutSignal(timeoutMs, opts.abortSignal);

  try {
    const maxRetries = 2;
    const baseDelay = 400;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const r = await f(url, {
        method: "POST",
        headers,
        body: JSON.stringify(stripUndefined(payload)),
        signal,
        cache: "no-store" as any,
      });

      if (r.status === 404 || r.status === 401 || r.status === 400) {
        return { kind: "err", nonRetryable: true };
      }
      if (!r.ok) {
        const retryable = r.status === 429 || r.status >= 500;
        if (retryable && attempt < maxRetries) {
          await sleep(baseDelay * Math.pow(2, attempt), signal);
          continue;
        }
        const text = await safeText(r);
        throw new Error(`Jina search HTTP ${r.status}: ${text?.slice(0, 300)}`);
      }

      const json = await r.json();
      const items = normalizeJinaResponse(json);
      const filtered = postFilter(items, {
        allowed: opts.allowedDomains,
        disallowed: opts.disallowedDomains,
      });
      return { kind: "ok", items: dedupeResults(filtered) };
    }

    return { kind: "err", nonRetryable: false };
  } finally {
    cancel();
  }
}

/* ------------------------- Deepsearch Chat Completions --------------------- */

async function deepsearchChat(
  query: string,
  opts: DeepsearchOptions,
  timeoutMs: number,
  f: typeof fetch
): Promise<SearchResult[]> {
  const base = "https://deepsearch.jina.ai";
  const url = `${base.replace(/\/+$/, "")}/v1/chat/completions`;

  const topK = Math.max(1, Math.min(30, opts.size ?? 8));
  const sys = [
    "You are a search assistant.",
    "Return a JSON array of search results ONLY. No prose, no code fences.",
    'Each item: { "url": string, "title"?: string, "snippet"?: string }',
    "Prefer high-quality, diverse, recent sources. Do not invent URLs.",
  ].join(" ");

  const userParts: string[] = [];
  userParts.push(`Query: ${query}`);
  userParts.push(`TopK: ${topK}`);
  if (opts.timeRange?.from || opts.timeRange?.to)
    userParts.push(
      `TimeRange: from=${opts.timeRange?.from ?? ""} to=${
        opts.timeRange?.to ?? ""
      }`
    );
  if (opts.allowedDomains?.length)
    userParts.push(`Allow: ${opts.allowedDomains.join(", ")}`);
  if (opts.disallowedDomains?.length)
    userParts.push(`Deny: ${opts.disallowedDomains.join(", ")}`);
  if (opts.region) userParts.push(`Region: ${opts.region}`);

  const payload = {
    model: "jina-deepsearch-v1",
    stream: false,
    reasoning_effort: "medium",
    messages: [
      { role: "system", content: sys },
      { role: "user", content: userParts.join("\n") },
    ],
  };

  const { signal, cancel } = timeoutSignal(timeoutMs, opts.abortSignal);
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (env.JINA_API_KEY) headers.Authorization = `Bearer ${env.JINA_API_KEY}`;

    const r = await f(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal,
      cache: "no-store" as any,
    });

    if (r.status === 404 || r.status === 401 || r.status === 400) return [];
    if (!r.ok) {
      const text = await safeText(r);
      throw new Error(
        `Jina deepsearch chat HTTP ${r.status}: ${text?.slice(0, 300)}`
      );
    }

    const json = await r.json();
    const text = extractTextFromChat(json);
    const parsed = tryParseResultsJSON(text);
    if (parsed.length) return normalizeRawResults(parsed);

    const urls = extractUrls(text);
    return normalizeRawResults(urls.map((u) => ({ url: u })));
  } finally {
    cancel();
  }
}

/* ------------------------------ Jina Prewarm ------------------------------- */

async function prewarmJina(
  query: string,
  timeoutMs: number,
  f: typeof fetch
): Promise<void> {
  const base = "https://s.jina.ai";
  const url = `${base}/?q=${encodeURIComponent(query)}`;

  const headers: Record<string, string> = {
    "X-Respond-With": "no-content",
  };
  if (env.JINA_API_KEY) headers.Authorization = `Bearer ${env.JINA_API_KEY}`;

  const { signal, cancel } = timeoutSignal(timeoutMs);
  try {
    await f(url, {
      method: "GET",
      headers,
      signal,
      cache: "no-store" as any,
    }).catch(() => undefined);
  } finally {
    cancel();
  }
}

/* ------------------------------- Parsing utils ----------------------------- */

function extractTextFromChat(json: any): string {
  const choices = json?.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const msg = choices[0]?.message?.content;
    if (typeof msg === "string" && msg.trim()) return msg;
    if (Array.isArray(msg)) {
      const t = msg
        .map((p: any) => (typeof p?.text === "string" ? p.text : ""))
        .join("\n");
      if (t.trim()) return t;
    }
  }
  return "";
}

function tryParseResultsJSON(
  text: string
): Array<{ url: string; title?: string; snippet?: string }> {
  const t = text.trim();
  if (!t) return [];
  const start = t.indexOf("[");
  const end = t.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return [];
  try {
    const arr = JSON.parse(t.slice(start, end + 1));
    if (Array.isArray(arr)) {
      return arr
        .filter((x) => x && typeof x.url === "string")
        .map((x) => ({
          url: String(x.url),
          title: typeof x.title === "string" ? x.title : undefined,
          snippet: typeof x.snippet === "string" ? x.snippet : undefined,
        }));
    }
  } catch {
    return [];
  }
  return [];
}

function extractUrls(text: string): string[] {
  const re = /\bhttps?:\/\/[^\s)]+/gi;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[0]);
  return Array.from(new Set(out));
}

function normalizeRawResults(
  raw: Array<{ url: string; title?: string; snippet?: string }>
): SearchResult[] {
  const out: SearchResult[] = [];
  for (const it of raw) {
    const canon = canonicalizeUrl(it.url);
    if (!canon) continue;
    out.push({
      url: canon,
      title: it.title,
      snippet: it.snippet,
      source: "jina",
    });
  }
  return dedupeResults(out);
}

/* -------------------------------- Shared utils ----------------------------- */

type JinaRawItem = {
  url?: string;
  link?: string;
  title?: string;
  snippet?: string;
  score?: number | string;
  relevance_score?: number | string;
  published_time?: string;
  publishedAt?: string;
  date?: string;
  [k: string]: unknown;
};

function normalizeJinaResponse(json: any): SearchResult[] {
  const arr: JinaRawItem[] = Array.isArray(json)
    ? json
    : Array.isArray(json?.results)
    ? json.results
    : Array.isArray(json?.data)
    ? json.data
    : Array.isArray(json?.output)
    ? json.output
    : [];

  const out: SearchResult[] = [];
  for (const it of arr) {
    const rawUrl = it.url || (it as any).link;
    if (!rawUrl || typeof rawUrl !== "string") continue;

    const canon = canonicalizeUrl(rawUrl);
    if (!canon) continue;

    const rawScore =
      typeof it.score === "number"
        ? it.score
        : typeof it.score === "string"
        ? Number(it.score)
        : typeof it.relevance_score === "number"
        ? it.relevance_score
        : typeof it.relevance_score === "string"
        ? Number(it.relevance_score)
        : undefined;

    const publishedAt =
      (typeof it.published_time === "string" && it.published_time) ||
      (typeof it.publishedAt === "string" && it.publishedAt) ||
      (typeof it.date === "string" && it.date) ||
      null;

    out.push({
      url: canon,
      title: typeof it.title === "string" ? it.title : undefined,
      snippet: typeof it.snippet === "string" ? it.snippet : undefined,
      score: Number.isFinite(rawScore as number)
        ? (rawScore as number)
        : undefined,
      publishedAt,
      source: "jina",
    });
  }
  return out;
}

function postFilter(
  items: SearchResult[],
  opts: { allowed?: string[]; disallowed?: string[] }
): SearchResult[] {
  const allowed = normDomains(opts.allowed ?? []);
  const disallowed = normDomains(opts.disallowed ?? []);
  return items.filter((r) => {
    let host = "";
    try {
      host = new URL(r.url).hostname.toLowerCase();
    } catch {
      return false;
    }
    if (
      allowed.length > 0 &&
      !allowed.some((d) => host === d || host.endsWith("." + d))
    )
      return false;
    if (
      disallowed.length > 0 &&
      disallowed.some((d) => host === d || host.endsWith("." + d))
    )
      return false;
    return true;
  });
}

function dedupeResults(items: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const it of items) {
    const key = it.url;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

function normDomains(xs: string[]): string[] {
  const out: string[] = [];
  for (const x of xs) {
    if (!x) continue;
    const h = x
      .replace(/^https?:\/\//i, "")
      .split("/")[0]
      .toLowerCase();
    if (h) out.push(h);
  }
  return out;
}

function canonicalizeUrl(u: string): string | null {
  try {
    const url = new URL(u);
    url.hash = "";
    const toDelete: string[] = [];
    url.searchParams.forEach((_, k) => {
      const lk = k.toLowerCase();
      if (
        lk.startsWith("utm_") ||
        lk === "gclid" ||
        lk === "fbclid" ||
        lk === "mc_cid" ||
        lk === "mc_eid" ||
        lk === "ref" ||
        lk === "ref_src"
      ) {
        toDelete.push(k);
      }
    });
    toDelete.forEach((k) => url.searchParams.delete(k));
    const entries = Array.from(url.searchParams.entries()).sort(([a], [b]) =>
      a.localeCompare(b)
    );
    url.search = "";
    for (const [k, v] of entries) url.searchParams.append(k, v);
    if (url.pathname.endsWith("/") && url.pathname !== "/")
      url.pathname = url.pathname.replace(/\/+$/, "");
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    return url.toString();
  } catch {
    return null;
  }
}

function normalizeTimeRange(tr?: { from?: string; to?: string }) {
  if (!tr) return undefined;
  const from = isoOrUndefined(tr.from);
  const to = isoOrUndefined(tr.to);
  if (!from && !to) return undefined;
  return { from, to };
}

function isoOrUndefined(x?: string) {
  if (!x) return undefined;
  const d = new Date(x);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  Object.keys(obj).forEach((k) => {
    const v = (obj as any)[k];
    if (v !== undefined) out[k] = v;
  });
  return out as T;
}

/* ------------------------------ Timing/Fetch ------------------------------- */

function timeoutSignal(timeoutMs: number, ext?: AbortSignal) {
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

async function safeText(res: Response): Promise<string | null> {
  try {
    return await res.text();
  } catch {
    return null;
  }
}

async function getFetch(): Promise<typeof fetch> {
  if (typeof fetch !== "undefined") return fetch;
  const mod = (await import("node-fetch")) as any;
  return (mod.default ?? mod) as typeof fetch;
}

/* -------------------------------- mapLimit util ---------------------------- */

async function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(t);
        reject(signal.reason ?? new Error("Aborted"));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

async function mapLimit<T, R>(
  arr: readonly T[],
  limit: number,
  fn: (item: T, idx: number) => Promise<R>
): Promise<R[]> {
  if (arr.length === 0) return [];
  const results = new Array<R>(arr.length);
  let i = 0;
  let inFlight = 0;
  return await new Promise<R[]>((resolve, reject) => {
    const next = () => {
      if (i >= arr.length && inFlight === 0) return resolve(results);
      while (inFlight < limit && i < arr.length) {
        const idx = i++;
        inFlight++;
        fn(arr[idx], idx)
          .then((r) => {
            results[idx] = r;
            inFlight--;
            next();
          })
          .catch(reject);
      }
    };
    next();
  });
}
