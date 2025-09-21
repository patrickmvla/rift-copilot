// src/db/health.ts
import { client } from "@/db";
import { env } from "@/lib/env";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function dbHealthCheck(opts?: {
  timeoutMs?: number;
  maxRetries?: number;
  baseDelayMs?: number;
}) {
  const timeout =
    opts?.timeoutMs ?? env.DB_HEALTHCHECK_TIMEOUT_MS ?? Math.min(3000, env.REQUEST_TIMEOUT_MS);
  const maxRetries = Math.max(0, opts?.maxRetries ?? env.DB_MAX_RETRIES ?? 1);
  const baseDelay = Math.max(50, opts?.baseDelayMs ?? env.DB_RETRY_BASE_MS ?? 200);

  let attempt = 0;
  while (true) {
    try {
      // Simple ping; keep it tiny
      const p = client.execute({ sql: "SELECT 1;", args: [] });
      const res = await Promise.race([
        p,
        new Promise((_, rej) =>
          setTimeout(() => rej(new DOMException("DB health timeout", "TimeoutError")), timeout)
        ),
      ]);
      if (res) return; // healthy
    } catch (e) {
      if (attempt >= maxRetries) throw e;
      const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 50;
      await sleep(delay);
      attempt++;
    }
  }
}