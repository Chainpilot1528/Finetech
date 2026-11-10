import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { resolve } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { bootstrapDatabase, runMigrations } from '../apps/api/src/platform/migrate.js';

/** A real Postgres 16 for development, kept in .dev/pg. Stop it with Ctrl+C. */
process.loadEnvFile('.env');
const env = process.env as Record<string, string>;
const dir = resolve('.dev/pg');
const port = Number(env.DB_PORT);

/** Starting a second copy against the same folder half-stops the first one, so refuse early (DX-03). */
const inUse = await new Promise<boolean>((done) => {
  const socket = createConnection({ host: '127.0.0.1', port });
  socket.once('connect', () => { socket.destroy(); done(true); });
  socket.once('error', () => done(false));
});
if (inUse) {
  console.error(`Port ${port} is already in use. The database is probably running in another terminal; leave that one running.`);
  process.exit(1);
}

/** Postgres output is kept quiet unless start-up fails, when it is printed in full (DX-02). */
const logs: string[] = [];
const pg = new EmbeddedPostgres({
  databaseDir: dir, user: 'postgres', password: env.DB_ADMIN_PASSWORD, port, persistent: true,
  onLog: (line) => { logs.push(String(line)); if (logs.length > 200) logs.shift(); },
  onError: (err) => { logs.push(String(err)); },
});
try {
  if (!existsSync(`${dir}/PG_VERSION`)) await pg.initialise();
  await pg.start();
} catch (err) {
  console.error('Postgres failed to start. Its output:\n' + logs.join('\n'));
  console.error(err instanceof Error ? err.message : String(err ?? 'unknown error'));
  process.exit(1);
}
await bootstrapDatabase(`postgres://postgres:${env.DB_ADMIN_PASSWORD}@127.0.0.1:${env.DB_PORT}/postgres`, 'vittora', {
  owner: env.DB_OWNER_PASSWORD!, app: env.DB_APP_PASSWORD!, auth: env.DB_AUTH_PASSWORD!, ops: env.DB_OPS_PASSWORD!,
});
const applied = await runMigrations(env.OWNER_DATABASE_URL!, resolve('db/migrations'));
console.log(`Database ready on port ${env.DB_PORT}. New migrations: ${applied.join(', ') || 'none'}`);
const stop = async () => { await pg.stop(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 1 << 30);
