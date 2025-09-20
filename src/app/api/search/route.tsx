/* eslint-disable @typescript-eslint/no-explicit-any */
import "server-only";
import { NextRequest } from "next/server";
import { z } from "zod";
import { loggerWithRequest, logError } from "@/lib/logger";
import { deepsearch } from "@/features/research/server/deepsearch";
import { SearchResultSchema } from "@/features/research/types";
import { db } from "@/db";
import { searchEvents } from "@/db/schema";
import { id as newId } from "@/lib/id";

export const runtime = "nodejs";

const SearchBodySchema = z.object({
  query: z.string().min(2, "Query must be at least 2 chars"),
  size: z.number().int().min(1).max(50).optional(),
  timeRange: z
    .object({
      from: z.string().optional(),
      to: z.string().optional(),
    })
    .optional(),
  region: z.string().optional(),
  allowedDomains: z.array(z.string()).optional(),
  disallowedDomains: z.array(z.string()).optional(),
  // Optional: associate this search with a thread for analytics/audit
  threadId: z.string().optional(),
});

export async function POST(req: NextRequest) {
  const log = loggerWithRequest({
    headers: req.headers,
    method: req.method,
    url: req.url,
  });

  let body: z.infer<typeof SearchBodySchema>;
  try {
    const json = await req.json();
    const parsed = SearchBodySchema.safeParse(json);
    if (!parsed.success) {
      return jsonError(400, "Invalid request", parsed.error.flatten());
    }
    body = parsed.data;
  } catch (e: any) {
    logError(log, e, "Invalid JSON body");
    return jsonError(400, "Invalid JSON body");
  }

  try {
    const results = await deepsearch(body.query, {
      size: body.size,
      timeRange: body.timeRange,
      allowedDomains: body.allowedDomains,
      disallowedDomains: body.disallowedDomains,
      region: body.region,
      abortSignal: req.signal,
    });

    // Validate/normalize results shape (defensive)
    const validated = z.array(SearchResultSchema).safeParse(results).success
      ? results
      : [];

    // Optional: persist the search event if threadId is provided
    if (body.threadId) {
      try {
        await db
          .insert(searchEvents)
          .values({
            id: newId(),
            threadId: body.threadId,
            query: body.query,
            resultsJson: JSON.stringify(validated),
          })
          .run();
      } catch (e) {
        // Non-fatal; log and continue
        logError(log, e, "Failed to persist search event");
      }
    }

    return new Response(JSON.stringify(validated), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  } catch (e: any) {
    if (isAbortError(e)) {
      // Client disconnected; return early
      return new Response(null, { status: 499 }); // Client Closed Request (non-standard)
    }
    logError(log, e, "Search failed");
    return jsonError(500, "Search failed");
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
