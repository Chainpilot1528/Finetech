import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_ATTEMPTS, Outbox } from '../src/platform/outbox.js';
import type { DocumentStore } from '../src/platform/storage.js';
import { DOCUMENT_STORE } from '../src/platform/tokens.js';
import { PDF, client, createLender, createPartner, createUser, enableProducts, harness, signedIn, type Harness } from './helpers.js';

let h: Harness;
let outbox: Outbox;

beforeAll(async () => {
  h = await harness();
  outbox = h.app.get(Outbox);
});
afterAll(async () => h?.close());

const rowsFor = (topic: string) =>
  h.db.query('SELECT status, attempts, payload_enc, last_error FROM outbox WHERE topic = $1 ORDER BY id DESC', [topic]);

/** Makes the next `n` sends fail, as a mail server outage would. */
function failNext(n: number) {
  const real = h.mail.send.bind(h.mail);
  let left = n;
  h.mail.send = async (m) => {
    if (left > 0) {
      left -= 1;
      throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' });
    }
    return real(m);
  };
  return () => { h.mail.send = real; };
}

describe('outbox delivery (BUG-03)', () => {
  it('keeps a failed message and delivers it on a later try, then clears its contents', async () => {
    const partner = await createPartner(h.db);
    const user = await createUser(h.db, partner, 'admin');
    const restore = failNext(1);
    const c = await client(h);
    expect((await c.post('/auth/password/forgot', { email: user.email })).status).toBe(202);
    expect(h.mail.messages.some((m) => m.to === user.email)).toBe(false);
    let [row] = (await rowsFor('auth.password_reset')).rows;
    expect(row).toMatchObject({ status: 'pending', attempts: 1, last_error: 'ECONNREFUSED' });
    expect(row.payload_enc).toBeTruthy();

    restore();
    expect(await outbox.drain()).toBe(0); // not due yet: the retry waits 30 seconds
    h.clock.advance(31_000);
    expect(await outbox.drain()).toBe(1);
    expect(h.mail.messages[0]!.to).toBe(user.email);
    [row] = (await rowsFor('auth.password_reset')).rows;
    expect(row).toMatchObject({ status: 'sent', attempts: 2, last_error: null, payload_enc: null });
  });

  it('gives up after the last attempt and lists the failure by id and code only', async () => {
    const partner = await createPartner(h.db);
    const user = await createUser(h.db, partner, 'admin');
    const restore = failNext(MAX_ATTEMPTS);
    const since = h.clock.now();
    await (await client(h)).post('/auth/password/forgot', { email: user.email });
    for (let i = 1; i < MAX_ATTEMPTS; i += 1) {
      h.clock.advance(31_000 * 2 ** i);
      await outbox.drain();
    }
    restore();
    const [row] = (await rowsFor('auth.password_reset')).rows;
    expect(row).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS, payload_enc: null });
    const failures = await outbox.failures(since);
    expect(failures.some((f) => f.topic === 'auth.password_reset' && f.last_error === 'ECONNREFUSED')).toBe(true);
    expect(JSON.stringify(failures)).not.toContain(user.email);
  });

  it('sends nothing when the change that queued it rolls back', async () => {
    const before = (await h.db.query('SELECT count(*)::int AS n FROM outbox')).rows[0].n;
    const exec = await signedIn(h, (await createUser(h.db, await createPartner(h.db, {}, 'approved'), 'executive')).email);
    // An incomplete draft fails validation after the transaction has started.
    const draft = (await exec.post('/cases/drafts').set('idempotency-key', randomUUID())).body;
    expect((await exec.post(`/cases/drafts/${draft.id}/consent-requests`)).status).toBe(422);
    const after = (await h.db.query(`SELECT count(*)::int AS n FROM outbox WHERE topic = 'consent.link'`)).rows[0].n;
    expect(after).toBeLessThanOrEqual(before);
  });
});

describe('file changes wait for the commit (BUG-02)', () => {
  it('deletes a dropped document only after the change has committed', async () => {
    const partner = await createPartner(h.db, {}, 'approved');
    await enableProducts(h.db, partner);
    const lender = await createLender(h.db);
    const exec = await signedIn(h, (await createUser(h.db, partner, 'executive')).email);
    const draft = (await exec.post('/cases/drafts').set('idempotency-key', randomUUID())).body;
    const saved = (await exec.patch(`/cases/drafts/${draft.id}`, {
      version: draft.version, data: { setup: { product: 'used_car', loanType: 'purchase', lenderId: lender } },
    })).body;
    expect((await exec.upload(`/cases/drafts/${draft.id}/documents/rc`, PDF)).status).toBe(204);
    const { rows: [doc] } = await h.db.query('SELECT object_key FROM case_document WHERE draft_id = $1 AND doc_type = $2', [draft.id, 'rc']);

    const store = h.app.get<DocumentStore>(DOCUMENT_STORE);
    const realRemove = store.remove.bind(store);
    const rowsWhenRemoved: number[] = [];
    store.remove = async (key) => {
      rowsWhenRemoved.push((await h.db.query('SELECT count(*)::int AS n FROM case_document WHERE object_key = $1', [key])).rows[0].n);
      return realRemove(key);
    };
    try {
      const res = await exec.patch(`/cases/drafts/${draft.id}`, { version: saved.version, data: { setup: { product: 'personal', loanType: 'fresh', lenderId: lender } } });
      expect(res.status).toBe(200);
    } finally {
      store.remove = realRemove;
    }
    expect(rowsWhenRemoved).toEqual([0]); // the row was already gone for everyone else when the file went
    await expect(store.get(doc.object_key)).rejects.toThrow();
  });

  it('removes a just-written file when its upload is refused', async () => {
    const partner = await createPartner(h.db, {}, 'submitted');
    const admin = await signedIn(h, (await createUser(h.db, partner, 'admin')).email);
    const dir = join(h.storageDir, 'kyc', partner);
    expect((await admin.upload('/kyc/documents/pan', PDF)).body.code).toBe('KYC_LOCKED');
    let files: string[] = [];
    try { files = readdirSync(dir); } catch { /* never created */ }
    expect(files).toEqual([]);
  });

  it('sweeps old files that no row points to, and keeps the rest', async () => {
    const partner = await createPartner(h.db);
    const admin = await signedIn(h, (await createUser(h.db, partner, 'admin')).email);
    expect((await admin.upload('/kyc/documents/pan', PDF)).status).toBe(204);
    const stray = join(h.storageDir, 'kyc', partner, 'stray-object');
    mkdirSync(join(h.storageDir, 'kyc', partner), { recursive: true });
    writeFileSync(stray, 'x');
    const old = new Date(h.clock.now().getTime() - 2 * 24 * 3_600_000);
    for (const f of readdirSync(join(h.storageDir, 'kyc', partner))) utimesSync(join(h.storageDir, 'kyc', partner, f), old, old);
    const removed = await outbox.sweepOrphans();
    expect(removed).toContain(`kyc/${partner}/stray-object`);
    expect(readdirSync(join(h.storageDir, 'kyc', partner))).toHaveLength(1);
  });
});
