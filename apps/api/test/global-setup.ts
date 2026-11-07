import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { bootstrapDatabase, runMigrations } from '../src/platform/migrate.js';

const PORT = 54331;

/** A real, throwaway Postgres: tests exercise actual roles, RLS and grants. */
export default async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'vittora-test-pg-'));
  const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'test', port: PORT, persistent: false, onLog: () => {} });
  await pg.initialise();
  await pg.start();
  const base = (user: string, pw: string, db: string) => `postgres://${user}:${pw}@127.0.0.1:${PORT}/${db}`;
  await bootstrapDatabase(base('postgres', 'test', 'postgres'), 'vittora_test', { owner: 'owner', app: 'app', auth: 'auth', ops: 'ops' });
  await runMigrations(base('vittora_owner', 'owner', 'vittora_test'), join(import.meta.dirname, '../../../db/migrations'));
  process.env.TEST_OWNER_URL = base('vittora_owner', 'owner', 'vittora_test');
  process.env.TEST_APP_URL = base('vittora_app', 'app', 'vittora_test');
  process.env.TEST_AUTH_URL = base('vittora_auth', 'auth', 'vittora_test');
  process.env.TEST_OPS_URL = base('vittora_ops', 'ops', 'vittora_test');
  return async () => {
    await pg.stop();
    rmSync(dir, { recursive: true, force: true });
  };
}
