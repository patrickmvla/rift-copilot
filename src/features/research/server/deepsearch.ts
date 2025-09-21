/* eslint-disable @typescript-eslint/no-explicit-any */
import "server-only";
import { tavily } from "@tavily/core";
import Firecrawl from "@mendable/firecrawl-js";
import { env } from "@/lib/env";
import { logger, logError, startSpan } from "@/lib/logger";

export type SearchResult = {
  url: string;
  title?: string;
  snippet?: string;
  score?: number;
  publishedAt?: string | null;
  source?: "jina"; // keep literal for downstream compatibility
};

export type DeepsearchOptions = {
  size?: number;
  timeRange?: { from?: string; to?: string };
  allowedDomains?: string[];
  disallowedDomains?: string[];
  region?: string;
  abortSignal?: AbortSignal;
  timeoutMs?: number; // default ~45s
  chatTimeoutMs?: number; // kept for compat (unused)
  prewarm?: boolean; // no-op here
  disableChatFallback?: boolean; // no-op here
};

// Defaults
const DEFAULT_SEARCH_TIMEOUT = Math.max(10_000, env.REQUEST_TIMEOUT_MS ?? 45_000);

/* ------------------------------- Singletons -------------------------------- */

let tvlyClient: ReturnType<typeof tavily> | null = null;
function getTavily() {
  if (tvlyClient) return tvlyClient;
  const apiKey = process.env.TAVILY_API_KEY || "";
  if (!apiKey) return null;
  tvlyClient = tavily({ apiKey });
  return tvlyClient;
}

let firecrawlClient: Firecrawl | null = null;
function getFirecrawl(): Firecrawl | null {
  if (firecrawlClient) return firecrawlClient;
  const apiKey = process.env.FIRECRAWL_API_KEY || "";
  if (!apiKey) return null;
  firecrawlClient = new Firecrawl({ apiKey });
  return firecrawlClient;
}

/* --------------------------------- Entry ----------------------------------- */

export async function deepsearch(
  query: string,
  opts: DeepsearchOptions = {}
): Promise<SearchResult[]> {
  const log = logger.child({ mod: "deepsearch" });
  const span = startSpan(log, "deepsearch");
  if (!query || !query.trim()) return [];

  const searchTimeout = opts.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT;

  try {
    // 1) Tavily primary
    const primary = await tavilySearch(query, opts, searchTimeout, {
      widen: false,
      relax: false,
    });
    if (primary.items.length > 0) {
      span.end({ count: primary.items.length, via: "tavily", prewarm: false });
      return primary.items;
    }

    // 2) Broaden-and-retry Tavily
    const relaxedQuery = loosenQuery(query);
    const broadened = await tavilySearch(relaxedQuery || query, opts, searchTimeout, {
      widen: true,
      relax: true,
    });
    if (broadened.items.length > 0) {
      span.end({
        count: broadened.items.length,
        via: "tavily-broadened",
        prewarm: false,
      });
      return broadened.items;
    }

    // 3) Firecrawl fallback (if key present)
    const hasFirecrawl = !!process.env.FIRECRAWL_API_KEY;
    if (hasFirecrawl) {
      const f = await firecrawlSearch(relaxedQuery || query, opts, searchTimeout);
      if (f.length > 0) {
        span.end({
          count: f.length,
          via: "firecrawl-fallback",
          prewarm: false,
        });
        return f;
      }
    }

    span.end({ count: 0, via: "tavily-empty", error: true, prewarm: false });
    return [];
  } catch (e) {
    logError(log, e, "deepsearch failed", { query });
    span.end({ error: true });
    return [];
  }
}

/* -------------------------------- Batch ------------------------------------ */

export async function deepsearchBatch(
  queries: string[],
  opts: DeepsearchOptions & { concurrency?: number } = {}
): Promise<SearchResult[]> {
  const conc = Math.max(1, Math.min(6, opts.concurrency ?? 3));
  const all = await mapLimit(queries, conc, (q) => deepsearch(q, opts));
  return dedupeResults(all.flat());
}

/* ------------------------------ Tavily SDK --------------------------------- */

type TavilySearchDepth = "basic" | "advanced";
type TavilyTopic = "general" | "news" | "finance";

