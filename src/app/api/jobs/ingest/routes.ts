/* eslint-disable @typescript-eslint/no-explicit-any */
import "server-only";
import { NextRequest } from "next/server";
import { z } from "zod";
import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { loggerWithRequest, logError } from "@/lib/logger";
import { env } from "@/lib/env";
import { db } from "@/db";
import { sources, sourceContent, chunks, ingestQueue } from "@/db/schema";
import { id as newId } from "@/lib/id";
import { sanitizeText, splitIntoWindows } from "@/lib/text";
import { readUrl } from "@/features/research/server/reader";

export const runtime = "nodejs";

/* -------------------------------- Schemas --------------------------------- */

const QuerySchema = z.object({
  limit: z
    .string()
    .optional()
    .transform((v) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.max(1, Math.min(50, Math.trunc(n))) : 10;
    }),
  concurrency: z
    .string()
    .optional()
    .transform((v) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.max(1, Math.min(8, Math.trunc(n))) : 4;
    }),
  reviveStaleSec: z
    .string()
    .optional()
    .transform((v) => {
      const n = Number(v);
      return Number.isFinite(n)
        ? Math.max(60, Math.min(3600, Math.trunc(n)))
        : 300;
    }),
  dryRun: z
    .string()
    .optional()
    .transform((v) => {
      const s = (v ?? "").toLowerCase();
      return s === "1" || s === "true" || s === "yes";
    }),
});

/* -------------------------------- Handlers -------------------------------- */

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}

