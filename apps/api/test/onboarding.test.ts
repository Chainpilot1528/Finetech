import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AGREEMENT_VERSION } from '@vittora/product-schemas';
import pg from 'pg';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PDF, client, createPartner, createUser, harness, linkToken, signedIn, type Client, type Harness } from './helpers.js';

let h: Harness;
let reviewer: Client;
beforeAll(async () => {
  h = await harness();
  reviewer = await signedIn(h, (await createUser(h.db, null, 'kyc_reviewer')).email, 'ops');
});
afterAll(() => h.close());

let n = 0;
const registration = (email: string) => ({
  channelName: 'Sharma Motors', legalName: 'Sharma Motors Pvt Ltd', city: 'New Delhi', pincode: '110001',
  businessEmail: 'office@sharma.test', products: ['used_car', 'personal'], employeeBand: '6-10',
  adminName: 'Asha Sharma', adminEmail: email,
});

async function partnerWithAdmin() {
  const partnerId = await createPartner(h.db);
  const admin = await createUser(h.db, partnerId, 'admin');
  return { partnerId, c: await signedIn(h, admin.email), admin };
}

async function readyToSubmit(c: Client) {
  await c.post('/partner/agreement', { version: AGREEMENT_VERSION });
  for (const type of ['pan', 'address_proof', 'bank_details']) {
    expect((await c.upload(`/kyc/documents/${type}`, PDF)).status).toBe(204);
  }
}

describe('registration (§4.1)', () => {
  it('creates a pending partner and an invited admin, and emails the setup link and Reference ID', async () => {
    const email = `new-${(n += 1)}@example.test`;
    const c = await client(h);
    const res = await c.post('/partners/register', registration(email));
    expect(res.status).toBe(202);
    await new Promise((r) => setImmediate(r));
    const mail = h.mail.messages.find((m) => m.to === email)!;
    expect(mail.text).toMatch(/NEW-110-\d+/);

    const { rows } = await h.db.query(
      `SELECT p.status, p.kyc_status, u.role, u.status AS user_status FROM app_user u JOIN partner p ON p.id = u.partner_id WHERE u.email = $1`,
      [email],
    );
    expect(rows[0]).toEqual({ status: 'pending', kyc_status: 'not_started', role: 'admin', user_status: 'invited' });

    const set = await c.post('/auth/password/reset', { token: linkToken(mail.text), password: 'a-brand-new-secret-77' });
    expect(set.status).toBe(204);
    expect((await c.login(email, 'a-brand-new-secret-77')).body.mfaState).toBe('enroll');
  });

  it('answers the same for a taken email and creates nothing', async () => {
    const taken = await createUser(h.db, await createPartner(h.db), 'viewer');
    const before = (await h.db.query('SELECT count(*)::int AS n FROM partner')).rows[0].n;
    const res = await (await client(h)).post('/partners/register', registration(taken.email));
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: true });
    expect((await h.db.query('SELECT count(*)::int AS n FROM partner')).rows[0].n).toBe(before);
    h.clock.advance(61_000);
  });

  it('rejects bad input and unknown products', async () => {
    const c = await client(h);
    expect((await c.post('/partners/register', { ...registration('x@example.test'), pincode: '12' })).status).toBe(422);
    expect((await c.post('/partners/register', { ...registration('x@example.test'), products: ['gold'] })).status).toBe(422);
    expect((await c.post('/partners/register', { ...registration('x@example.test'), products: [] })).status).toBe(422);
  });

  it('is rate limited', async () => {
    h.clock.advance(61_000);
    const c = await client(h);
    const codes = [];
    for (let i = 0; i < 6; i += 1) codes.push((await c.post('/partners/register', registration(`rate-${i}@example.test`))).status);
    expect(codes.at(-1)).toBe(429);
    h.clock.advance(61_000);
  });
});

