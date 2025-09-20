/* eslint-disable @typescript-eslint/no-explicit-any */
import "server-only";
import { inArray, eq } from "drizzle-orm";
import { env } from "@/lib/env";
import { logger, startSpan, logError } from "@/lib/logger";
import { id as newId } from "@/lib/id";
import {
  estimateTokens,
  splitIntoWindows,
  findQuoteOffsets,
  sanitizeText,
} from "@/lib/text";
import { db, client } from "@/db";
import {
  threads,
  messages,
  sources as sourcesTable,
  sourceContent,
  chunks as chunksTable,
  claims as claimsTable,
  claimEvidence as claimEvidenceTable,
} from "@/db/schema";
import {
  ResearchRequest,
  ResearchRequestSchema,
  Depth,
  SourceRef,
  ContextChunk,
  PlanResponseSchema,
  VerifyClaimsResponse,
  VerifyClaimsResponseSchema,
} from "../types";
import { deepsearch } from "./deepsearch";
import { readUrl } from "./reader";
import {
  buildPlanPrompt,
  buildAnswerPrompt,
  buildVerifyClaimsPrompt,
} from "../prompts";
import { streamCompletion, generateCompletion } from "./groq";

export type DeepResearchEmitEvent =
  | {
      event: "progress";
      data: {
        stage: ProgressStage;
        message?: string;
        meta?: Record<string, unknown>;
      };
    }
  | { event: "token"; data: string }
  | { event: "sources"; data: SourceRef[] }
  | { event: "claims"; data: VerifyClaimsResponse }
  | { event: "error"; data: { message: string } }
  | { event: "done"; data: { threadId: string } };

export type ProgressStage =
  | "plan"
  | "search"
  | "read"
  | "rank"
  | "answer"
  | "verify"
  | "done";

export type DeepResearchOptions = {
  emit?: (e: DeepResearchEmitEvent) => void;
  signal?: AbortSignal;
  maxSourcesInline?: number;
  perQueryResults?: number;
  rankLimit?: number;
  limitPerSource?: number;
};

export type DeepResearchResult = {
  threadId: string;
  question: string;
  sources: SourceRef[];
  context: { sources: SourceRef[]; chunks: ContextChunk[] };
  answerMarkdown: string;
  verified: VerifyClaimsResponse;
};