async function handle(req: NextRequest) {
  const log = loggerWithRequest({
    headers: req.headers,
    method: req.method,
    url: req.url,
  });

  const url = new URL(req.url);
  const qs = QuerySchema.safeParse({
    limit: url.searchParams.get("limit") ?? undefined,
    concurrency: url.searchParams.get("concurrency") ?? undefined,
    reviveStaleSec: url.searchParams.get("reviveStaleSec") ?? undefined,
    dryRun: url.searchParams.get("dryRun") ?? undefined,
  });
  if (!qs.success) {
    return jsonError(400, "Invalid query params", qs.error.flatten());
  }
  const limit = qs.data.limit!;
  const concurrency = qs.data.concurrency!;
  const reviveStaleSec = qs.data.reviveStaleSec!;
  const dryRun = qs.data.dryRun ?? false;

  try {
    // Revive stale 'processing' items (if any)
    const revived = await reviveStaleProcessing(reviveStaleSec);

    // Claim a batch of queued items
    const claimed = dryRun ? [] : await claimBatch(limit);

    // Process items
    const results = dryRun
      ? []
      : await mapLimit(claimed, concurrency, (row) =>
          processQueueItem(row.id, row.url, req.signal).catch((e) => ({
            id: row.id,
            url: row.url,
            status: "error" as const,
            error: String(e?.message ?? e),
          }))
        );

    // Remaining queued items (approx)
    const remaining = await countQueued();

    const ok = results.filter((r) => r.status === "ok").length;
    const exists = results.filter((r) => r.status === "exists").length;
    const requeued = results.filter((r) => r.status === "requeued").length;
    const errors = results.filter((r) => r.status === "error").length;

    const body = {
      revived,
      claimed: claimed.length,
      processed: results.length,
      ok,
      exists,
      requeued,
      errors,
      remaining,
      results,
    };

    return new Response(JSON.stringify(body), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    if (isAbortError(e)) return new Response(null, { status: 499 });
    logError(log, e, "Ingest job failed");
    return jsonError(500, "Ingest job failed");
  }
}

/* --------------------------------- Core ----------------------------------- */

async function reviveStaleProcessing(staleSec: number): Promise<number> {
  // Mark 'processing' rows that have been stuck as 'queued' again
  const cutoffDate = new Date(Date.now() - staleSec * 1000);

  // Select stale processing items
  const stuck = await db
    .select({ id: ingestQueue.id })
    .from(ingestQueue)
    .where(
      and(
        eq(ingestQueue.status, "processing"),
        lt(ingestQueue.updatedAt, cutoffDate)
      )
    );

  if (stuck.length === 0) return 0;

  await db
    .update(ingestQueue)
    .set({ status: "queued", updatedAt: new Date() })
    .where(
      inArray(
        ingestQueue.id,
        stuck.map((r) => r.id)
      )
    )
    .run();

  return stuck.length;
}

async function claimBatch(limit: number) {
  return await db.transaction(async (tx) => {
    // Pick top N queued by priority DESC, attempts ASC, created_at ASC
    const batch = await tx
      .select({
        id: ingestQueue.id,
        url: ingestQueue.url,
      })
      .from(ingestQueue)
      .where(eq(ingestQueue.status, "queued"))
      .orderBy(
        desc(ingestQueue.priority),
        asc(ingestQueue.attempts),
        asc(ingestQueue.createdAt)
      )
      .limit(limit);

    const ids = batch.map((b) => b.id);
    if (ids.length === 0) return [] as { id: string; url: string }[];

    // Claim them
    await tx
      .update(ingestQueue)
      .set({ status: "processing", updatedAt: new Date() })
      .where(
        and(eq(ingestQueue.status, "queued"), inArray(ingestQueue.id, ids))
      )
      .run();

    return batch;
  });
}

async function processQueueItem(
  id: string,
  url: string,
  abortSignal?: AbortSignal
): Promise<
  | { id: string; url: string; status: "ok"; sourceId: string }
  | { id: string; url: string; status: "exists"; sourceId: string }
  | { id: string; url: string; status: "requeued"; attempts: number }
  | {
      id: string;
      url: string;
      status: "error";
      error: string;
      attempts: number;
    }
> {
  // If source exists, mark done quickly
  const existing = await db
    .select()
    .from(sources)
    .where(eq(sources.url, url))
    .limit(1);
  if (existing.length > 0) {
    await db
      .update(ingestQueue)
      .set({ status: "done", updatedAt: new Date() })
      .where(eq(ingestQueue.id, id))
      .run();
    return { id, url, status: "exists", sourceId: existing[0]!.id };
  }

  try {
    // Read via reader (Jina w/ fallback)
    const result = await readUrl(url, {
      timeoutMs: env.REQUEST_TIMEOUT_MS,
      signal: abortSignal,
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

    // If a concurrent worker inserted the same URL, fetch its id
    let finalSourceId = sourceId;
    const after = await db
      .select()
      .from(sources)
      .where(eq(sources.url, url))
      .limit(1);
    if (after.length > 0) finalSourceId = after[0]!.id;

    await db
      .insert(sourceContent)
      .values({ sourceId: finalSourceId, text, html: result.html ?? null })
      .onConflictDoNothing({ target: sourceContent.sourceId })
      .run();

    // Chunk and store
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
          sourceId: finalSourceId,
          pos: pos++,
          charStart: w.charStart,
          charEnd: w.charEnd,
          text: w.text,
          tokens: w.approxTokens,
        })
        .run();
    }

    await db
      .update(ingestQueue)
      .set({ status: "done", updatedAt: new Date() })
      .where(eq(ingestQueue.id, id))
      .run();

    return { id, url, status: "ok", sourceId: finalSourceId };
  } catch (e: any) {
    // Backoff/requeue if under attempt limit
    const row = await db
      .select({ attempts: ingestQueue.attempts })
      .from(ingestQueue)
      .where(eq(ingestQueue.id, id))
      .limit(1);
    const attempts = (row[0]?.attempts ?? 0) + 1;

    const maxAttempts = 3;
    if (attempts < maxAttempts) {
      await db
        .update(ingestQueue)
        .set({
          attempts,
          status: "queued",
          updatedAt: new Date(),
          error: truncate(String(e?.message ?? "ingest failed"), 500),
        })
        .where(eq(ingestQueue.id, id))
        .run();
      return { id, url, status: "requeued", attempts };
    } else {
      await db
        .update(ingestQueue)
        .set({
          attempts,
          status: "error",
          updatedAt: new Date(),
          error: truncate(String(e?.message ?? "ingest failed"), 500),
        })
        .where(eq(ingestQueue.id, id))
        .run();
      return {
        id,
        url,
        status: "error",
        error: String(e?.message ?? "ingest failed"),
        attempts,
      };
    }
  }
}

/* --------------------------------- Utils ---------------------------------- */

function tryDomain(u: string): string {
  try {
    return new URL(u).hostname;
  } catch {
    return "unknown";
  }
}

function truncate(s: string, max = 500): string {
  if (!s) return "";
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
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

async function countQueued(): Promise<number> {
  const rows = await db
    .select({ c: sql<number>`count(*)` })
    .from(ingestQueue)
    .where(eq(ingestQueue.status, "queued"));

  const n = rows[0]?.c ?? 0;
  return Number.isFinite(n) ? n : Number(n) || 0;
}
