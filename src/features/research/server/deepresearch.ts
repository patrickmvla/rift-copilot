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
import type { SearchResult } from "./deepsearch";
import { readUrl } from "./reader";
import {
  buildPlanPrompt,
  buildAnswerPrompt,
  buildVerifyClaimsPrompt,
} from "../prompts";
import { streamCompletion, generateCompletion } from "./groq";
import { rankForQueries } from "./rank";

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
  | { event: "done"; data: { threadId: string } }
  | { event: "answer"; data: { text: string } };

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

  // Fetch results per subquery (titles preserved)
  const allResults: SearchResult[][] = await mapLimit(plan.subqueries, 3, (q) =>
    withRetry(
      () =>
        deepsearch(q, {
          size: perQuery,
          timeRange: req.timeRange,
          allowedDomains: req.allowedDomains,
          disallowedDomains: req.disallowedDomains,
          region: req.region,
          abortSignal: abortSig,
        }),
      { retries: 2, baseDelay: 400, signal: abortSig }
    )
  );

  const searchResults = allResults.flat();

  // Keep first-seen title per URL
  const urlMeta = new Map<string, { title?: string | null }>();
  for (const r of searchResults) {
    if (!urlMeta.has(r.url)) urlMeta.set(r.url, { title: r.title ?? null });
  }

  const deduped = dedupeUrls(searchResults.map((r) => r.url));
  searchSpan.end({ urls: deduped.length });
  emit({
    event: "progress",
    data: {
      stage: "search",
      message: `Found ${deduped.length} unique URLs`,
      meta: { unique: deduped.length },
    },
  });

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

  // Read concurrency (tunable via READER_CONCURRENCY; default 2)
  const readConc = Math.max(
    1,
    Math.min(4, Number(process.env.READER_CONCURRENCY ?? 2))
  );

  // Ingest with small progress updates
  let readDone = 0;
  const ingested = await mapLimit(urlsInline, readConc, async (u) => {
    const res = await withRetry(
      () =>
        ingestUrl(
          u,
          { title: urlMeta.get(u)?.title ?? undefined },
          chooseReaderPrefer(u)
        ),
      {
        retries: 1,
        baseDelay: 500,
        signal: abortSig,
      }
    );
    readDone++;
    if (readDone === urlsInline.length || readDone % 2 === 0) {
      emit({
        event: "progress",
        data: {
          stage: "read",
          message: `Read ${readDone}/${urlsInline.length}`,
          meta: { done: readDone, total: urlsInline.length },
        },
      });
    }
    return res;
  });

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

  /* ------------------------------ Rank ------------------------------------ */

  emit({
    event: "progress",
    data: { stage: "rank", message: "Ranking snippets" },
  });
  const rankSpan = startSpan(log, "rank");

  // Ensure FTS exists and rebuild so existing chunks are indexed
  await ensureFts5();

  const rankLimit = opts.rankLimit ?? 24;
  const limitPerSource = Math.max(1, Math.min(opts.limitPerSource ?? 3, 8));

  // Voyage rerank enabled via ENABLE_RERANK + VOYAGE_API_KEY in env
  let ranked = await rankForQueries([req.question, ...plan.subqueries], {
    cap: rankLimit,
    perQueryTake: rankLimit * 3,
    diversifyBySource: true,
    perSourceLimit: limitPerSource,
    enableRerank: true,
    timeoutMs: env.REQUEST_TIMEOUT_MS,
  });

  // Fallbacks if FTS index was empty or rank failed to find anything
  if (ranked.length === 0) {
    // Try to force a backfill if the FTS index is empty
    await backfillFtsFromChunks();
    // Debug: Log FTS count post-backfill
    const cntFtsPost = await client.execute({
      sql: `SELECT COUNT(1) AS c FROM chunks_fts;`,
      args: [],
    });
    const cFtsPost = Number((cntFtsPost.rows?.[0] as any)?.c ?? 0);
    log.info({ ftsCountPostBackfill: cFtsPost, recentChunks: sourceRefs.length },
      "Post-backfill FTS check");

    ranked = await rankForQueries([req.question, ...plan.subqueries], {
      cap: rankLimit,
      perQueryTake: rankLimit * 3,
      diversifyBySource: true,
      perSourceLimit: limitPerSource,
      enableRerank: true,
      timeoutMs: env.REQUEST_TIMEOUT_MS,
    });
  }

  // Last-resort fallback using LIKE over recently ingested sources
  let hitsForContext: Array<{ id: string; sourceId: string; text: string }> =
    ranked;

  if (hitsForContext.length === 0) {
    const likeHits = await likeFallbackRank(
      [req.question, ...plan.subqueries],
      sourceRefs.map((s) => s.id),
      Math.min(rankLimit * 2, 48) // Cap fallback harder (48 max, not 72)
    );
    hitsForContext = likeHits;
    emit({
      event: "progress",
      data: {
        stage: "rank",
        message: `Fallback ranking (LIKE) selected ${hitsForContext.length} snippets`,
        meta: { selected: hitsForContext.length, fallback: "like" },
      },
    });
  }

  rankSpan.end({ selected: hitsForContext.length });
  emit({
    event: "progress",
    data: {
      stage: "rank",
      message: `Selected ${hitsForContext.length} snippets`,
      meta: { selected: hitsForContext.length },
    },
  });

  const selectedSourceIds: string[] = Array.from(
    new Set(hitsForContext.map((h) => h.sourceId))
  );

  const perSourceBags = new Map<string, ContextChunk[]>();
  for (const h of hitsForContext) {
    const bag = perSourceBags.get(h.sourceId) ?? [];
    if (bag.length < limitPerSource) {
      bag.push({ sourceId: h.sourceId, chunkId: h.id, text: h.text });
      perSourceBags.set(h.sourceId, bag);
    }
  }

  const usedSourceRefs: SourceRef[] = [];
  let n = 1;
  for (const sid of selectedSourceIds) {
    const found = sourceRefs.find((s) => s.id === sid);
    if (found) {
      usedSourceRefs.push({ ...found, index: n });
    } else {
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
    n++;
  }

  const contextChunks: ContextChunk[] = [];
  for (const sref of usedSourceRefs) {
    const bag = perSourceBags.get(sref.id) ?? [];
    for (const c of bag) contextChunks.push(c);
  }

   /* ------------------------------ Answer ---------------------------------- */

  emit({
    event: "progress",
    data: { stage: "answer", message: "Drafting answer" },
  });

  // Limit the input to avoid Groq on_demand 6k TPM spikes.
  // You can tune these via env if needed.
  const INPUT_BUDGET_TOKENS = Math.max(
    1200,
    Number(process.env.ANSWER_INPUT_BUDGET_TOKENS ?? 3200) // tighter default
  );
  const PROMPT_OVERHEAD_TOKENS = Math.max(
    400,
    Number(process.env.ANSWER_PROMPT_OVERHEAD_TOKENS ?? 800)
  );
  const MAX_CHARS_PER_CHUNK = Math.max(
    400,
    Number(process.env.ANSWER_MAX_CHARS_PER_CHUNK ?? 900)
  );

  // Only include sources actually referenced by the selected chunks
  const ctxSourceIds = new Set(contextChunks.map((c) => c.sourceId));
  const minimalSourceRefs = usedSourceRefs.filter((s) =>
    ctxSourceIds.has(s.id)
  );

  // Shrink chunks (truncate long ones) and trim to the token budget
  const shrunkChunks: ContextChunk[] = contextChunks.map((c) => ({
    ...c,
    text: shrinkChunkText(c.text, MAX_CHARS_PER_CHUNK),
  }));
  const budgetedChunks = trimChunksToBudget(
    shrunkChunks,
    INPUT_BUDGET_TOKENS,
    PROMPT_OVERHEAD_TOKENS
  );

  const buildAndStream = async (chunksForPrompt: ContextChunk[]) => {
    const { system: answerSystem, user: answerUser } = buildAnswerPrompt({
      question: req.question,
      sources: minimalSourceRefs, // use minimal refs to save tokens
      chunks: chunksForPrompt,
      style: req.depth === "quick" ? "concise" : "neutral",
    });

    const answerSpan = startSpan(log, "answer");
    const answerResult = await streamCompletion({
      model: "answer",
      system: answerSystem,
      prompt: answerUser,
      temperature: 0.2,
      maxOutputTokens: 900, // keep completion capped too
      abortSignal: abortSig,
    });

    let answerBuffer = "";
    let streamedChunks = 0;

    for await (const delta of answerResult.textStream) {
      if (delta && delta.length) {
        streamedChunks++;
        answerBuffer += delta;
        emit({ event: "token", data: delta });
      }
    }

    const full = answerBuffer.trim();

    // Safety: if client ignored stream tokens, still deliver full answer once
    if (streamedChunks === 0 && full.length > 0) {
      emit({ event: "token", data: full });
    }

    // Also emit a non-streaming "answer" event for consumers that prefer it
    emit({ event: "answer", data: { text: full } });

    answerSpan.end({ tokens: estimateTokens(full) });
    return full;
  };

  let answerMarkdown = "";
  let skipVerifyForBudget = false;

  try {
    // First attempt with budgeted chunks
    answerMarkdown = await buildAndStream(budgetedChunks);
  } catch (e: any) {
    const msg = String(e?.message || "").toLowerCase();
    const isTPM =
      msg.includes("tokens per minute") ||
      msg.includes("tpm") ||
      msg.includes("request too large");

    if (isTPM) {
      // Retry once with half the budget (smaller context)
      const smallerBudget = Math.max(1000, Math.floor(INPUT_BUDGET_TOKENS / 2));
      const smaller = trimChunksToBudget(
        shrunkChunks,
        smallerBudget,
        PROMPT_OVERHEAD_TOKENS
      );
      emit({
        event: "progress",
        data: {
          stage: "answer",
          message: "Context too large; retrying with smaller context",
          meta: { budgetTokens: smallerBudget },
        },
      });
      answerMarkdown = await buildAndStream(smaller);
      skipVerifyForBudget = String(process.env.SKIP_VERIFY_ON_TPM ?? "1") !== "0";
    } else {
      throw e;
    }
  }

  // Persist conversation
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
  /* ------------------------------ Verify ---------------------------------- */

  emit({
    event: "progress",
    data: { stage: "verify", message: "Verifying claims" },
  });
  const verifySpan = startSpan(log, "verify");

  // Reuse answer's budget logic for verify (tighter, since non-streaming)
  const VERIFY_INPUT_BUDGET_TOKENS = Math.max(
    800,
    Number(process.env.VERIFY_INPUT_BUDGET_TOKENS ?? 1500) // Even tighter
  );
  const VERIFY_OVERHEAD_TOKENS = Math.max(
    300,
    Number(process.env.VERIFY_PROMPT_OVERHEAD_TOKENS ?? 500)
  );

  // For verify, shrink and trim snippets directly (reuse answer logic)
  const verifyShrunkSnippets: { sourceId: string; chunkId?: string; text: string }[] = shrunkChunks.map((c) => ({
    sourceId: c.sourceId,
    chunkId: c.chunkId,
    text: shrinkChunkText(c.text, 400), // Tighter for verify
  }));

  // Trim to budget (treat as ContextChunk for reuse)
  const verifySnippetsBudgeted = trimChunksToBudget(
    verifyShrunkSnippets.map(s => ({ sourceId: s.sourceId, chunkId: s.chunkId, text: s.text } as ContextChunk)),
    VERIFY_INPUT_BUDGET_TOKENS,
    VERIFY_OVERHEAD_TOKENS
  ).map(c => ({
    sourceId: c.sourceId,
    chunkId: c.chunkId,
    text: c.text
  } as { sourceId: string; chunkId?: string; text: string }));

  // If no ranked context, skip verification entirely
  let verified: VerifyClaimsResponse = { claims: [] };
  let skipVerify = contextChunks.length === 0 || usedSourceRefs.length === 0 || skipVerifyForBudget;

  if (!skipVerify) {
    // Budget check: Est. tokens for verify prompt
    const snippetsEst = verifySnippetsBudgeted.reduce((sum, s) => sum + estimateTokens(s.text), 0);
    const estVerifyTokens = estimateTokens(answerMarkdown) + snippetsEst + VERIFY_OVERHEAD_TOKENS;

    if (estVerifyTokens > 5000) { // Hard cap before Groq call
      log.warn({ estTokens: estVerifyTokens, snippets: verifySnippetsBudgeted.length },
        "Verify prompt too large; skipping");
      skipVerify = true;
      verified = { claims: [] };
    } else {
      const verifyPrompt = buildVerifyClaimsPrompt({
        answerMarkdown,
        snippets: verifySnippetsBudgeted,
        maxClaims: req.depth === "quick" ? 6 : req.depth === "deep" ? 18 : 12,
      });

      const verifyRes = await generateCompletion({
        model: "verify",
        system: verifyPrompt.system,
        prompt: verifyPrompt.user,
        temperature: 0,
        maxOutputTokens: 1200,
        abortSignal: abortSig,
      }).catch((e: any) => {
        const msg = String(e?.message || "").toLowerCase();
        const isTPM = msg.includes("tokens per minute") || msg.includes("tpm") || msg.includes("request too large");
        if (isTPM) {
          log.warn({ error: e }, "Verify TPM error; skipping");
          skipVerify = true;
          return { text: '{}' }; // Mock empty JSON
        }
        throw e;
      });

      const verifiedJson = safeJson(verifyRes?.text ?? '{}');
      const verifiedParse = VerifyClaimsResponseSchema.safeParse(verifiedJson);
      const rawVerified: VerifyClaimsResponse = verifiedParse.success
        ? verifiedParse.data
        : { claims: [] };

      // Keep only evidence that references our ranked chunks and known sources
      const allowedSourceIds = new Set<string>(
        usedSourceRefs.map((s) => s.id).filter(isNonEmptyString)
      );
      const allowedChunkIds = new Set<string>(
        verifySnippetsBudgeted.map((s) => s.chunkId).filter(isNonEmptyString)
      );

      verified = normalizeVerifiedClaims(
        rawVerified,
        allowedSourceIds,
        allowedChunkIds
      );
      // Bind offsets only for valid chunk-backed evidence
      await bindOffsetsForEvidence(verified);
    }
  }

  // Persist (no-op if there are no claims or no valid evidence)
  if (!skipVerify) {
    await persistClaims(threadId, assistantMsgId, verified);
  }

  emit({ event: "claims", data: verified });
  verifySpan.end({ 
    claimCount: verified.claims.length,
    estInputTokens: estVerifyTokens ?? 0, // Add for monitoring
    snippetCount: verifySnippetsBudgeted.length 
  });

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

  const raw = safeJson(res.text);

  // Normalize subqueries to string[]
  if (Array.isArray(raw?.subqueries)) {
    raw.subqueries = raw.subqueries
      .map((x: any) =>
        typeof x === "string"
          ? x
          : typeof x?.query === "string"
          ? x.query
          : typeof x?.text === "string"
          ? x.text
          : typeof x?.q === "string"
          ? x.q
          : null
      )
      .filter((s: any) => typeof s === "string" && s.trim().length > 0);
  }

  const out = PlanResponseSchema.safeParse(raw);
  if (!out.success) {
    // Fallback to naive plan
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
  }
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
  meta?: { title?: string },
  prefer?: "jina" | "raw"
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
      const content = await readUrl(url, {
        prefer: prefer ?? chooseReaderPrefer(url),
      });
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

async function ensureFts5(): Promise<void> {
  // Create FTS table and triggers (external content)
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

  // Try rebuild; if still empty, backfill manually
  try {
    await client.execute({
      sql: `INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild');`,
      args: [],
    });
  } catch {
    // ignore
  }
}

async function backfillFtsFromChunks() {
  try {
    const cntFts = await client.execute({
      sql: `SELECT COUNT(1) AS c FROM chunks_fts;`,
      args: [],
    });
    const cFts = Number((cntFts.rows?.[0] as any)?.c ?? 0);

    if (cFts === 0) {
      await client.execute({
        sql: `INSERT INTO chunks_fts(rowid, text) SELECT rowid, text FROM chunks;`,
        args: [],
      });
    }
  } catch {
    // ignore
  }
}

async function likeFallbackRank(
  queries: string[],
  sourceIds: string[],
  cap: number
): Promise<Array<{ id: string; sourceId: string; text: string }>> {
  if (sourceIds.length === 0) return [];
  const tokens = extractQueryTerms(queries.join(" "));
  if (tokens.length === 0) return [];

  const placeholders = sourceIds.map(() => "?").join(",");
  const likeClauses = tokens.map(() => "text LIKE ?").join(" OR ");
  const args = [...sourceIds, ...tokens.map((t) => `%${t}%`), cap];

  try {
    const res = await client.execute({
      sql: `
        SELECT id, source_id AS sourceId, text, tokens
        FROM chunks
        WHERE source_id IN (${placeholders})
          AND (${likeClauses})
        ORDER BY tokens DESC
        LIMIT ?;
      `,
      args,
    });
    const rows = Array.isArray(res.rows) ? (res.rows as any[]) : [];
    return rows.map((r) => ({
      id: String(r.id),
      sourceId: String(r.sourceId),
      text: String(r.text ?? ""),
    }));
  } catch {
    return [];
  }
}

function extractQueryTerms(q: string): string[] {
  return (q || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
    .slice(0, 8);
}

const STOPWORDS = new Set<string>([
  "the",
  "and",
  "for",
  "with",
  "that",
  "are",
  "was",
  "were",
  "this",
  "from",
  "have",
  "has",
  "had",
  "but",
  "not",
  "you",
  "your",
  "into",
  "about",
  "over",
  "under",
  "what",
  "which",
  "when",
  "where",
  "why",
  "how",
  "who",
  "whom",
  "can",
  "could",
  "would",
  "should",
]);

/* --------------------------------- Verify ---------------------------------- */

function normalizeVerifiedClaims(
  input: VerifyClaimsResponse,
  allowedSourceIds: Set<string>,
  allowedChunkIds: Set<string>
): VerifyClaimsResponse {
  // Drop evidence that doesn’t point to a known source/chunk
  const claims = (input.claims ?? []).map((c) => {
    const ev = (c.evidence ?? []).filter(
      (e) =>
        typeof e?.quote === "string" &&
        e.quote.trim().length > 0 &&
        typeof e?.sourceId === "string" &&
        allowedSourceIds.has(e.sourceId) &&
        typeof e?.chunkId === "string" &&
        allowedChunkIds.has(e.chunkId)
    );
    return { ...c, evidence: ev };
  });

  return { claims };
}

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

// Trim chunks to fit a rough input-token budget.
// We use estimateTokens (chars/4) for a conservative approximation and reserve ~600 tokens for prompt overhead.
function trimChunksToBudget(
  chunks: ContextChunk[],
  budget: number,
  reserve = 600
): ContextChunk[] {
  const max = Math.max(300, budget - reserve);
  const out: ContextChunk[] = [];
  let used = 0;

  for (const c of chunks) {
    const t = estimateTokens(c.text);
    if (used + t > max) break;
    out.push(c);
    used += t;
  }

  // If everything exceeded budget (rare), keep the first chunk only
  if (out.length === 0 && chunks.length > 0) {
    out.push(chunks[0]);
  }
  return out;
}

// Shrink long chunks to reduce prompt token cost.
// This is a simple hard cap; consider smarter clipping at sentence boundaries if needed.
function shrinkChunkText(text: string, maxChars: number): string {
  if (!text || text.length <= maxChars) return text;
  // Keep start and end to retain some context around citations
  const head = Math.floor(maxChars * 0.7);
  const tail = maxChars - head;
  return `${text.slice(0, head)}\n…\n${text.slice(-tail)}`;
}

// Trim a list of chunks to fit a rough input token budget.
// 'reserve' accounts for system/user prompt overhead and citations format.
// function trimChunksToBudget(
//   chunks: ContextChunk[],
//   budgetTokens: number,
//   reserveTokens = 800
// ): ContextChunk[] {
//   const max = Math.max(300, budgetTokens - reserveTokens);
//   const out: ContextChunk[] = [];
//   let used = 0;

//   for (const c of chunks) {
//     const t = estimateTokens(c.text);
//     if (used + t > max) break;
//     out.push(c);
//     used += t;
//   }
//   if (out.length === 0 && chunks.length > 0) out.push(chunks[0]); // never empty
//   return out;
// }

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

function isNonEmptyString(x: unknown): x is string {
  return typeof x === "string" && x.length > 0;
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

// Decide whether to prefer Firecrawl ('jina') or raw for a given URL.
// Tunable via:
//  - READER_PREFER: "firecrawl" (default) or "raw"
//  - READER_RAW_DOMAINS: CSV of hosts (or parent domains) to force raw on
function chooseReaderPrefer(u: string): "jina" | "raw" {
  const pref = (process.env.READER_PREFER ?? "firecrawl").toLowerCase();
  const defaultPrefer: "jina" | "raw" = pref === "raw" ? "raw" : "jina";
  let host = "";
  try {
    host = new URL(u).hostname.toLowerCase();
  } catch {
    // ignore
  }
  const rawCsv = process.env.READER_RAW_DOMAINS ?? "";
  const userHosts = rawCsv
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);

  const shouldRaw = (h: string) =>
    userHosts.some((d) => h === d || h.endsWith("." + d)) ||
    BUILTIN_RAW_DOMAINS.some((d) => h === d || h.endsWith("." + d));

  if (host && shouldRaw(host)) return "raw";
  return defaultPrefer;
}

// Some static/clean sites that work well with raw fetch
const BUILTIN_RAW_DOMAINS = [
  "wikipedia.org",
  "pmc.ncbi.nlm.nih.gov",
  "nih.gov",
  "who.int",
  "europa.eu",
  "reddit.com", // Handles Firecrawl blocks
];