async function tavilySearch(
  query: string,
  opts: DeepsearchOptions,
  timeoutMs: number,
  behavior: { widen: boolean; relax: boolean }
): Promise<{ items: SearchResult[]; reason?: string }> {
  const client = getTavily();
  if (!client) return { items: [], reason: "missing_tavily_key" };

  const baseTopK = Math.max(1, Math.min(50, opts.size ?? 8));
  const max_results = behavior.widen ? Math.max(8, Math.min(20, baseTopK + 4)) : baseTopK;

  // Depth & topic
  const search_depth =
    ((process.env.TAVILY_SEARCH_DEPTH as TavilySearchDepth) || "advanced") as TavilySearchDepth;

  // Don’t force 'news' automatically; leave to env override
  const topic = ((process.env.TAVILY_TOPIC as TavilyTopic) || "general") as TavilyTopic;

  // Optional country boost (exact string name per docs); avoid mapping region automatically
  const country = process.env.TAVILY_COUNTRY || undefined;

  // Time constraints: prefer exact start/end; else coarse time_range
  const start_date = toISODate(opts.timeRange?.from);
  const end_date = toISODate(opts.timeRange?.to);
  const time_range = !start_date && !end_date ? toTavilyTimeRange(opts.timeRange) : undefined;

  // Domains (relaxed when broadening)
  const include_domains =
    behavior.relax ? undefined : (opts.allowedDomains?.length ? opts.allowedDomains : undefined);
  const exclude_domains =
    behavior.relax
      ? undefined
      : (opts.disallowedDomains?.length ? opts.disallowedDomains : undefined);

  // Optional: auto_parameters (costs more credits)
  const auto_params = ["1", "true", "yes"].includes(
    String(process.env.TAVILY_AUTO_PARAMETERS || "").toLowerCase()
  );

  try {
    const resp = await client.search(
      {
        query,
        max_results,
        search_depth,
        topic,
        include_answer: false,
        include_raw_content: false,
        include_images: false,
        include_favicon: false,
        ...(auto_params ? { auto_parameters: true } : {}),
        ...(include_domains ? { include_domains } : {}),
        ...(exclude_domains ? { exclude_domains } : {}),
        ...(time_range ? { time_range } : {}),
        ...(start_date ? { start_date } : {}),
        ...(end_date ? { end_date } : {}),
        ...(country ? { country } : {}),
      } as any,
      {
        timeoutInSeconds: Math.max(1, Math.floor(timeoutMs / 1000)),
        abortSignal: opts.abortSignal,
      }
    );

    const results = Array.isArray((resp as any)?.results) ? (resp as any).results : [];
    const mapped: SearchResult[] = results
      .map((it: any) => {
        const url = typeof it?.url === "string" ? it.url : undefined;
        if (!url) return null;
        const canon = canonicalizeUrl(url);
        if (!canon) return null;
        const title =
          typeof it?.title === "string"
            ? it.title
            : typeof it?.name === "string"
            ? it.name
            : undefined;
        const snippet =
          typeof it?.content === "string"
            ? it.content
            : typeof it?.description === "string"
            ? it.description
            : undefined;
        const published =
          typeof it?.published_date === "string"
            ? it.published_date
            : typeof it?.published_time === "string"
            ? it.published_time
            : typeof it?.date === "string"
            ? it.date
            : null;

        return {
          url: canon,
          title,
          snippet,
          score: undefined,
          publishedAt: published,
          source: "jina",
        } satisfies SearchResult;
      })
      .filter(Boolean) as SearchResult[];

    const filtered = postFilter(mapped, {
      allowed: behavior.relax ? undefined : opts.allowedDomains,
      disallowed: behavior.relax ? undefined : opts.disallowedDomains,
    });

    return { items: dedupeResults(filtered) };
  } catch (e: any) {
    // Tavily SDK throws on non-2xx; treat as no results so fallback can run
    return { items: [], reason: String(e?.message || "tavily_error") };
  }
}

/* --------------------------- Firecrawl Search SDK -------------------------- */

