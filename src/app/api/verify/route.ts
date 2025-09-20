/* eslint-disable @typescript-eslint/no-explicit-any */
import "server-only";
import { NextRequest } from "next/server";
import { z } from "zod";
import { loggerWithRequest, logError } from "@/lib/logger";
import { db } from "@/db";
import { chunks } from "@/db/schema";
import { eq } from "drizzle-orm";
import { VerifyClaimsResponse } from "@/features/research/types";
import { verifyClaims } from "@/features/research/server/verify";

export const runtime = "nodejs";

/* --------------------------------- Schema --------------------------------- */

const GroqOptionsSchema = z
  .object({
    reasoningFormat: z.enum(["parsed", "raw", "hidden"]).optional(),
    reasoningEffort: z
      .enum(["low", "medium", "high", "none", "default"])
      .optional(),
    structuredOutputs: z.boolean().optional(),
    parallelToolCalls: z.boolean().optional(),
    user: z.string().optional(),
    serviceTier: z.enum(["on_demand", "flex", "auto"]).optional(),
  })
  .optional();

const SnippetSchema = z.object({
  sourceId: z.string(),
  chunkId: z.string().optional(),
  text: z.string(),
});

const BodySchema = z.object({
  answerMarkdown: z.string().min(1, "answerMarkdown is required"),
  snippets: z.array(SnippetSchema).min(1, "Provide at least one snippet"),
  maxClaims: z.number().int().min(1).max(50).optional(),
  bindOffsets: z.boolean().optional().default(true),
  nliContradictionCheck: z.boolean().optional().default(false),
  groqOptions: GroqOptionsSchema,
});

/* --------------------------------- Route ---------------------------------- */

export async function POST(req: NextRequest) {
  const log = loggerWithRequest({
    headers: req.headers,
    method: req.method,
    url: req.url,
  });

  // Parse and validate body
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

  try {
    // Optional loader for chunk text (for binding char offsets)
    const loader =
      body.bindOffsets === false
        ? undefined
        : async (chunkId: string): Promise<string | null> => {
            try {
              const row = await db
                .select({ text: chunks.text })
                .from(chunks)
                .where(eq(chunks.id, chunkId))
                .limit(1);
              return row[0]?.text ?? null;
            } catch {
              return null;
            }
          };

    const result: VerifyClaimsResponse = await verifyClaims(
      {
        answerMarkdown: body.answerMarkdown,
        snippets: body.snippets,
      },
      {
        maxClaims: body.maxClaims ?? 12,
        abortSignal: req.signal,
        groqOptions: body.groqOptions,
        bindOffsets: body.bindOffsets,
        chunkTextById: loader,
        nliContradictionCheck: body.nliContradictionCheck,
      }
    );

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    if (isAbortError(e)) {
      // Client disconnected
      return new Response(null, { status: 499 }); // Client Closed Request (non-standard)
    }
    logError(log, e, "Verify failed");
    return jsonError(500, "Verify failed");
  }
}

/* -------------------------------- Helpers --------------------------------- */

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