export async function deepResearch(
  input: ResearchRequest,
  opts: DeepResearchOptions = {}
): Promise<DeepResearchResult> {
  const parsed = ResearchRequestSchema.safeParse(input);
  if (!parsed.success)
    throw new Error("Invalid ResearchRequest: " + parsed.error.message);

  const req = parsed.data;
  const emit = opts.emit ?? (() => {});
  const abortSig = opts.signal;
  const log = logger.child({ mod: "deepresearch" });

  const threadId = newId();
  await db.insert(threads).values({ id: threadId, title: req.question }).run();

  emit({
    event: "progress",
    data: { stage: "plan", message: "Planning subqueries" },
  });

  const planSpan = startSpan(log, "plan");
  const plan = await planSubqueries(req).catch((e) => {
    logError(log, e, "plan failed - falling back to naive plan");
    return {
      intent: req.question,
      subqueries: [req.question],
      focus: [],
      constraints: {
        timeRange: req.timeRange ?? null,
        region: req.region ?? null,
        allowedDomains: req.allowedDomains ?? null,
        disallowedDomains: req.disallowedDomains ?? null,
      },
    };
  });
  planSpan.end({ subqueries: plan.subqueries.length });

  emit({
    event: "progress",
    data: { stage: "search", message: "Searching the web" },
  });
  const searchSpan = startSpan(log, "search");

  const perQuery =
    opts.perQueryResults ??
    (req.depth === "deep" ? 12 : req.depth === "quick" ? 4 : 8);

  const searchResults = (
    await mapLimit(plan.subqueries, 3, (q) =>
      withRetry(
        () =>
          deepsearch(q, {
            size: perQuery,
            timeRange: req.timeRange,
            allowedDomains: req.allowedDomains,
            disallowedDomains: req.disallowedDomains,
          }),
        { retries: 2, baseDelay: 400, signal: abortSig }
      )
    )
  ).flat();

  const deduped = dedupeUrls(searchResults.map((r) => r.url));
  searchSpan.end({ urls: deduped.length });

  if (deduped.length === 0) {
    const assistantText =
      "I could not find suitable sources to answer this yet. Try adding specifics (timeframe, entities) or different keywords.";

    const userMsgId = newId();
    const assistantMsgId = newId();
    await db
      .insert(messages)
      .values([
        { id: userMsgId, threadId, role: "user", contentMd: req.question },
        {
          id: assistantMsgId,
          threadId,
          role: "assistant",
          contentMd: assistantText,
        },
      ])
      .run();

    emit({ event: "sources", data: [] });
    emit({ event: "claims", data: { claims: [] } });
    emit({ event: "done", data: { threadId } });

    return {
      threadId,
      question: req.question,
      sources: [],
      context: { sources: [], chunks: [] },
      answerMarkdown: assistantText,
      verified: { claims: [] },
    };
  }

  emit({
    event: "progress",
    data: { stage: "read", message: `Reading ${deduped.length} sources` },
  });
  const readSpan = startSpan(log, "read");

  const inlineCap = Math.min(
    Math.max(1, opts.maxSourcesInline ?? env.MAX_SOURCES_INLINE),
    deduped.length
  );
  const urlsInline = deduped.slice(0, inlineCap);

  const ingested = await mapLimit(urlsInline, 4, (u) =>
    withRetry(() => ingestUrl(u, { title: undefined }), {
      retries: 1,
      baseDelay: 500,
      signal: abortSig,
    })
  );

  const okIngests = ingested.filter(
    (x): x is IngestResult & { ok: true } => x.ok
  );
  readSpan.end({ sources: okIngests.length });

  const sourceRefs: SourceRef[] = okIngests.map((s, idx) => ({
    id: s.sourceId,
    url: s.url,
    title: s.title ?? null,
    domain: s.domain ?? null,
    index: idx + 1,
  }));

  emit({ event: "sources", data: sourceRefs });

  emit({
    event: "progress",
    data: { stage: "rank", message: "Ranking snippets" },
  });
  const rankSpan = startSpan(log, "rank");

  await ensureFts5();

  const rankLimit = opts.rankLimit ?? 24;
  const hits = await rankChunks(
    [req.question, ...plan.subqueries],
    rankLimit * 3
  );

  const selected: RankedHit[] = diversifyBySource(hits, rankLimit);
  rankSpan.end({ selected: selected.length });

  const selectedSourceIds: string[] = Array.from(
    new Set(selected.map((h: RankedHit) => h.sourceId))
  );

  const limitPerSource = Math.max(1, Math.min(opts.limitPerSource ?? 3, 8));
  const perSourceBags = new Map<string, ContextChunk[]>();
  for (const h of selected) {
    const bag = perSourceBags.get(h.sourceId) ?? [];
    if (bag.length < limitPerSource) {
      bag.push({ sourceId: h.sourceId, chunkId: h.id, text: h.text });
      perSourceBags.set(h.sourceId, bag);
    }
  }

  const usedSourceRefs: SourceRef[] = [];
  let n = 1;
  const indexMap = new Map<string, number>();
  for (const sid of selectedSourceIds) {
    const found = sourceRefs.find((s) => s.id === sid);
    if (found) {
      usedSourceRefs.push({ ...found, index: n });
    } else {
      // sid typed as string; eq expects string
      const srow = await db
        .select()
        .from(sourcesTable)
        .where(eq(sourcesTable.id, sid))
        .limit(1);
      const s = srow[0];
      if (s) {
        usedSourceRefs.push({
          id: s.id,
          url: s.url,
          title: s.title ?? null,
          domain: s.domain ?? null,
          index: n,
        });
      }
    }
    indexMap.set(sid, n);
    n++;
  }

  const contextChunks: ContextChunk[] = [];
  for (const sref of usedSourceRefs) {
    const bag = perSourceBags.get(sref.id) ?? [];
    for (const c of bag) contextChunks.push(c);
  }

  emit({
    event: "progress",
    data: { stage: "answer", message: "Drafting answer" },
  });

  const { system: answerSystem, user: answerUser } = buildAnswerPrompt({
    question: req.question,
    sources: usedSourceRefs,
    chunks: contextChunks,
    style: req.depth === "quick" ? "concise" : "neutral",
  });

  const answerSpan = startSpan(log, "answer");

  const answerResult = await streamCompletion({
    model: "answer",
    system: answerSystem,
    prompt: answerUser,
    temperature: 0.2,
    maxOutputTokens: 1200,
    abortSignal: abortSig,
  });

  let answerBuffer = "";
  for await (const delta of answerResult.textStream) {
    answerBuffer += delta;
    emit({ event: "token", data: delta });
  }
  const answerMarkdown = answerBuffer.trim();
  answerSpan.end({ tokens: estimateTokens(answerMarkdown) });

  const userMsgId = newId();
  const assistantMsgId = newId();
  await db
    .insert(messages)
    .values([
      { id: userMsgId, threadId, role: "user", contentMd: req.question },
      {
        id: assistantMsgId,
        threadId,
        role: "assistant",
        contentMd: answerMarkdown,
      },
    ])
    .run();

  emit({
    event: "progress",
    data: { stage: "verify", message: "Verifying claims" },
  });
  const verifySpan = startSpan(log, "verify");

  const verifyPrompt = buildVerifyClaimsPrompt({
    answerMarkdown,
    snippets: contextChunks.map((c) => ({
      sourceId: c.sourceId,
      chunkId: c.chunkId,
      text: c.text,
    })),
    maxClaims: req.depth === "quick" ? 6 : req.depth === "deep" ? 18 : 12,
  });

  const verifyRes = await generateCompletion({
    model: "verify",
    system: verifyPrompt.system,
    prompt: verifyPrompt.user,
    temperature: 0,
    maxOutputTokens: 1200,
    abortSignal: abortSig,
  });

  const verifiedJson = safeJson(verifyRes.text);
  const verifiedParse = VerifyClaimsResponseSchema.safeParse(verifiedJson);
  const verified: VerifyClaimsResponse = verifiedParse.success
    ? verifiedParse.data
    : { claims: [] };

  await bindOffsetsForEvidence(verified);
  await persistClaims(threadId, assistantMsgId, verified);

  emit({ event: "claims", data: verified });
  verifySpan.end({ claimCount: verified.claims.length });

  emit({ event: "done", data: { threadId } });

  return {
    threadId,
    question: req.question,
    sources: usedSourceRefs,
    context: { sources: usedSourceRefs, chunks: contextChunks },
    answerMarkdown,
    verified,
  };
}

