/* eslint-disable @typescript-eslint/no-explicit-any */
import "server-only";
import { NextRequest } from "next/server";
import { z } from "zod";
import { eq, asc } from "drizzle-orm";
import { loggerWithRequest, logError } from "@/lib/logger";
import { db } from "@/db";
import { sources, sourceContent, chunks } from "@/db/schema";

export const runtime = "nodejs";

const ParamsSchema = z.object({
  id: z.string().min(1, "id is required"),
});

const QuerySchema = z.object({
  include: z
    .string()
    .optional()
    .transform(
      (v) =>
        new Set(
          (v ?? "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        )
    ),
  chunkLimit: z
    .string()
    .optional()
    .transform((v) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.min(50, Math.max(1, Math.trunc(n))) : 8;
    }),
  snippetChars: z
    .string()
    .optional()
    .transform((v) => {
      const n = Number(v);
      return Number.isFinite(n)
        ? Math.min(8000, Math.max(100, Math.trunc(n)))
        : 600;
    }),
  fullContent: z
    .string()
    .optional()
    .transform((v) => {
      const s = (v ?? "").toLowerCase();
      return s === "1" || s === "true" || s === "yes";
    }),
});

export async function GET(req: NextRequest, ctx: { params: { id: string } }) {
  const log = loggerWithRequest({
    headers: req.headers,
    method: req.method,
    url: req.url,
  });

  // Validate route params
  const p = ParamsSchema.safeParse(ctx.params);
  if (!p.success) {
    return jsonError(400, "Invalid id", p.error.flatten());
  }
  const sourceId = p.data.id;

  // Parse query
  const url = new URL(req.url);
  const q = QuerySchema.safeParse({
    include: url.searchParams.get("include") ?? undefined, // 'content,chunks'
    chunkLimit: url.searchParams.get("chunkLimit") ?? undefined, // default 8
    snippetChars: url.searchParams.get("snippetChars") ?? undefined,
    fullContent: url.searchParams.get("fullContent") ?? undefined,
  });
  if (!q.success) {
    return jsonError(400, "Invalid query params", q.error.flatten());
  }
  const include = q.data.include ?? new Set<string>();
  const wantContent = include.has("content");
  const wantChunks = include.has("chunks");
  const chunkLimit = q.data.chunkLimit!;
  const snippetChars = q.data.snippetChars!;
  const fullContent = q.data.fullContent ?? false;

  try {
    // Load source metadata
    const rows = await db
      .select()
      .from(sources)
      .where(eq(sources.id, sourceId))
      .limit(1);

    if (rows.length === 0) {
      return jsonError(404, "Source not found");
    }
    const s = rows[0];

    // Shape base response
    const resp: any = {
      source: {
        id: s.id,
        url: s.url,
        domain: s.domain,
        title: s.title,
        publishedAt: s.publishedAt,
        crawledAt: s.crawledAt,
        lang: s.lang,
        wordCount: s.wordCount,
        status: s.status,
        httpStatus: s.httpStatus,
        createdAt: s.createdAt,
      },
    };

    // Optionally include content (snippet or full)
    if (wantContent) {
      const cRows = await db
        .select({ text: sourceContent.text, html: sourceContent.html })
        .from(sourceContent)
        .where(eq(sourceContent.sourceId, sourceId))
        .limit(1);

      const c = cRows[0];
      if (c) {
        resp.content = {
          hasContent: true,
          text: fullContent ? c.text : makeSnippet(c.text, snippetChars),
          snippet: fullContent ? undefined : makeSnippet(c.text, snippetChars),
          html: null as string | null, // omit raw HTML by default to keep payload small
        };
      } else {
        resp.content = { hasContent: false };
      }
    }

    // Optionally include chunk previews
    if (wantChunks) {
      const ck = await db
        .select({
          id: chunks.id,
          pos: chunks.pos,
          charStart: chunks.charStart,
          charEnd: chunks.charEnd,
          text: chunks.text,
          tokens: chunks.tokens,
        })
        .from(chunks)
        .where(eq(chunks.sourceId, sourceId))
        .orderBy(asc(chunks.pos))
        .limit(chunkLimit);

      resp.chunks = ck.map((r) => ({
        id: r.id,
        pos: r.pos,
        charStart: r.charStart,
        charEnd: r.charEnd,
        tokens: r.tokens,
        preview: makeSnippet(
          r.text,
          Math.max(200, Math.min(1200, snippetChars))
        ),
      }));
    }

    return new Response(JSON.stringify(resp), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    logError(log, e, "Failed to load source");
    return jsonError(500, "Failed to load source");
  }
}

/* -------------------------------- Helpers --------------------------------- */

function makeSnippet(text: string, maxChars: number): string {
  if (!text) return "";
  if (text.length <= maxChars) return text;
  // Try to cut on a sentence boundary near maxChars
  const slice = text.slice(0, maxChars + 200);
  const re = /[.!?][)"'```]?(?:\s|\n|$)/g;
  let cut = maxChars;
  let m: RegExpExecArray | null;
  while ((m = re.exec(slice))) {
    if (m.index + m[0].length <= maxChars) cut = m.index + m[0].length;
  }
  const out = slice.slice(0, cut).trimEnd();
  return out + " …";
}

function jsonError(status: number, message: string, details?: unknown) {
  return new Response(JSON.stringify({ error: message, details }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
