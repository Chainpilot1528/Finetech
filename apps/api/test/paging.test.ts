import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPartner, createUser, harness, opsSession, signedIn, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => { h = await harness(); });
afterAll(async () => h?.close());

describe('lists page with a cursor instead of stopping at a fixed limit (STD-06)', () => {
  it('walks every user exactly once, page by page', async () => {
    const partner = await createPartner(h.db, {}, 'approved');
    const admin = await signedIn(h, (await createUser(h.db, partner, 'admin')).email);
    for (let i = 0; i < 4; i += 1) await createUser(h.db, partner, 'executive');
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await admin.get(`/users?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeLessThanOrEqual(2);
      seen.push(...res.body.data.map((u: { id: string }) => u.id));
      cursor = res.body.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(pages).toBe(3);
  });

  it('pages the ops partner list and rejects a bad cursor or limit', async () => {
    const ops = await opsSession(h, 'kyc_reviewer');
    for (let i = 0; i < 3; i += 1) await createPartner(h.db);
    const first = await ops.get('/ops/partners?limit=2');
    expect(first.body.data).toHaveLength(2);
    expect(first.body.nextCursor).toBeTruthy();
    const second = await ops.get(`/ops/partners?limit=2&cursor=${first.body.nextCursor}`);
    expect(second.body.data[0].id).not.toBe(first.body.data[1].id);
    expect((await ops.get('/ops/partners?cursor=nonsense')).status).toBe(422);
    expect((await ops.get('/ops/partners?limit=1000')).status).toBe(422);
  });
});
