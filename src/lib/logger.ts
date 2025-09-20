/* eslint-disable @typescript-eslint/no-explicit-any */
import 'server-only';
import pino, { type Logger, type LoggerOptions } from 'pino';
import { env } from './env';

declare global {
 
  var __APP_LOGGER__: Logger | undefined;
}

const serviceName = 'evidence-research-copilot';

function buildLogger(): Logger {
  const options: LoggerOptions = {
    level: env.LOG_LEVEL,
    base: { service: serviceName, env: env.NODE_ENV },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level(label) {
        return { level: label };
      },
      bindings() {
        return { service: serviceName };
      },
    },
    redact: {
      paths: [
        'config.apiKey',
        'apiKey',
        'authorization',
        'req.headers.authorization',
        'headers.authorization',
        'env.GROQ_API_KEY',
        'env.JINA_API_KEY',
        'env.TURSO_AUTH_TOKEN',
      ],
      remove: true,
    },
  };

  const enablePretty =
    env.isDev && (process.env.PRETTY_LOGS === '1' || process.env.PINO_PRETTY === '1');

  if (enablePretty) {
    try {
      // Avoid static resolution so Next.js bundler doesn’t try to include it.
      const r = (eval('require') as NodeRequire);
      const pretty = r('pino-pretty');
      const stream = pretty({
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
        singleLine: false,
      });
      // Use destination stream form in dev; no transport target needed
      return pino(options, stream as any);
    } catch {
      // Fall back to JSON logs if pino-pretty isn’t installed/available
      return pino(options);
    }
  }

  // Default: JSON logs (production-safe)
  return pino(options);
}

export const logger: Logger = globalThis.__APP_LOGGER__ ?? buildLogger();
if (!globalThis.__APP_LOGGER__) globalThis.__APP_LOGGER__ = logger;

export function loggerWithRequest(
  req: { headers: Headers; method?: string | null; url?: string | null },
  extra?: Record<string, unknown>
): Logger {
  const headers = req.headers;
  const requestId =
    headers.get('x-request-id') ||
    headers.get('x-correlation-id') ||
    headers.get('x-vercel-id') ||
    (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

  const ip =
    headers.get('x-forwarded-for')?.split(',').map((s) => s.trim()).find(Boolean) ||
    headers.get('x-real-ip') ||
    undefined;

  const userAgent = headers.get('user-agent') || undefined;

  return logger.child(
    {
      req: {
        id: requestId,
        method: req.method ?? undefined,
        url: req.url ?? undefined,
        ip,
        ua: userAgent,
      },
      ...extra,
    },
    { serializers: { err: pino.stdSerializers.err } }
  );
}

export function logError(
  log: Logger,
  err: unknown,
  msg = 'Unhandled error',
  ctx?: Record<string, unknown>
) {
  const normalized =
    err instanceof Error
      ? { name: err.name, message: err.message, stack: err.stack, cause: (err as any)?.cause }
      : { message: String(err) };
  log.error({ err: normalized, ...ctx }, msg);
}

export function startSpan(log: Logger, name: string) {
  const start = Date.now();
  return {
    end: (extra?: Record<string, unknown>) => {
      const duration_ms = Date.now() - start;
      log.info({ span: name, duration_ms, ...extra }, `${name} completed`);
      return duration_ms;
    },
  };
}

// Optional: crash safety in production
let crashHandlersRegistered = false;
if (env.isProd && !crashHandlersRegistered) {
  crashHandlersRegistered = true;
  process.on('uncaughtException', (e) => {
    logger.fatal({ err: e }, 'Uncaught exception');
  });
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'Unhandled promise rejection');
  });
}