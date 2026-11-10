import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPartner, createUser, harness, signedIn, type Client, type Harness } from './helpers.js';

let h: Harness;
let admin: Client;
let partner: string;
beforeAll(async () => {
  h = await harness();
  partner = await createPartner(h.db, {}, 'approved');
  admin = await signedIn(h, (await createUser(h.db, partner, 'admin')).email);
});
afterAll(async () => h?.close());

const invite = (email: string) => ({ name: 'New Person', email, role: 'executive' });
const count = async (email: string) => (await h.db.query('SELECT count(*)::int AS n FROM app_user WHERE email = $1', [email])).rows[0].n;

describe('one idempotency layer for every signed-in POST (STD-08)', () => {
  it('replays the first response for a repeated key instead of acting twice', async () => {
    const key = randomUUID();
    const email = `once-${randomUUID()}@example.test`;
    const first = await admin.post('/users/invite', invite(email)).set('idempotency-key', key);
    expect(first.status).toBe(201);
    const again = await admin.post('/users/invite', invite(email)).set('idempotency-key', key);
    expect(again.status).toBe(201);
    expect(again.headers['idempotent-replay']).toBe('true');
    expect(again.body).toEqual(first.body);
    expect(await count(email)).toBe(1);
    expect(h.mail.messages.filter((m) => m.to === email)).toHaveLength(1);
  });

  it('refuses the same key with a different body', async () => {
    const key = randomUUID();
    expect((await admin.post('/users/invite', invite(`a-${randomUUID()}@example.test`)).set('idempotency-key', key)).status).toBe(201);
    const other = await admin.post('/users/invite', invite(`b-${randomUUID()}@example.test`)).set('idempotency-key', key);
    expect(other.status).toBe(422);
    expect(other.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('lets a failed request be retried with the same key', async () => {
    const key = randomUUID();
    const bad = await admin.post('/users/invite', { name: 'x', email: 'not-an-email', role: 'executive' }).set('idempotency-key', key);
    expect(bad.status).toBe(422);
    const email = `retry-${randomUUID()}@example.test`;
    // Same key, corrected body: the failed attempt released the key.
    expect((await admin.post('/users/invite', invite(email)).set('idempotency-key', key)).status).toBe(201);
  });

  it('scopes keys to the user, so another user\'s key never replays to them', async () => {
    const key = randomUUID();
    const other = await signedIn(h, (await createUser(h.db, await createPartner(h.db, {}, 'approved'), 'admin')).email);
    const email = `scoped-${randomUUID()}@example.test`;
    expect((await admin.post('/users/invite', invite(email)).set('idempotency-key', key)).status).toBe(201);
    const theirs = await other.post('/users/invite', invite(`their-${randomUUID()}@example.test`)).set('idempotency-key', key);
    expect(theirs.status).toBe(201);
    expect(theirs.headers['idempotent-replay']).toBeUndefined();
  });
});