async function firecrawlSearch(
  query: string,
  opts: DeepsearchOptions,
  timeoutMs: number
): Promise<SearchResult[]> {
  const client = getFirecrawl();
  if (!client) return [];

  // Compute limit
  const topK = Math.max(1, Math.min(20, opts.size ?? 8));

  // Optional country/location
  const location = process.env.FIRECRAWL_COUNTRY;

  // Time window → tbs
  const tbs = toFirecrawlTbs(opts.timeRange);

  try {
    const resp: any = await client.search(query, {
      limit: topK,
      ...(location ? { location } : {}),
      ...(tbs ? { tbs } : {}),
      // We are NOT scraping content here to keep it cheap and fast
      // scrapeOptions: { formats: ['markdown'] }
      timeout: Math.max(1, Math.floor(timeoutMs)), // ms
    });

    // SDK returns a data object. Gather URLs from web/news arrays if present.
    const data = resp?.data ?? resp ?? {};
    const web: any[] = Array.isArray(data.web) ? data.web : [];
    const news: any[] = Array.isArray(data.news) ? data.news : [];
    // Sometimes SDK returns an array directly when scraping content; guard:
    const flat: any[] = Array.isArray(data) ? data : [];

    const rows = [...web, ...news, ...flat].slice(0, topK);

    const mapped: SearchResult[] = rows
      .map((it: any) => {
        const url = typeof it?.url === "string" ? it.url : undefined;
        if (!url) return null;
        const canon = canonicalizeUrl(url);
        if (!canon) return null;
        const title = typeof it?.title === "string" ? it.title : undefined;
        const snippet =
          typeof it?.description === "string"
            ? it.description
            : typeof it?.snippet === "string"
            ? it.snippet
            : undefined;
        return { url: canon, title, snippet, source: "jina" } as SearchResult;
      })
      .filter(Boolean) as SearchResult[];

    const filtered = postFilter(mapped, {
      allowed: opts.allowedDomains,
      disallowed: opts.disallowedDomains,
    });

    return dedupeResults(filtered).slice(0, topK);
  } catch {
    return [];
  }
}

/* ------------------------------ Helpers/utils ------------------------------ */

// Loosen query (remove quotes/parentheses and collapse whitespace)
function loosenQuery(q: string): string {
  return (q || "")
    .replace(/[“”"']/g, " ")
    .replace(/[()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toISODate(x?: string) {
  if (!x) return undefined;
  const d = new Date(x);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString().slice(0, 10);
}

// Tavily coarse time_range mapper
function toTavilyTimeRange(
  tr?: { from?: string; to?: string }
): "day" | "week" | "month" | "year" | undefined {
  const norm = normalizeTimeRange(tr);
  if (!norm?.from && !norm?.to) return undefined;
  try {
    const from = norm.from ? new Date(norm.from) : undefined;
    const to = norm.to ? new Date(norm.to) : new Date();
    const ms = (to?.getTime() ?? Date.now()) - (from?.getTime() ?? Date.now());
    const days = Math.max(1, Math.round(ms / (24 * 3600 * 1000)));
    if (days <= 7) return "week";
    if (days <= 31) return "month";
    return "year";
  } catch {
    return undefined;
  }
}

// Firecrawl tbs (time-based search): qdr:h/d/w/m/y or custom ranges
function toFirecrawlTbs(tr?: { from?: string; to?: string }): string | undefined {
  const norm = normalizeTimeRange(tr);
  if (!norm?.from && !norm?.to) return undefined;
  // If from is within last day/week/month/year choose qdr; otherwise custom CDR
  try {
    const from = norm.from ? new Date(norm.from) : undefined;
    const to = norm.to ? new Date(norm.to) : new Date();
    const ms = (to?.getTime() ?? Date.now()) - (from?.getTime() ?? Date.now());
    const days = Math.max(1, Math.round(ms / (24 * 3600 * 1000)));
    if (days <= 1) return "qdr:d";
    if (days <= 7) return "qdr:w";
    if (days <= 31) return "qdr:m";
    if (days <= 365) return "qdr:y";
    // Custom date range (US format per docs)
    const cdMin = from ? toUsDate(from) : undefined;
    const cdMax = to ? toUsDate(to) : undefined;
    if (cdMin || cdMax) {
      return `cdr:1${cdMin ? `,cd_min:${cdMin}` : ""}${cdMax ? `,cd_max:${cdMax}` : ""}`;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function toUsDate(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(1, "0");
  const dd = String(d.getDate()).padStart(1, "0");
  const yyyy = d.getFullYear();
  return `${mm}/${dd}/${yyyy}`;
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

/* -------------------------------- Shared utils ----------------------------- */

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
    if (allowed.length > 0 && !allowed.some((d) => host === d || host.endsWith("." + d)))
      return false;
    if (disallowed.length > 0 && disallowed.some((d) => host === d || host.endsWith("." + d)))
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
    const h = x.replace(/^https?:\/\//i, "").split("/")[0].toLowerCase();
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

/* --------------------------------- Timing ---------------------------------- */

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