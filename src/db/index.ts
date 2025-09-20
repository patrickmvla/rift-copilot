import 'server-only';
import { createClient } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import * as schema from './schema';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';

// Singleton guard for Next.js dev HMR
declare global {

  var __DRIZZLE__: { db: LibSQLDatabase<typeof schema>; client: ReturnType<typeof createClient> } | undefined;
}

function makeDrizzle() {
  const client = createClient({
    url: env.TURSO_DATABASE_URL,
    ...(env.TURSO_AUTH_TOKEN ? { authToken: env.TURSO_AUTH_TOKEN } : {}),
  });

  // Structured query logging only in debug mode
  const drizzleLogger =
    env.LOG_LEVEL === 'debug'
      ? {
          logQuery(query: string, params: unknown[]) {
            logger.debug({ mod: 'db', sql: query, params }, 'SQL');
          },
        }
      : false;

  const db = drizzle(client, { schema, logger: drizzleLogger });

  return { db, client };
}

export const { db, client } = globalThis.__DRIZZLE__ ?? (globalThis.__DRIZZLE__ = makeDrizzle());

// Optional: quick health check (useful in diagnostics/startup)
export async function pingDatabase(): Promise<boolean> {
  try {
    await client.execute('SELECT 1');
    return true;
  } catch (e) {
    logger.error({ err: e }, 'Database ping failed');
    return false;
  }
}

// Optional: graceful close for local scripts (not typically used on serverless)
export async function closeDatabase(): Promise<void> {
  try {
    // @libsql/client provides .close() for websocket connections;
    // it's a no-op for HTTP. Safe to call in CLI/migrations.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (client as any)?.close?.();
  } catch {
    // ignore
  }
}

export type DB = typeof db;
export type DBSchema = typeof schema;