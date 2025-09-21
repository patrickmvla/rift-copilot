/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import {
  ResearchRequest,
  ResearchRequestSchema,
  type DoneEvent,
  type ErrorEvent,
  type ProgressEvent,
  type SourceRef,
  type VerifyClaimsResponse,
} from "@/features/research/types";
import { createSSEDecoder, type DecodedSSE } from "@/lib/sse";
import { useResearchStore } from "./store";

export type ResearchSSEMessage =
  | { event: "progress"; data: ProgressEvent }
  | { event: "token"; data: string }
  | { event: "sources"; data: SourceRef[] }
  | { event: "claims"; data: VerifyClaimsResponse }
  | { event: "done"; data: DoneEvent }
  | { event: "error"; data: ErrorEvent };

// Stream options
export type StreamOptions = {
  endpoint?: string; // default '/api/research'
  headers?: HeadersInit; // extra headers
  abortSignal?: AbortSignal; // external abort
  connectTimeoutMs?: number; // default 45000 (time to response headers)
  idleTimeoutMs?: number; // default 60000 (abort on no events)
  onEvent?: (msg: ResearchSSEMessage) => void; // per-event callback
};

// Handle returned by streamResearch
export type StreamHandle = {
  controller: AbortController;
  done: Promise<void>;
  abort: (reason?: string) => void;
};

/**
 * Start a streaming research run (SSE) against /api/research.
 * Validates input with Zod, streams events, and invokes onEvent for each SSE block.
 */
export function streamResearch(
  request: ResearchRequest,
  opts: StreamOptions = {}
): StreamHandle {
  // Validate on client to fail fast with a helpful error
  const parsed = ResearchRequestSchema.safeParse(request);
  if (!parsed.success) {
    throw new Error("Invalid ResearchRequest: " + parsed.error.message);
  }

  const endpoint = opts.endpoint ?? "/api/research";
  // Increased default: some runs take >15s to start streaming
  const connectTimeoutMs = Math.max(1000, opts.connectTimeoutMs ?? 45_000);
  const idleTimeoutMs = Math.max(5000, opts.idleTimeoutMs ?? 60_000);

  const ac = new AbortController();
  const controller = ac;

  // Bridge external abort to our controller
  if (opts.abortSignal) {
    if (opts.abortSignal.aborted) {
      tryAbort(ac, opts.abortSignal.reason);
    } else {
      opts.abortSignal.addEventListener(
        "abort",
        () => tryAbort(ac, opts.abortSignal?.reason),
        { once: true }
      );
    }
  }

  // "connected" now means "we have response headers"
  let connected = false;
  let connectTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      tryAbort(ac, new DOMException("Idle timeout", "AbortError"));
    }, idleTimeoutMs);
  };

  const onEvent = (msg: ResearchSSEMessage) => {
    resetIdle();
    opts.onEvent?.(msg);
  };

  const done = (async () => {
    try {
      // Watchdog for time-to-response-headers
      connectTimer = setTimeout(() => {
        if (!connected) {
          tryAbort(ac, new DOMException("Connect timeout (headers)", "AbortError"));
        }
      }, connectTimeoutMs);

      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Hint to the server that we expect SSE
          Accept: "text/event-stream",
          ...(opts.headers ?? {}),
        },
        body: JSON.stringify(parsed.data),
        signal: ac.signal,
        cache: "no-store",
      });

      // We have response headers → clear connect watchdog and mark connected
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
      connected = true;

      if (!res.ok) {
        const text = await safeText(res);
        onEvent({
          event: "error",
          data: {
            message: `HTTP ${res.status} ${res.statusText || ""} ${
              text ? "- " + text.slice(0, 200) : ""
            }`.trim(),
          },
        });
        return;
      }

      const reader = res.body?.getReader?.();
      if (!reader) {
        onEvent({
          event: "error",
          data: { message: "Streaming not supported by the response body." },
        });
        return;
      }

      const dec = new TextDecoder();
      const sse = createSSEDecoder();

      // Start idle timer; it resets as events arrive
      resetIdle();

      // Read loop
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        if (value) {
          const chunk = dec.decode(value, { stream: true });
          const events = sse.push(chunk);

          for (const evt of events) {
            const msg = toResearchMessage(evt);
            if (msg) onEvent(msg);
          }
        }
      }

      // Flush any trailing block (rare)
      const tail = sse.flush?.() ?? [];
      for (const evt of tail) {
        const msg = toResearchMessage(evt);
        if (msg) onEvent(msg);
      }
    } catch (err: any) {
      if (err?.name !== "AbortError") {
        onEvent({
          event: "error",
          data: { message: String(err?.message ?? err) },
        });
      }
    } finally {
      if (connectTimer) clearTimeout(connectTimer);
      if (idleTimer) clearTimeout(idleTimer);
    }
  })();

  return {
    controller,
    done,
    abort: (reason?: string) =>
      tryAbort(ac, reason ? new DOMException(reason, "AbortError") : undefined),
  };
}

/**
 * Convenience: kick off a research run and wire events directly to the Zustand store.
 */
export function startResearchWithStore(
  req: ResearchRequest,
  opts?: Omit<StreamOptions, "onEvent">
): StreamHandle {
  const store = useResearchStore.getState();
  const ac = new AbortController();

  // Start run in store (sets initial state)
  store.start({ question: req.question, abortController: ac });

  const handle = streamResearch(req, {
    ...opts,
    abortSignal: opts?.abortSignal ?? ac.signal,
    onEvent: (msg) => {
      store.handleSSE(msg as any);
    },
  });

  return {
    controller: handle.controller,
    done: handle.done.then(() => {
      // If run finished without a 'done' event, set to done to avoid stuck UI
      const s = useResearchStore.getState();
      if (s.stage !== "done" && s.stage !== "error") {
        s.finish();
      }
    }),
    abort: handle.abort,
  };
}

/* -------------------------------- Internals -------------------------------- */

function tryAbort(ac: AbortController, reason?: any) {
  try {
    ac.abort(reason);
  } catch {
    // ignore
  }
}

function safeText(res: Response): Promise<string | null> {
  return res
    .text()
    .then((t) => t)
    .catch(() => null);
}

/**
 * Map DecodedSSE to typed ResearchSSEMessage.
 * Unknown events are ignored for forward-compat.
 */
function toResearchMessage(evt: DecodedSSE): ResearchSSEMessage | null {
  const name = (evt.event || "message").trim();

  switch (name) {
    case "progress":
      // Expect { stage, message?, meta? }
      return { event: "progress", data: (evt.data ?? {}) as ProgressEvent };
    case "token":
      return { event: "token", data: String(evt.data ?? "") };
    case "sources":
      return { event: "sources", data: (evt.data ?? []) as SourceRef[] };
    case "claims":
      return {
        event: "claims",
        data: (evt.data ?? { claims: [] }) as VerifyClaimsResponse,
      };
    case "done":
      return { event: "done", data: (evt.data ?? {}) as DoneEvent };
    case "error":
      return {
        event: "error",
        data: (evt.data ?? { message: "Unknown error" }) as ErrorEvent,
      };
    default:
      return null;
  }
}