import "server-only";
import { z } from "zod";

/**
 * Strict, typed environment validation for server code.
 * - Fails fast with clear messages on invalid/missing vars.
 * - Ensures secrets never reach the client (server-only import).
 * - Provides sensible defaults for optional flags.
 */

function parseBoolean(v: unknown): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return undefined; // invalid -> let zod handle via default/error
}
function parseNumber(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

const ServerEnvSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    VERCEL_ENV: z.enum(["development", "preview", "production"]).optional(),

    // Required service credentials
    GROQ_API_KEY: z.string().min(1, "GROQ_API_KEY is required"),
    JINA_API_KEY: z.string().min(1, "JINA_API_KEY is required"),

    // Turso / libSQL
    TURSO_DATABASE_URL: z
      .string()
      .min(1, "TURSO_DATABASE_URL is required")
      .refine(
        (s) => /^libsql:\/\//.test(s) || /^file:/.test(s),
        "TURSO_DATABASE_URL must start with libsql:// (remote) or file: (local)"
      ),
    TURSO_AUTH_TOKEN: z.string().optional(), // conditionally required (remote)

    // Services config
    JINA_SEARCH_BASE: z.string().url().default("https://api.jina.ai"),

    // App flags and limits
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    ENABLE_RERANK: z
      .preprocess(parseBoolean, z.boolean().default(false))
      .default(false),
    REQUEST_TIMEOUT_MS: z
      .preprocess(parseNumber, z.number().int().positive().default(30000))
      .default(30000),
    MAX_SOURCES_INLINE: z
      .preprocess(parseNumber, z.number().int().min(1).max(24).default(12))
      .default(12),
  })
  .superRefine((env, ctx) => {
    // Require TURSO_AUTH_TOKEN for remote libsql (non-file, non-localhost)
    const isRemote =
      env.TURSO_DATABASE_URL.startsWith("libsql://") &&
      !/localhost|127\.0\.0\.1/i.test(env.TURSO_DATABASE_URL);

    if (
      isRemote &&
      (!env.TURSO_AUTH_TOKEN || env.TURSO_AUTH_TOKEN.length === 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["TURSO_AUTH_TOKEN"],
        message:
          "TURSO_AUTH_TOKEN is required for remote Turso/libsql connections",
      });
    }
  });

const raw = {
  NODE_ENV: process.env.NODE_ENV,
  VERCEL_ENV: process.env.VERCEL_ENV,

  GROQ_API_KEY: process.env.GROQ_API_KEY,
  JINA_API_KEY: process.env.JINA_API_KEY,

  TURSO_DATABASE_URL: process.env.TURSO_DATABASE_URL,
  TURSO_AUTH_TOKEN: process.env.TURSO_AUTH_TOKEN,

  JINA_SEARCH_BASE: process.env.JINA_SEARCH_BASE,

  LOG_LEVEL: process.env.LOG_LEVEL,
  ENABLE_RERANK: process.env.ENABLE_RERANK,
  REQUEST_TIMEOUT_MS: process.env.REQUEST_TIMEOUT_MS,
  MAX_SOURCES_INLINE: process.env.MAX_SOURCES_INLINE,
};

const parsed = ServerEnvSchema.safeParse(raw);

if (!parsed.success) {
  //   const format = parsed.error.format();
  const issues = parsed.error.issues
    .map((i) => `- ${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("\n");

  // Emit a concise but clear error; fail fast to avoid partial boot.
  console.error("Invalid environment configuration:\n" + issues);
  throw new Error("Environment validation failed. See logs for details.");
}

export const env = Object.freeze({
  ...parsed.data,
  get isProd() {
    return parsed.data.NODE_ENV === "production";
  },
  get isDev() {
    return parsed.data.NODE_ENV === "development";
  },
  get isTest() {
    return parsed.data.NODE_ENV === "test";
  },
});

export type Env = typeof env;

/**
 * Usage:
 *  import { env } from '@/lib/env';
 *  const client = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });
 *
 * Note:
 *  - Keep this file server-only. If you need client-safe vars, expose them as NEXT_PUBLIC_*
 *    and access directly via process.env.NEXT_PUBLIC_* in client code, or create a separate
 *    lib/public-env.ts without importing 'server-only'.
 */
