/**
 * Server-Sent Events (SSE) utilities
 * - createSSEStream: build a robust SSE stream with heartbeats and safe JSON event formatting
 * - sseResponse: wrap a ReadableStream into a proper SSE Response
 * - createSSEDecoder: client-side incremental parser for streaming chunks
 *
 * Notes:
 * - Use in Next.js Route Handlers with runtime 'nodejs'
 * - Keep event payloads small when possible; send multiple events for large data
 * - Heartbeats prevent proxies from killing idle connections
 */

export type SSESendOptions = {
  id?: string;         // Event ID for reconnection
  retry?: number;      // Reconnect delay hint (ms)
  event?: string;      // Event name; default 'message' if omitted
  raw?: boolean;       // If true, data is sent as-is (string) without JSON.stringify
};

export type SSECreateOptions = {
  heartbeatMs?: number;    // Heartbeat interval (ms); default 20_000
  initialRetryMs?: number; // Initial retry suggestion sent once at start
  signal?: AbortSignal;    // Optional abort controller to cancel stream
  onClose?: (reason?: unknown) => void; // Callback when stream closes/cancels
};

export type SSEWriter = {
  /**
   * Send an SSE event. Data is JSON.stringified by default unless raw is true.
   * - event defaults to 'message' per SSE spec when omitted.
   */
  send: (data: unknown, opts?: SSESendOptions) => boolean;
  /**
   * Send a one-line comment (begins with ':'). Useful for pings/diagnostics.
   */
  comment: (msg: string) => boolean;
  /**
   * Send a heartbeat comment “: ping <ts>”.
   */
  ping: () => boolean;
  /**
   * Close the stream gracefully.
   */
  close: (reason?: unknown) => void;
  /**
   * The readable byte stream to return in a Response.
   */
  stream: ReadableStream<Uint8Array>;
};

const encoder = new TextEncoder();

export const SSE_HEADERS: HeadersInit = Object.freeze({
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  // Helps disable proxy buffering (e.g., Nginx)
  'X-Accel-Buffering': 'no',
});

/**
 * Creates a new SSE stream writer with heartbeats and safe cleanup.
 * Example:
 *   const sse = createSSEStream();
 *   return sseResponse(sse.stream, async () => {
 *     sse.send({ stage: 'start' }, { event: 'progress' });
 *     ...
 *   });
 */
export function createSSEStream(opts: SSECreateOptions = {}): SSEWriter {
  const heartbeatMs = opts.heartbeatMs ?? 20_000;
  const initialRetryMs = opts.initialRetryMs;

  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let closed = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  const writeChunk = (str: string): boolean => {
    if (closed || !controller) return false;
    controller.enqueue(encoder.encode(str));
    return true;
  };

  const formatEvent = (data: unknown, options?: SSESendOptions): string => {
    const lines: string[] = [];
    const { id, retry, event, raw } = options ?? {};

    if (typeof id === 'string' && id.length) {
      lines.push(`id: ${sanitizeLine(id)}`);
    }
    if (typeof retry === 'number' && Number.isFinite(retry) && retry >= 0) {
      lines.push(`retry: ${Math.floor(retry)}`);
    }
    if (typeof event === 'string' && event.length) {
      lines.push(`event: ${sanitizeLine(event)}`);
    }

    // Spec: data may be multiple lines; each line is prefixed with "data: "
    let payload: string;
    if (raw && typeof data === 'string') {
      payload = data;
    } else if (data === undefined) {
      payload = '';
    } else {
      try {
        payload = JSON.stringify(data);
      } catch {
        // Fallback to string
        payload = String(data);
      }
    }

    if (payload.length) {
      for (const ln of payload.split(/\r?\n/)) {
        lines.push(`data: ${ln}`);
      }
    } else {
      // Send an empty data line for explicit empty payloads
      lines.push('data:');
    }

    // Events are separated by a blank line
    lines.push('');
    return lines.join('\n');
  };

  const send = (data: unknown, options?: SSESendOptions): boolean => {
    return writeChunk(formatEvent(data, options));
  };

  const comment = (msg: string): boolean => {
    // Comment lines begin with ":" and are ignored by event listeners
    return writeChunk(`: ${collapseNewlines(msg)}\n\n`);
  };

  const ping = (): boolean => {
    return comment(`ping ${Date.now()}`);
  };

  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      controller = ctrl;

      // Send initial retry suggestion once (helps clients tune reconnect)
      if (typeof initialRetryMs === 'number' && Number.isFinite(initialRetryMs)) {
        writeChunk(`retry: ${Math.floor(initialRetryMs)}\n\n`);
      }

      // Heartbeat to keep proxies/connections alive
      if (heartbeatMs > 0 && Number.isFinite(heartbeatMs)) {
        heartbeatTimer = setInterval(() => {
          if (!closed) ping();
        }, heartbeatMs);
      }

      // Hook abort signal
      if (opts.signal) {
        const onAbort = () => {
          close(opts.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
        };
        if (opts.signal.aborted) onAbort();
        else opts.signal.addEventListener('abort', onAbort, { once: true });
      }
    },
    cancel(reason) {
      close(reason);
    },
  });

  const close = (reason?: unknown) => {
    if (closed) return;
    closed = true;
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    try {
      controller?.close();
    } catch {
      // ignore
    } finally {
      controller = null;
      opts.onClose?.(reason);
    }
  };

  return { send, comment, ping, close, stream };
}