/* --------------------------------- Planning -------------------------------- */

async function planSubqueries(req: ResearchRequest) {
  const prompt = buildPlanPrompt({
    question: req.question,
    depth: req.depth as Depth,
    region: req.region,
    timeRange: req.timeRange,
    allowedDomains: req.allowedDomains,
    disallowedDomains: req.disallowedDomains,
    maxSubqueries: req.depth === "deep" ? 6 : req.depth === "quick" ? 3 : 4,
  });

  const res = await generateCompletion({
    model: "plan",
    system: prompt.system,
    prompt: prompt.user,
    temperature: 0,
    maxOutputTokens: 600,
  });

  const json = safeJson(res.text);
  const out = PlanResponseSchema.safeParse(json);
  if (!out.success)
    throw new Error("Failed to parse plan JSON: " + out.error.message);
  if (!out.data.subqueries?.length) out.data.subqueries = [req.question];
  return out.data;
}

/* -------------------------------- Ingestion -------------------------------- */

type IngestResult =
  | {
      ok: true;
      sourceId: string;
      url: string;
      domain: string;
      title?: string | null;
    }
  | { ok: false; url: string; error: string };

async function ingestUrl(
  url: string,
  meta?: { title?: string }
): Promise<IngestResult> {
  try {
    const existing = await db
      .select()
      .from(sourcesTable)
      .where(eq(sourcesTable.url, url))
      .limit(1);
    const title: string | null | undefined =
      meta?.title ?? existing[0]?.title ?? null;

    let sourceId: string;
    if (existing.length > 0) {
      sourceId = existing[0].id!;
    } else {
      const content = await readUrl(url);
      const text = sanitizeText(content.text, {
        normalize: "NFKC",
        removeControl: true,
        collapseWhitespace: false,
        preserveNewlines: true,
        decodeEntities: true,
      });

      sourceId = newId();
      const domain = tryDomain(url);
      await db
        .insert(sourcesTable)
        .values({
          id: sourceId,
          url,
          domain,
          title: title ?? null,
          status: "ok",
        })
        .onConflictDoNothing({ target: sourcesTable.url })
        .run();

      await db
        .insert(sourceContent)
        .values({ sourceId, text, html: content.html ?? null })
        .onConflictDoNothing({ target: sourceContent.sourceId })
        .run();

      const windows = splitIntoWindows(text, {
        targetTokens: 1000,
        overlapRatio: 0.15,
        charsPerToken: 4,
        respectParagraphs: true,
      });

      let pos = 0;
      for (const w of windows) {
        await db
          .insert(chunksTable)
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
    }

    const row =
      existing.length > 0
        ? existing[0]
        : (
            await db
              .select()
              .from(sourcesTable)
              .where(eq(sourcesTable.id, sourceId))
              .limit(1)
          )[0];

    return {
      ok: true,
      sourceId,
      url,
      domain: row.domain!,
      title: row.title ?? title ?? null,
    };
  } catch (e: any) {
    return { ok: false, url, error: e?.message ?? "ingest failed" };
  }
}

/* --------------------------------- Ranking --------------------------------- */

type RankedHit = { id: string; sourceId: string; text: string; score: number };

async function rankChunks(
  queries: string[],
  cap: number
): Promise<RankedHit[]> {
  const perQ = Math.max(4, Math.ceil(cap / Math.max(1, queries.length)) * 2);
  const results: RankedHit[] = [];

  for (const qRaw of queries) {
    const q = toFtsMatchQuery(qRaw);

    try {
      const res = await client.execute({
        sql: `
          SELECT c.id AS id,
                 c.source_id AS sourceId,
                 c.text AS text,
                 bm25(chunks_fts) AS bm25
          FROM chunks_fts
          JOIN chunks c ON c.rowid = chunks_fts.rowid
          WHERE chunks_fts MATCH ?
          LIMIT ?;
        `,
        args: [q, perQ],
      });

      const rows = Array.isArray(res.rows) ? (res.rows as any[]) : [];
      for (const r of rows) {
        const bm = typeof r.bm25 === "number" ? r.bm25 : Number(r.bm25 ?? 0);
        const score = bm > 0 ? 1 / (1 + bm) : 0.5;
        results.push({
          id: String(r.id),
          sourceId: String(r.sourceId),
          text: String(r.text ?? ""),
          score,
        });
      }
    } catch (e: any) {
      if (String(e?.message || "").includes("no such table: chunks_fts")) {
        await ensureFts5();
        const res2 = await client.execute({
          sql: `
            SELECT c.id AS id,
                   c.source_id AS sourceId,
                   c.text AS text,
                   bm25(chunks_fts) AS bm25
            FROM chunks_fts
            JOIN chunks c ON c.rowid = chunks_fts.rowid
            WHERE chunks_fts MATCH ?
            LIMIT ?;
          `,
          args: [q, perQ],
        });
        const rows2 = Array.isArray(res2.rows) ? (res2.rows as any[]) : [];
        for (const r of rows2) {
          const bm = typeof r.bm25 === "number" ? r.bm25 : Number(r.bm25 ?? 0);
          const score = bm > 0 ? 1 / (1 + bm) : 0.5;
          results.push({
            id: String(r.id),
            sourceId: String(r.sourceId),
            text: String(r.text ?? ""),
            score,
          });
        }
      } else {
        throw e;
      }
    }
  }

  const best = new Map<string, RankedHit>();
  for (const h of results) {
    const prev = best.get(h.id);
    if (!prev || h.score > prev.score) best.set(h.id, h);
  }

  const sorted = Array.from(best.values()).sort((a, b) => b.score - a.score);
  return sorted.slice(0, cap);
}

function diversifyBySource(hits: RankedHit[], cap: number): RankedHit[] {
  const buckets = new Map<string, RankedHit[]>();
  for (const h of hits) {
    const list = buckets.get(h.sourceId) ?? [];
    list.push(h);
    buckets.set(h.sourceId, list);
  }
  for (const [, list] of buckets) list.sort((a, b) => b.score - a.score);

  const order = Array.from(buckets.keys());
  const out: RankedHit[] = [];
  let idx = 0;

  while (out.length < cap && buckets.size > 0) {
    const key = order[idx % order.length];
    const arr = buckets.get(key);
    if (arr && arr.length > 0) {
      out.push(arr.shift()!);
      if (arr.length === 0) buckets.delete(key);
    }
    idx++;
    if (idx > cap * 10) break;
  }

  return out;
}

async function ensureFts5(): Promise<void> {
  await client.execute({
    sql: `
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts
      USING fts5(text, content='chunks', content_rowid='rowid');
    `,
    args: [],
  });

  await client.execute({
    sql: `
      CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
        INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text);
      END;
    `,
    args: [],
  });

  await client.execute({
    sql: `
      CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.rowid, old.text);
      END;
    `,
    args: [],
  });

  await client.execute({
    sql: `
      CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.rowid, old.text);
        INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text);
      END;
    `,
    args: [],
  });
}

function toFtsMatchQuery(input: string): string {
  const tokens = (input || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 12);

  if (tokens.length === 0) {
    const safe = (input || "").replace(/["']/g, " ");
    return `"${safe.trim()}"`;
  }

  return tokens.map((t) => `"${t.replace(/"/g, " ")}"`).join(" AND ");
}

/* --------------------------------- Verify ---------------------------------- */

async function bindOffsetsForEvidence(verified: VerifyClaimsResponse) {
  const chunkIds = Array.from(
    new Set(
      verified.claims.flatMap(
        (c) => c.evidence.map((e) => e.chunkId).filter(Boolean) as string[]
      )
    )
  );

  if (chunkIds.length === 0) return;

  const rows = await db
    .select({ id: chunksTable.id, text: chunksTable.text })
    .from(chunksTable)
    .where(inArray(chunksTable.id, chunkIds));

  const textMap = new Map<string, string>();
  for (const r of rows) textMap.set(r.id, r.text);

  for (const claim of verified.claims) {
    for (const ev of claim.evidence) {
      if (!ev.chunkId || ev.charStart !== undefined) continue;
      const hay = textMap.get(ev.chunkId);
      if (!hay) continue;
      const offsets = findQuoteOffsets(hay, ev.quote, {
        ignoreCase: true,
        ignoreWhitespace: true,
        normalizeDashes: true,
        normalizeQuotes: true,
      });
      if (offsets) {
        ev.charStart = offsets.start;
        ev.charEnd = offsets.end;
      }
    }
  }
}

async function persistClaims(
  threadId: string,
  messageId: string,
  verified: VerifyClaimsResponse
) {
  for (const c of verified.claims) {
    const claimId = newId();
    await db
      .insert(claimsTable)
      .values({
        id: claimId,
        messageId,
        text: c.text,
        claimType: c.claimType ?? null,
        supportScore: c.supportScore,
        contradicted: Boolean(c.contradicted),
        uncertaintyReason: c.uncertaintyReason ?? null,
      })
      .run();

    for (const ev of c.evidence) {
      await db
        .insert(claimEvidenceTable)
        .values({
          id: newId(),
          claimId,
          sourceId: ev.sourceId,
          chunkId: ev.chunkId ?? "",
          quote: ev.quote,
          charStart: ev.charStart ?? 0,
          charEnd:
            ev.charEnd ?? Math.max(0, (ev.charStart ?? 0) + ev.quote.length),
          score: null,
        })
        .run();
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

function dedupeUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of urls) {
    if (!u) continue;
    if (!seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  }
  return out;
}

function safeJson(s: string): any {
  try {
    const t = (s ?? "").trim();
    const unwrapped = t.startsWith("```")
      ? t.replace(/^```[a-zA-Z]*\n?/, "").replace(/```$/, "")
      : t;
    return JSON.parse(unwrapped);
  } catch {
    return {};
  }
}

async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { retries?: number; baseDelay?: number; signal?: AbortSignal }
): Promise<T> {
  const retries = Math.max(0, opts.retries ?? 0);
  const base = Math.max(10, opts.baseDelay ?? 200);
  let attempt = 0;
  while (true) {
    if (opts.signal?.aborted) throw opts.signal.reason ?? new Error("Aborted");
    try {
      return await fn();
    } catch (e) {
      if (attempt >= retries) throw e;
      const delay = base * Math.pow(2, attempt) + Math.random() * 50;
      await sleep(delay, opts.signal);
      attempt++;
    }
  }
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => resolve(), ms);
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
  arr: T[],
  limit: number,
  fn: (item: T, idx: number) => Promise<R>
): Promise<R[]> {
  if (arr.length === 0) return [];
  const results = new Array<R>(arr.length);
  let i = 0;
  let inFlight = 0;
  return await new Promise<R[]>((resolve, reject) => {
    const next = () => {
      if (i >= arr.length && inFlight === 0) {
        resolve(results);
        return;
      }
      while (inFlight < limit && i < arr.length) {
        const idx = i++;
        inFlight++;
        Promise.resolve(fn(arr[idx], idx))
          .then((res) => {
            results[idx] = res;
            inFlight--;
            next();
          })
          .catch((err) => reject(err));
      }
    };
    next();
  });
}
