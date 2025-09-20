/* eslint-disable @typescript-eslint/no-explicit-any */
import "server-only";
import { NextRequest } from "next/server";
import { z } from "zod";
import { loggerWithRequest, logError } from "@/lib/logger";
import { env } from "@/lib/env";
import { db } from "@/db";
import { sources, sourceContent, chunks, ingestQueue } from "@/db/schema";
import { eq } from "drizzle-orm";
import { id as newId } from "@/lib/id";
import { sanitizeText, splitIntoWindows } from "@/lib/text";
import { readUrl } from "@/features/research/server/reader";

export const runtime = "nodejs";

const BodySchema = z.object({
  urls: z.array(z.string().url("Invalid URL")).min(1).max(32),
  immediate: z.boolean().optional().default(true),
  priority: z.number().int().min(-10).max(10).optional().default(0),
});

type IngestStatus = "ok" | "exists" | "queued" | "error";

type IngestResult = {
  url: string;
  status: IngestStatus;
  sourceId?: string;
  message?: string;
};

export async function POST(req: NextRequest) {
  const log = loggerWithRequest({
    headers: req.headers,
    method: req.method,
    url: req.url,
  });

  // Parse & validate
  let body: z.infer<typeof BodySchema>;
  try {
    const json = await req.json();
    const parsed = BodySchema.safeParse(json);
    if (!parsed.success) {
      return jsonError(400, "Invalid request body", parsed.error.flatten());
    }
    body = parsed.data;
  } catch (e) {
    logError(log, e, "Invalid JSON body");
    return jsonError(400, "Invalid JSON body");
  }

  const urls = dedupeArray(
    body.urls.map(normalizeUrl).map(canonicalizeUrl).filter(Boolean) as string[]
  );

  if (urls.length === 0) {
    return jsonError(400, "No valid URLs to ingest");
  }

  try {
    const results = await mapLimit(urls, 4, (u) =>
      body.immediate
        ? ingestNow(u, { abortSignal: req.signal })
        : enqueue(u, body.priority)
    );

    const sourceIds = results
      .filter((r) => r.status === "ok" || r.status === "exists")
      .map((r) => r.sourceId!)
      .filter(Boolean);

    return new Response(JSON.stringify({ results, sourceIds }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    if (isAbortError(e)) {
      // Client disconnected
      return new Response(null, { status: 499 }); // Client Closed Request
    }
    logError(log, e, "Ingest failed");
    return jsonError(500, "Ingest failed");
  }
}

/* --------------------------------- Helpers -------------------------------- */

async function ingestNow(
  url: string,
  opts: { abortSignal?: AbortSignal }
): Promise<IngestResult> {
  try {
    // Check existing by URL
    const existing = await db
      .select()
      .from(sources)
      .where(eq(sources.url, url))
      .limit(1);
    if (existing.length > 0) {
      return { url, status: "exists", sourceId: existing[0]!.id };
    }

    // Read content via Jina reader (fallback to raw in reader implementation)
    const result = await readUrl(url, {
      timeoutMs: env.REQUEST_TIMEOUT_MS,
      signal: opts.abortSignal,
    });

    const text = sanitizeText(result.text, {
      normalize: "NFKC",
      removeControl: true,
      collapseWhitespace: false,
      preserveNewlines: true,
      decodeEntities: true,
    });

    const sourceId = newId();
    const domain = tryDomain(url);

    await db
      .insert(sources)
      .values({
        id: sourceId,
        url,
        domain,
        title: result.title ?? null,
        publishedAt: null,
        crawledAt: new Date().toISOString(),
        lang: result.lang ?? null,
        status: "ok",
        httpStatus: result.httpStatus ?? null,
      })
      .onConflictDoNothing({ target: sources.url })
      .run();

    await db
      .insert(sourceContent)
      .values({ sourceId, text, html: result.html ?? null })
      .onConflictDoNothing({ target: sourceContent.sourceId })
      .run();

    // Chunk and store windows
    const windows = splitIntoWindows(text, {
      targetTokens: 1000,
      overlapRatio: 0.15,
      charsPerToken: 4,
      respectParagraphs: true,
    });

    let pos = 0;
    for (const w of windows) {
      await db
        .insert(chunks)
        .values({
          id: newId(),
          sourceId,
          pos: pos++,
          charStart: w.charStart,
          charEnd: w.charEnd,
          text: w.text,
          tokens: w.approxTokens,
        })
        .run();
    }

    return { url, status: "ok", sourceId };
  } catch (e: any) {
    return { url, status: "error", message: e?.message ?? "ingest failed" };
  }
}

async function enqueue(url: string, priority: number): Promise<IngestResult> {
  try {
    // If already present as a source, short-circuit as exists
    const existing = await db
      .select()
      .from(sources)
      .where(eq(sources.url, url))
      .limit(1);
    if (existing.length > 0) {
      return { url, status: "exists", sourceId: existing[0]!.id };
    }

    // Insert into queue
    await db
      .insert(ingestQueue)
      .values({
        id: newId(),
        url,
        priority,
        status: "queued",
        attempts: 0,
      })
      .run();

    return { url, status: "queued" };
  } catch (e: any) {
    return { url, status: "error", message: e?.message ?? "enqueue failed" };
  }
}

function normalizeUrl(input: string): string {
  const s = input.trim();
  if (/^https?:\/\//i.test(s)) return s;
  return `https://${s.replace(/^\/+/, "")}`;
}

function canonicalizeUrl(u: string): string | null {
  try {
    const url = new URL(u);
    url.hash = "";

    // Remove common tracking params
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

    // Sort params for stable URL
    const entries = Array.from(url.searchParams.entries()).sort(([a], [b]) =>
      a.localeCompare(b)
    );
    url.search = "";
    for (const [k, v] of entries) url.searchParams.append(k, v);

    // Lowercase protocol/host; trim trailing slash for non-root
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    if (url.pathname.endsWith("/") && url.pathname !== "/") {
      url.pathname = url.pathname.replace(/\/+$/, "");
    }

    return url.toString();
  } catch {
    return null;
  }
}

function tryDomain(u: string): string {
  try {
    return new URL(u).hostname;
  } catch {
    return "unknown";
  }
}

function dedupeArray(xs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    if (!seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}

function isAbortError(err: unknown) {
  return (
    (err instanceof DOMException && err.name === "AbortError") ||
    (typeof err === "object" &&
      err !== null &&
      ("name" in err || "message" in err) &&
      ((err as any).name === "AbortError" ||
        String((err as any).message || "")
          .toLowerCase()
          .includes("abort")))
  );
}

function jsonError(status: number, message: string, details?: unknown) {
  return new Response(JSON.stringify({ error: message, details }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Lightweight concurrency control
 */
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
