import pg from 'pg';
import { v7 as uuid } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPartner, createUser, harness, signedIn, type Harness } from './helpers.js';

let h: Harness;
let a: string;
let b: string;
let userA: { id: string; email: string };
let userB: { id: string; email: string };
let app: pg.Pool;
let auth: pg.Pool;

beforeAll(async () => {
  h = await harness();
  a = await createPartner(h.db);
  b = await createPartner(h.db);
  userA = await createUser(h.db, a, 'admin');
  userB = await createUser(h.db, b, 'admin');
  app = new pg.Pool({ connectionString: process.env.TEST_APP_URL, max: 2 });
  auth = new pg.Pool({ connectionString: process.env.TEST_AUTH_URL, max: 2 });
});
afterAll(async () => {
  await app.end();
  await auth.end();
  await h.close();
});

async function asTenant<T>(partnerId: string | null, fn: (c: pg.PoolClient) => Promise<T>) {
  const c = await app.connect();
  try {
    await c.query('BEGIN');
    if (partnerId) await c.query(`SELECT set_config('app.partner_id', $1, true)`, [partnerId]);
    return await fn(c);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}

describe('through the API', () => {
  it('an admin only ever sees their own organisation', async () => {
    const c = await signedIn(h, userA.email);
    const list = await c.get('/users');
    expect(list.status).toBe(200);
    const ids = list.body.data.map((u: { id: string }) => u.id);
    expect(ids).toContain(userA.id);
    expect(ids).not.toContain(userB.id);
  });

  it('another tenant\'s user looks like it does not exist', async () => {
    const c = await signedIn(h, userA.email);
    const res = await c.get(`/users/${userB.id}`);
    expect(res.status).toBe(404);
    expect((await c.get(`/users/${uuid()}`)).body).toEqual(res.body);
  });

  it('never returns password hashes or MFA secrets', async () => {
    const c = await signedIn(h, userA.email);
    const text = JSON.stringify((await c.get('/users')).body);
    expect(text).not.toMatch(/password|secret|argon/i);
  });
});

describe('in the database, even if the app code is wrong', () => {
  it('shows nothing when no tenant is set', async () => {
    const rows = await asTenant(null, async (c) => (await c.query('SELECT id FROM app_user')).rows);
    expect(rows).toEqual([]);
  });

  it('a WHERE clause can not reach another tenant', async () => {
    const rows = await asTenant(a, async (c) => (await c.query('SELECT id FROM app_user WHERE id = $1', [userB.id])).rows);
    expect(rows).toEqual([]);
  });

  it('the app role can not read password hashes or MFA secrets at all', async () => {
    await expect(asTenant(a, (c) => c.query('SELECT password_hash FROM app_user'))).rejects.toThrow(/permission denied/);
    await expect(asTenant(a, (c) => c.query('SELECT mfa_secret_enc FROM app_user'))).rejects.toThrow(/permission denied/);
  });

  it('the app role can not touch credentials, move users between tenants, or read sessions', async () => {
    for (const column of [`password_hash = 'x'`, 'mfa_enabled = false', `mfa_secret_enc = 'x'`, 'locked_until = NULL', `partner_id = '${b}'`]) {
      await expect(asTenant(a, (c) => c.query(`UPDATE app_user SET ${column}`)), column).rejects.toThrow(/permission denied/);
    }
    await expect(asTenant(a, (c) => c.query('SELECT * FROM session'))).rejects.toThrow(/permission denied/);
  });

  it('team changes stay inside the tenant, and never reach an internal role', async () => {
    const other = await createUser(h.db, b, 'viewer');
    const moved = await asTenant(a, (c) => c.query(`UPDATE app_user SET role = 'admin' WHERE id = $1`, [other.id]));
    expect(moved.rowCount).toBe(0);
    await createUser(h.db, a, 'viewer');
    await expect(asTenant(a, (c) => c.query(`UPDATE app_user SET role = 'super_admin'`))).rejects.toThrow(/role_matches_realm/);
  });

  it('session and invite functions do nothing to another tenant', async () => {
    const other = await createUser(h.db, b, 'viewer', { status: 'invited', password: false });
    const issued = await asTenant(a, (c) => c.query('SELECT partner_user_setup_token($1,$2,$3,now() + interval \'1 hour\',now()) AS ok', [uuid(), other.id, 'hash']));
    expect(issued.rows[0].ok).toBe(false);
  });

  it('audit rows can not be written for another tenant', async () => {
    await expect(
      asTenant(a, (c) => c.query(`INSERT INTO audit_log (id, partner_id, action) VALUES ($1,$2,'x')`, [uuid(), b])),
    ).rejects.toThrow(/row-level security/);
  });
});

describe('roles and realms', () => {
  it('a partner user can never hold an internal role, enforced by the database', async () => {
    await expect(createUser(h.db, a, 'super_admin')).rejects.toThrow(/role_matches_realm/);
    await expect(createUser(h.db, null, 'admin')).rejects.toThrow(/role_matches_realm/);
  });
  it('rejects unknown roles and duplicate emails in any capitalisation', async () => {
    await expect(createUser(h.db, a, 'root' as never)).rejects.toThrow();
    await expect(
      h.db.query(`INSERT INTO app_user (id, partner_id, name, email, role) VALUES ($1,$2,'x',$3,'viewer')`, [uuid(), a, userA.email.toUpperCase()]),
    ).rejects.toThrow(/app_user_email_key/);
  });
});
