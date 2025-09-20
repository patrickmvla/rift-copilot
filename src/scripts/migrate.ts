import 'dotenv/config';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { db, client } from '@/db'; // if path alias isn't set, use: ../db

async function main() {
  try {
    console.log('Running migrations...');
    await migrate(db, { migrationsFolder: 'db/migrations' });
    console.log('Migrations applied successfully ✅');
  } catch (err) {
    console.error('Migration failed ❌\n', err);
    process.exitCode = 1;
  } finally {
    try {
      // @libsql/client close (noop for HTTP)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (client as any)?.close?.();
    } catch {
      // ignore
    }
  }
}

main();