/* eslint-disable @typescript-eslint/no-explicit-any */
import { client } from "@/db";
import { env } from "@/lib/env";
import { logger, startSpan, logError } from "@/lib/logger";
import { VoyageAIClient, VoyageAIError } from "voyageai";

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
    (opts.enableRerank ?? env.ENABLE_RERANK) && !!process.env.VOYAGE_API_KEY;

  let perQueryRanked: RankedChunk[][];
  if (useRerank) {
    perQueryRanked = await Promise.all(
      perQueryCandidates.map((cands, i) =>
        voyageRerank(queries[i], cands, Math.min(cap, perQueryTake), {
          timeoutMs: opts.timeoutMs ?? env.REQUEST_TIMEOUT_MS,
        }).catch((e) => {
          logError(log, e, "voyage rerank failed, fallback BM25", {
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
    rerank: useRerank,
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
  // Back-compat wrapper: uses Voyage SDK under the hood
  return voyageRerank(query, candidates, topK, opts);
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

/* ------------------------------ Voyage SDK --------------------------------- */

let voyageClient: VoyageAIClient | null = null;
function getVoyage(): VoyageAIClient | null {
  if (voyageClient) return voyageClient;
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) return null;
  voyageClient = new VoyageAIClient({ apiKey });
  return voyageClient;
}

async function voyageRerank(
  query: string,
  candidates: RankedChunk[],
  topK: number,
  opts?: { timeoutMs?: number }
): Promise<RankedChunk[]> {
  const client = getVoyage();
  if (!client) {
    // missing key → fallback to BM25
    return candidates.slice(0, topK).sort((a, b) => b.score - a.score);
  }

  const top = Math.min(topK, candidates.length);
  if (top === 0) return [];

  const model = process.env.VOYAGE_RERANK_MODEL || "rerank-2.5-lite";
  const docs = candidates.map((c) => c.text).slice(0, 1000); // Voyage limit

  try {
    const resp = await client.rerank(
      {
        model,
        query,
        documents: docs,
        top_k: Math.max(1, Math.min(top, docs.length)),
        return_documents: false,
        truncation: true, // per docs default
      } as any,
      {
        timeoutInSeconds: Math.max(
          1,
          Math.floor((opts?.timeoutMs ?? env.REQUEST_TIMEOUT_MS) / 1000)
        ),
        // You can add abortSignal here if you thread it through opts
      }
    );

    const results: Array<{ index: number; relevance_score: number }> =
      Array.isArray((resp as any)?.data) ? (resp as any).data : [];

    if (results.length === 0) {
      return candidates.slice(0, top).sort((a, b) => b.score - a.score);
    }

    const scored = new Map<number, number>();
    for (const r of results) {
      if (typeof r.index === "number") {
        scored.set(r.index, clamp01(Number(r.relevance_score ?? 0)));
      }
    }

    const withScores = candidates.map((c, i) => ({
      ...c,
      score: scored.get(i) ?? c.score,
    }));

    return withScores.sort((a, b) => b.score - a.score).slice(0, top);
  } catch (e) {
    if (e instanceof VoyageAIError) {
      // Log structured Voyage error details
      logger.error(
        {
          mod: "rank",
          err: { status: e.statusCode, message: e.message, body: e.body },
        },
        "Voyage rerank error"
      );
    } else {
      logError(logger, e, "Voyage rerank error");
    }
    return candidates.slice(0, top).sort((a, b) => b.score - a.score);
  }
}

/* --------------------------------- Timing ---------------------------------- */

// function timeoutSignal(timeoutMs: number) {
//   const ac = new AbortController();
//   const t = setTimeout(
//     () => ac.abort(new DOMException("Timeout", "TimeoutError")),
//     timeoutMs
//   );
//   return { signal: ac.signal, cancel: () => clearTimeout(t) };
// }

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