describe('uploads (§4.2, §9.4)', () => {
  it('judges a file by its bytes, not its name', async () => {
    const { c } = await partnerWithAdmin();
    const res = await c.upload('/kyc/documents/pan', Buffer.from('MZ fake program'), 'pan.pdf');
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('FILE_TYPE_NOT_ALLOWED');
  });

  it('blocks infected files and files over 10 MB', async () => {
    const { c } = await partnerWithAdmin();
    const eicar = Buffer.concat([PDF, Buffer.from('EICAR-STANDARD-ANTIVIRUS-TEST-FILE')]);
    expect((await c.upload('/kyc/documents/pan', eicar)).body.code).toBe('FILE_INFECTED');
    const big = Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024 + 1)]);
    const res = await c.upload('/kyc/documents/pan', big);
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('FILE_TOO_LARGE');
  });

  it('removes location and camera data from photos', async () => {
    const { c } = await partnerWithAdmin();
    const photo = await sharp({ create: { width: 40, height: 40, channels: 3, background: 'red' } })
      .withExif({ IFD0: { Copyright: 'SECRET-EXIF-MARKER' } }).jpeg().toBuffer();
    expect(photo.includes('SECRET-EXIF-MARKER')).toBe(true);
    expect((await c.upload('/kyc/documents/pan', photo, 'pan.jpg')).status).toBe(204);
    const { body } = await c.get('/kyc');
    const link = await c.get(`/kyc/documents/${body.documents[0].id}/url`);
    const file = await c.agent.get(link.body.url).buffer(true).parse((res, done) => {
      const chunks: Buffer[] = [];
      res.on('data', (d: Buffer) => chunks.push(d));
      res.on('end', () => done(null, Buffer.concat(chunks)));
    });
    expect(file.status).toBe(200);
    expect((file.body as Buffer).includes('SECRET-EXIF-MARKER')).toBe(false);
  });

  it('stores files encrypted, under random names, outside any public path', async () => {
    const { c } = await partnerWithAdmin();
    await c.upload('/kyc/documents/pan', PDF, 'my-secret-pan.pdf');
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => {
      const p = join(d, f);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
    const files = walk(h.storageDir);
    expect(files.length).toBeGreaterThan(0);
    expect(files.join()).not.toContain('my-secret-pan');
    for (const f of files) expect(readFileSync(f).includes('fake test document')).toBe(false);
  });

  it('download links expire in 5 minutes and can not be forged', async () => {
    const { c } = await partnerWithAdmin();
    await c.upload('/kyc/documents/pan', PDF);
    const doc = (await c.get('/kyc')).body.documents[0];
    const { url } = (await c.get(`/kyc/documents/${doc.id}/url`)).body;
    const anyone = await client(h);
    const file = await anyone.agent.get(url);
    expect(file.status).toBe(200);
    expect(file.headers['content-disposition']).toMatch(/^attachment/);
    expect(file.headers['cache-control']).toBe('no-store');
    expect((await anyone.agent.get(`${url.slice(0, -2)}00`)).status).toBe(403);
    h.clock.advance(5 * 60_000 + 1);
    expect((await anyone.agent.get(url)).status).toBe(403);
  });

  it('another partner can not get a link to my document', async () => {
    const a = await partnerWithAdmin();
    const b = await partnerWithAdmin();
    await a.c.upload('/kyc/documents/pan', PDF);
    const doc = (await a.c.get('/kyc')).body.documents[0];
    expect((await b.c.get(`/kyc/documents/${doc.id}/url`)).status).toBe(404);
  });

  it('only the partner Admin handles KYC', async () => {
    const { partnerId } = await partnerWithAdmin();
    const exec = await signedIn(h, (await createUser(h.db, partnerId, 'executive')).email);
    expect((await exec.get('/kyc')).status).toBe(403);
    expect((await exec.upload('/kyc/documents/pan', PDF)).status).toBe(403);
  });
});

