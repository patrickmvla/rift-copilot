/* eslint-disable @typescript-eslint/no-explicit-any */
import { client } from "@/db";
import { env } from "@/lib/env";
import { logger, startSpan, logError } from "@/lib/logger";

export type RankedChunk = {
  id: string;
  sourceId: string;
  text: string;
  score: number;
  bm25?: number;
  snippet?: string | null;
};

export type RankOptions = {
  cap?: number;
  perQueryTake?: number;
  diversifyBySource?: boolean;
  perSourceLimit?: number;
  enableRerank?: boolean;
  timeoutMs?: number;
};

export async function rankForQueries(
  queries: string[],
  opts: RankOptions = {}
): Promise<RankedChunk[]> {
  const log = logger.child({ mod: "rank" });
  const span = startSpan(log, "rankForQueries");

  if (!queries || queries.length === 0) return [];

  const cap = Math.max(1, Math.min(200, opts.cap ?? 24));
  const diversify = opts.diversifyBySource ?? true;
  const perSourceLimit = Math.max(1, Math.min(8, opts.perSourceLimit ?? 3));
  const perQueryTakeBase = Math.max(
    4,
    Math.ceil(cap / Math.max(1, queries.length)) * 3
  );
  const perQueryTake = Math.min(200, opts.perQueryTake ?? perQueryTakeBase);

  const perQueryCandidates = await Promise.all(
    queries.map((q) =>
      bm25Search(q, perQueryTake).catch((e) => {
        logError(log, e, "bm25Search failed", { query: q });
        return [] as RankedChunk[];
      })
    )
  );

  const useRerank =
    (opts.enableRerank ?? env.ENABLE_RERANK) && !!env.JINA_API_KEY;
  let perQueryRanked: RankedChunk[][];

  if (useRerank) {
    perQueryRanked = await Promise.all(
      perQueryCandidates.map((cands, i) =>
        rerankCandidates(queries[i], cands, Math.min(cap, perQueryTake), {
          timeoutMs: opts.timeoutMs ?? env.REQUEST_TIMEOUT_MS,
        }).catch((e) => {
          logError(log, e, "rerankCandidates failed, fallback BM25", {
            query: queries[i],
          });
          return cands
            .sort((a, b) => b.score - a.score)
            .slice(0, Math.min(cap, cands.length));
        })
      )
    );
  } else {
    perQueryRanked = perQueryCandidates.map((cands) =>
      cands
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.min(cap, cands.length))
    );
  }

  const best = new Map<string, RankedChunk>();
  for (const list of perQueryRanked) {
    for (const item of list) {
      const prev = best.get(item.id);
      if (!prev || item.score > prev.score) best.set(item.id, item);
    }
  }

  const merged = Array.from(best.values()).sort((a, b) => b.score - a.score);
  const final = diversify
    ? diversifyBySource(merged, cap, perSourceLimit)
    : merged.slice(0, cap);

  span.end({
    queries: queries.length,
    candidates: perQueryCandidates.flat().length,
    final: final.length,
  });
  return final;
}

export async function bm25Search(
  query: string,
  limit = 24
): Promise<RankedChunk[]> {
  if (!query || !query.trim()) return [];
  const q = toFtsMatchQuery(query);
  const opLog = logger.child({ mod: "rank", op: "bm25" });

  try {
    const res = await client.execute({
      sql: `
        SELECT
          c.id AS id,
          c.source_id AS sourceId,
          c.text AS text,
          bm25(chunks_fts) AS bm25,
          snippet(chunks_fts, 0, '[[' , ']]', ' … ', 8) AS snippet
        FROM chunks_fts
        JOIN chunks c ON c.rowid = chunks_fts.rowid
        WHERE chunks_fts MATCH ?
        LIMIT ?;
      `,
      args: [q, limit],
    });
    const rows = Array.isArray(res.rows) ? (res.rows as any[]) : [];
    return rows.map(normalizeBm25Row);
  } catch (e) {
    logError(opLog, e, "snippet() failed, retrying without snippet");
    const res = await client.execute({
      sql: `
        SELECT
          c.id AS id,
          c.source_id AS sourceId,
          c.text AS text,
          bm25(chunks_fts) AS bm25
        FROM chunks_fts
        JOIN chunks c ON c.rowid = chunks_fts.rowid
        WHERE chunks_fts MATCH ?
        LIMIT ?;
      `,
      args: [q, limit],
    });
    const rows = Array.isArray(res.rows) ? (res.rows as any[]) : [];
    return rows.map(normalizeBm25Row);
  }
}

