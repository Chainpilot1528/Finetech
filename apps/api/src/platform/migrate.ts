import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

export interface RolePasswords {
  owner: string;
  app: string;
  auth: string;
}

const quoteLiteral = (v: string) => `'${v.replace(/'/g, "''")}'`;

/** Creates the three database roles and the database. Safe to run twice. */
export async function bootstrapDatabase(adminUrl: string, dbName: string, pw: RolePasswords): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const roles: [string, string][] = [
      ['vittora_owner', pw.owner],
      ['vittora_app', pw.app],
      ['vittora_auth', pw.auth],
    ];
    for (const [role, password] of roles) {
      const found = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
      const verb = found.rowCount ? 'ALTER' : 'CREATE';
      await client.query(`${verb} ROLE ${role} LOGIN PASSWORD ${quoteLiteral(password)}`);
    }
    const db = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (!db.rowCount) await client.query(`CREATE DATABASE "${dbName}" OWNER vittora_owner`);
  } finally {
    await client.end();
  }
}

/** Applies forward-only SQL migrations in filename order (§14.7). */
export async function runMigrations(ownerUrl: string, dir: string): Promise<string[]> {
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migration (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const done = new Set((await client.query('SELECT name FROM schema_migration')).rows.map((r) => r.name));
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(file)) continue;
      await client.query('BEGIN');
      try {
        await client.query(readFileSync(join(dir, file), 'utf8'));
        await client.query('INSERT INTO schema_migration (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await client.end();
  }
  return applied;
}
