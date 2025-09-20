/* eslint-disable @typescript-eslint/no-explicit-any */
import "server-only";
import { NextRequest } from "next/server";
import { createSSEStream, sseResponse } from "@/lib/sse";
import { loggerWithRequest, logError } from "@/lib/logger";
import {
  ResearchRequestSchema,
  type ResearchRequest,
} from "@/features/research/types";
import { deepResearch } from "@/features/research/server/deepresearch";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const log = loggerWithRequest({
    headers: req.headers,
    method: req.method,
    url: req.url,
  });

  // Parse JSON body
  let payload: ResearchRequest;
  try {
    const body = await req.json();
    const parsed = ResearchRequestSchema.safeParse(body);
    if (!parsed.success) {
      return new Response(
        JSON.stringify({
          error: "Invalid ResearchRequest",
          details: parsed.error.flatten(),
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }
    payload = parsed.data;
  } catch (e: any) {
    logError(log, e, "Invalid JSON body");
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // SSE stream + orchestration
  const sse = createSSEStream({
    heartbeatMs: 20_000,
    signal: req.signal, // close if client disconnects
  });

  const ac = new AbortController();
  const onReqAbort = () =>
    ac.abort(req.signal.reason ?? new DOMException("Aborted", "AbortError"));
  if (req.signal.aborted) onReqAbort();
  else req.signal.addEventListener("abort", onReqAbort, { once: true });

  const emit = (evt: { event: string; data: any }) => {
    try {
      sse.send(evt.data, { event: evt.event });
    } catch {
      // Ignore send errors if stream already closed
    }
  };

  const run = async () => {
    try {
      await deepResearch(payload, {
        signal: ac.signal,
        emit: (e) => {
          // forward events to SSE
          switch (e.event) {
            case "progress":
            case "token":
            case "sources":
            case "claims":
            case "done":
            case "error":
              emit(e as any);
              break;
            default:
              // unknown/future event types
              emit({
                event: "progress",
                data: { stage: "read", message: "..." },
              });
          }
        },
      });
      // deepResearch emits 'done'. Close stream if still open.
      sse.close();
    } catch (err: any) {
      if (isAbort(err)) {
        // Silent on abort; stream will be closed by signal
      } else {
        logError(log, err, "deepResearch failed");
        emit({
          event: "error",
          data: { message: String(err?.message ?? "Internal error") },
        });
        sse.close(err);
      }
    }
  };

  return sseResponse(sse.stream, run);
}

/* --------------------------------- Helpers -------------------------------- */

function isAbort(err: unknown) {
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
