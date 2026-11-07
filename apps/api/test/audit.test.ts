import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PASSWORD, client, createPartner, createUser, harness, type Harness } from './helpers.js';

let h: Harness;
let auth: pg.Pool;
let app: pg.Pool;
beforeAll(async () => {
  h = await harness();
  auth = new pg.Pool({ connectionString: process.env.TEST_AUTH_URL, max: 2 });
  app = new pg.Pool({ connectionString: process.env.TEST_APP_URL, max: 2 });
});
afterAll(async () => {
  await auth.end();
  await app.end();
  await h.close();
});

const verify = async () => (await auth.query('SELECT audit_log_verify() AS broken')).rows[0].broken;

describe('audit log (§9.5)', () => {
  it('records sign-ins without any PII or credentials', async () => {
    const pid = await createPartner(h.db);
    const u = await createUser(h.db, pid, 'viewer');
    await (await client(h)).login(u.email);
    const { rows } = await h.db.query('SELECT * FROM audit_log WHERE actor_id = $1', [u.id]);
    expect(rows.map((r) => r.action)).toContain('auth.sign_in');
    const text = JSON.stringify(rows);
    expect(text).not.toContain(u.email);
    expect(text).not.toContain(PASSWORD);
  });

  it('no application role can update or delete rows', async () => {
    for (const pool of [app, auth]) {
      await expect(pool.query(`UPDATE audit_log SET action = 'x'`)).rejects.toThrow(/permission denied/);
      await expect(pool.query('DELETE FROM audit_log')).rejects.toThrow(/permission denied/);
      await expect(pool.query('TRUNCATE audit_log')).rejects.toThrow(/permission denied/);
    }
  });

  it('keeps an intact hash chain across concurrent writes', async () => {
    const pid = await createPartner(h.db);
    const users = await Promise.all([1, 2, 3, 4].map(() => createUser(h.db, pid, 'viewer')));
    const clients = await Promise.all(users.map(() => client(h)));
    await Promise.all(users.map((u, i) => clients[i]!.login(u.email)));
    expect(await verify()).toBeNull();
  });

  it('detects tampering, even by someone with database owner access', async () => {
    const { rows } = await h.db.query('SELECT seq FROM audit_log ORDER BY seq DESC LIMIT 1 OFFSET 1');
    const seq = rows[0].seq;
    const c = await h.db.connect();
    try {
      await c.query('BEGIN');
      await c.query(`UPDATE audit_log SET action = 'auth.nothing_to_see' WHERE seq = $1`, [seq]);
      const broken = (await c.query('SELECT audit_log_verify() AS broken')).rows[0].broken;
      expect(broken).toBe(seq);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
    expect(await verify()).toBeNull();
  });
});
