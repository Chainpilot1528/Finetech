import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { bootstrapDatabase, runMigrations } from '../apps/api/src/platform/migrate.js';

/** A real Postgres 16 for development, kept in .dev/pg. Stop it with Ctrl+C. */
process.loadEnvFile('.env');
const env = process.env as Record<string, string>;
const dir = resolve('.dev/pg');
const pg = new EmbeddedPostgres({
  databaseDir: dir, user: 'postgres', password: env.DB_ADMIN_PASSWORD, port: Number(env.DB_PORT), persistent: true,
  onLog: () => {},
});
if (!existsSync(`${dir}/PG_VERSION`)) await pg.initialise();
await pg.start();
await bootstrapDatabase(`postgres://postgres:${env.DB_ADMIN_PASSWORD}@127.0.0.1:${env.DB_PORT}/postgres`, 'vittora', {
  owner: env.DB_OWNER_PASSWORD!, app: env.DB_APP_PASSWORD!, auth: env.DB_AUTH_PASSWORD!,
});
const applied = await runMigrations(env.OWNER_DATABASE_URL!, resolve('db/migrations'));
console.log(`Database ready on port ${env.DB_PORT}. New migrations: ${applied.join(', ') || 'none'}`);
const stop = async () => { await pg.stop(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 1 << 30);