describe('agreement and submission (§4.1, §4.2)', () => {
  it('needs the agreement and every required document', async () => {
    const { c, partnerId, admin } = await partnerWithAdmin();
    expect((await c.post('/kyc/submit')).body.code).toBe('AGREEMENT_REQUIRED');
    expect((await c.post('/partner/agreement', { version: 'old' })).status).toBe(409);
    expect((await c.post('/partner/agreement', { version: AGREEMENT_VERSION })).status).toBe(204);
    const { rows } = await h.db.query('SELECT accepted_by, document_hash FROM partner_agreement WHERE partner_id = $1', [partnerId]);
    expect(rows[0].accepted_by).toBe(admin.id);
    expect(rows[0].document_hash).toHaveLength(64);
    expect((await c.post('/kyc/submit')).body.code).toBe('KYC_INCOMPLETE');
  });

  it('locks uploads once submitted', async () => {
    const { c } = await partnerWithAdmin();
    await readyToSubmit(c);
    expect((await c.post('/kyc/submit')).status).toBe(204);
    expect((await c.get('/kyc')).body.status).toBe('submitted');
    expect((await c.upload('/kyc/documents/pan', PDF)).body.code).toBe('KYC_LOCKED');
    expect((await c.post('/kyc/submit')).status).toBe(409);
  });
});

describe('ops review (§4.2, §4.13)', () => {
  async function submitted() {
    const p = await partnerWithAdmin();
    await readyToSubmit(p.c);
    await p.c.post('/kyc/submit');
    const { body } = await reviewer.get(`/ops/partners/${p.partnerId}`);
    return { ...p, docs: body.documents as { id: string; type: string }[] };
  }

  it('approves a partner once every document is approved, and tells the admin', async () => {
    const { c, partnerId, docs, admin } = await submitted();
    const queue = await reviewer.get('/ops/partners?kycStatus=submitted');
    expect(queue.body.data.map((p: { id: string }) => p.id)).toContain(partnerId);
    expect((await reviewer.post(`/ops/partners/${partnerId}/kyc-decision`, { decision: 'approved' })).body.code).toBe('KYC_REVIEW_INCOMPLETE');
    for (const d of docs) {
      expect((await reviewer.post(`/ops/kyc/documents/${d.id}/review`, { decision: 'approved' })).status).toBe(204);
    }
    expect((await reviewer.post(`/ops/partners/${partnerId}/kyc-decision`, { decision: 'approved' })).status).toBe(204);
    expect((await c.get('/kyc')).body.status).toBe('approved');
    expect((await c.get('/me')).body.partner.status).toBe('active');
    await new Promise((r) => setImmediate(r));
    expect(h.mail.messages.find((m) => m.to === admin.email && /approved/.test(m.subject))).toBeTruthy();
  });

  it('a rejection needs a note, shows it, and only that document is replaced', async () => {
    const { c, partnerId, docs } = await submitted();
    const [bad, ...good] = docs;
    expect((await reviewer.post(`/ops/kyc/documents/${bad!.id}/review`, { decision: 'rejected' })).body.code).toBe('NOTE_REQUIRED');
    await reviewer.post(`/ops/kyc/documents/${bad!.id}/review`, { decision: 'rejected', note: 'Photo is blurred' });
    for (const d of good) await reviewer.post(`/ops/kyc/documents/${d.id}/review`, { decision: 'approved' });
    expect((await reviewer.post(`/ops/partners/${partnerId}/kyc-decision`, { decision: 'rejected' })).status).toBe(204);

    const seen = (await c.get('/kyc')).body;
    expect(seen.status).toBe('rejected');
    expect(seen.documents.find((d: { id: string }) => d.id === bad!.id).reviewerNote).toBe('Photo is blurred');
    expect((await c.upload(`/kyc/documents/${good[0]!.type}`, PDF)).body.code).toBe('KYC_DOCUMENT_APPROVED');
    expect((await c.post('/kyc/submit')).body.code).toBe('KYC_INCOMPLETE');
    expect((await c.upload(`/kyc/documents/${bad!.type}`, PDF)).status).toBe(204);
    expect((await c.post('/kyc/submit')).status).toBe(204);
  });

  it('every review is audited', async () => {
    const { docs, partnerId } = await submitted();
    await reviewer.post(`/ops/kyc/documents/${docs[0]!.id}/review`, { decision: 'approved' });
    const { rows } = await h.db.query(`SELECT 1 FROM audit_log WHERE partner_id = $1 AND action = 'kyc.document_reviewed'`, [partnerId]);
    expect(rows).toHaveLength(1);
  });

  it('keeps the two sign-ins apart', async () => {
    const staff = await createUser(h.db, null, 'kyc_reviewer');
    const partnerUser = await createUser(h.db, await createPartner(h.db), 'viewer');
    expect((await (await client(h)).login(staff.email)).status).toBe(401);
    const res = await (await client(h)).post('/ops/auth/login', { email: partnerUser.email, password: 'correct-horse-battery-9' });
    expect(res.status).toBe(401);
  });

  it('makes staff finish two-step before anything else', async () => {
    const staff = await createUser(h.db, null, 'kyc_reviewer');
    const c = await client(h);
    const res = await c.post('/ops/auth/login', { email: staff.email, password: 'correct-horse-battery-9' });
    expect(res.body.mfaState).toBe('enroll');
    expect((await c.get('/ops/partners')).status).toBe(403);
  });
});