export async function rerankCandidates(
  query: string,
  candidates: RankedChunk[],
  topK: number,
  opts?: { timeoutMs?: number }
): Promise<RankedChunk[]> {
  const top = Math.min(topK, candidates.length);
  if (top === 0) return [];

  const res = await jinaRerank(
    query,
    candidates.map((c) => c.text),
    top,
    opts
  );
  const scored = new Map<number, number>();
  for (const r of res) {
    const idx = r.index ?? r.document_index ?? r.idx ?? r.docid ?? r.docIndex;
    const rawScore = r.relevance_score ?? r.score ?? r.relevance ?? 0;
    if (typeof idx === "number") scored.set(idx, clamp01(Number(rawScore)));
  }

  if (scored.size === 0) {
    return candidates.slice(0, top).sort((a, b) => b.score - a.score);
  }

  const withScores = candidates
    .slice(0, Math.max(top, candidates.length))
    .map((c, i) => ({
      ...c,
      score: scored.get(i) ?? c.score,
    }));

  return withScores.sort((a, b) => b.score - a.score).slice(0, top);
}

function normalizeBm25Row(r: any): RankedChunk {
  const bm = typeof r.bm25 === "number" ? r.bm25 : Number(r.bm25 ?? 0);
  const score = bm > 0 ? 1 / (1 + bm) : 0.5;
  return {
    id: String(r.id),
    sourceId: String(r.sourceId),
    text: String(r.text ?? ""),
    bm25: bm,
    score,
    snippet: typeof r.snippet === "string" ? r.snippet : undefined,
  };
}

export function toFtsMatchQuery(input: string): string {
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

export function diversifyBySource(
  hits: RankedChunk[],
  cap: number,
  perSourceLimit: number
): RankedChunk[] {
  const out: RankedChunk[] = [];
  const seenPerSource = new Map<string, number>();

  for (const h of hits) {
    const n = seenPerSource.get(h.sourceId) ?? 0;
    if (n >= perSourceLimit) continue;
    out.push(h);
    seenPerSource.set(h.sourceId, n + 1);
    if (out.length >= cap) break;
  }

  if (out.length < cap) {
    for (const h of hits) {
      if (out.length >= cap) break;
      if (!out.find((x) => x.id === h.id)) out.push(h);
    }
  }

  return out.slice(0, cap);
}

/* ------------------------------ Jina Reranker ------------------------------ */

async function getFetch(): Promise<typeof fetch> {
  if (typeof fetch !== "undefined") return fetch;

  const mod = (await import("node-fetch")) as any;
  return (mod.default ?? mod) as typeof fetch;
}

async function jinaRerank(
  query: string,
  documents: string[],
  topN: number,
  opts?: { timeoutMs?: number }
): Promise<
  Array<{
    index?: number;
    document_index?: number;
    idx?: number;
    docid?: number;
    docIndex?: number;
    relevance_score?: number;
    score?: number;
    relevance?: number;
  }>
> {
  if (!env.JINA_API_KEY) return [];
  const base = env.JINA_SEARCH_BASE || "https://api.jina.ai";
  const url = `${base.replace(/\/+$/, "")}/v1/rerank`;
  const { signal, cancel } = timeoutSignal(
    opts?.timeoutMs ?? env.REQUEST_TIMEOUT_MS
  );
  const f = await getFetch();

  try {
    const res = await f(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.JINA_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "jina-reranker-v2-base-multilingual",
        query,
        top_n: Math.max(1, Math.min(topN, documents.length)),
        documents,
        return_documents: false, // per docs
      }),
      signal,
    });

    if (!res.ok) {
      throw new Error(`Jina rerank HTTP ${res.status}`);
    }

    const data = (await res.json()) as any;
    return (data?.results ?? data?.data ?? data ?? []) as any[];
  } finally {
    cancel();
  }
}

/* --------------------------------- Timing ---------------------------------- */

function timeoutSignal(timeoutMs: number) {
  const ac = new AbortController();
  const t = setTimeout(
    () => ac.abort(new DOMException("Timeout", "TimeoutError")),
    timeoutMs
  );
  return { signal: ac.signal, cancel: () => clearTimeout(t) };
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