/**
 * Wraps a ReadableStream into an SSE Response with correct headers.
 * You can optionally run an async initializer to start sending events.
 *
 * Example:
 *   const sse = createSSEStream();
 *   const res = sseResponse(sse.stream, async () => {
 *     sse.send({ stage: 'search' }, { event: 'progress' });
 *   });
 *   return res;
 */
export function sseResponse(
  stream: ReadableStream<Uint8Array>,
  initOrInitFn?: ResponseInit | (() => void | Promise<void>)
): Response {
  const init: ResponseInit =
    typeof initOrInitFn === 'object'
      ? { headers: { ...SSE_HEADERS, ...(initOrInitFn.headers ?? {}) }, status: initOrInitFn.status, statusText: initOrInitFn.statusText }
      : { headers: SSE_HEADERS };

  // Fire optional initializer (non-blocking if it returns void)
  if (typeof initOrInitFn === 'function') {
    Promise.resolve().then(initOrInitFn).catch(() => {
      // Swallow init errors; stream should independently handle send/close
    });
  }

  return new Response(stream, init);
}

/* --------------------------- Client-side decoder --------------------------- */

export type DecodedSSE = {
  event: string;         // Event name, 'message' if omitted by sender
  data: unknown;         // JSON-parsed if possible, else string
  id?: string;           // Optional last-event-id
  retry?: number;        // Optional retry hint (ms)
  comment?: string;      // If this was a comment-only block
};

/**
 * Incremental SSE parser for client usage; robust to chunk boundaries.
 *
 * Example:
 *   const dec = createSSEDecoder();
 *   const reader = res.body!.getReader();
 *   const td = new TextDecoder();
 *   while (true) {
 *     const { value, done } = await reader.read();
 *     if (done) break;
 *     for (const evt of dec.push(td.decode(value, { stream: true }))) {
 *       if (evt.event === 'token') handleToken(evt.data);
 *     }
 *   }
 */
export function createSSEDecoder() {
  let buffer = '';

  const push = (chunk: string): DecodedSSE[] => {
    if (!chunk) return [];
    buffer += chunk;
    // Normalize newlines for consistent parsing
    buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    const events: DecodedSSE[] = [];
    let idx: number;

    // Process complete blocks separated by double newlines
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);

      if (!block.trim()) continue;

      const lines = block.split('\n');
      let eventName: string | undefined;
      let id: string | undefined;
      let retry: number | undefined;
      const dataLines: string[] = [];
      let commentText: string | undefined;

      for (const rawLine of lines) {
        if (!rawLine.length) continue;
        if (rawLine.startsWith(':')) {
          // Comment line
          const c = rawLine.slice(1).trimStart();
          commentText = commentText ? `${commentText}\n${c}` : c;
          continue;
        }
        const sep = rawLine.indexOf(':');
        const field = sep === -1 ? rawLine : rawLine.slice(0, sep);
        const value = sep === -1 ? '' : rawLine.slice(sep + 1).replace(/^ /, ''); // trim single leading space

        switch (field) {
          case 'event':
            eventName = value;
            break;
          case 'data':
            dataLines.push(value);
            break;
          case 'id':
            id = value;
            break;
          case 'retry': {
            const n = Number.parseInt(value, 10);
            if (Number.isFinite(n)) retry = n;
            break;
          }
          default:
            // Ignore unknown fields per spec
            break;
        }
      }

      const joined = dataLines.join('\n');
      const parsed =
        joined.length
          ? tryParseJSON(joined)
          : undefined;

      events.push({
        event: eventName || 'message',
        data: parsed,
        id,
        retry,
        comment: commentText,
      });
    }

    return events;
  };

  // Flush any remaining buffered block (if it's ended with final \n\n already fed)
  const flush = (): DecodedSSE[] => {
    const residual = buffer;
    buffer = '';
    if (!residual.trim()) return [];
    // Best-effort: process as full block
    return push('\n\n');
  };

  return { push, flush };
}

/* --------------------------------- Utils --------------------------------- */

function sanitizeLine(s: string): string {
  // SSE fields cannot contain newlines
  return collapseNewlines(String(s));
}

function collapseNewlines(s: string): string {
  return s.replace(/[\r\n]+/g, ' ');
}

function tryParseJSON(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}