describe('database guarantees', () => {
  let app: pg.Pool;
  let ops: pg.Pool;
  beforeAll(() => {
    app = new pg.Pool({ connectionString: process.env.TEST_APP_URL, max: 2 });
    ops = new pg.Pool({ connectionString: process.env.TEST_OPS_URL, max: 2 });
  });
  afterAll(async () => {
    await app.end();
    await ops.end();
  });

  async function tenant<T>(id: string, fn: (c: pg.PoolClient) => Promise<T>) {
    const c = await app.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.partner_id', $1, true)`, [id]);
      return await fn(c);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  }

  it('a partner can not approve its own KYC, even with direct database access', async () => {
    const id = await createPartner(h.db);
    await expect(tenant(id, (c) => c.query(`UPDATE partner SET kyc_status = 'approved'`))).rejects.toThrow(/permission denied/);
    await expect(tenant(id, (c) => c.query(
      `INSERT INTO kyc_document (id, partner_id, type, object_key, file_name, mime, sha256, submitted_at, status)
       VALUES (gen_random_uuid(), $1, 'pan', 'k', 'f', 'm', 's', now(), 'approved')`, [id],
    ))).rejects.toThrow(/permission denied/);
    await expect(tenant(id, (c) => c.query(`UPDATE kyc_document SET status = 'approved'`))).rejects.toThrow(/permission denied/);
  });

  it('a partner can not delete an approved document', async () => {
    const id = await createPartner(h.db);
    await h.db.query(
      `INSERT INTO kyc_document (id, partner_id, type, object_key, file_name, mime, sha256, submitted_at, status)
       VALUES (gen_random_uuid(), $1, 'pan', 'k', 'f', 'm', 's', now(), 'approved')`, [id],
    );
    const res = await tenant(id, (c) => c.query('DELETE FROM kyc_document'));
    expect(res.rowCount).toBe(0);
  });

  it('the ops role can not read customers, password hashes or MFA secrets', async () => {
    await expect(ops.query('SELECT * FROM applicant')).rejects.toThrow(/permission denied/);
    await expect(ops.query('SELECT * FROM case_draft')).rejects.toThrow(/permission denied/);
    await expect(ops.query('SELECT password_hash FROM app_user')).rejects.toThrow(/permission denied/);
    await expect(ops.query('SELECT mfa_secret_enc FROM app_user')).rejects.toThrow(/permission denied/);
    await expect(ops.query(`UPDATE audit_log SET action = 'x'`)).rejects.toThrow(/permission denied/);
  });
});
