import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PASSWORD, client, createLender, createPartner, createUser, enableProducts, harness, linkToken, makeCase, opsSession, signedIn, type Client, type Harness,
} from './helpers.js';

let h: Harness;
let partnerId: string;
let adminId: string;
let admin: Client;
let manager: Client;
let viewer: Client;
let lender: string;

const invite = (c: Client, over = {}) => c.post('/users/invite', { name: 'New Person', email: `new-${Math.random().toString(36).slice(2)}@example.test`, role: 'executive', ...over });
const BILLING = { gstRegistered: true, gstin: '07ABCDE1234F1Z5', pan: 'ABCDE1234F', bankAccount: '123456789012', ifsc: 'HDFC0001234', bankName: 'Test Bank', branch: 'Delhi' };

beforeAll(async () => {
  h = await harness();
  lender = await createLender(h.db);
  partnerId = await createPartner(h.db, {}, 'approved');
  await enableProducts(h.db, partnerId);
  const a = await createUser(h.db, partnerId, 'admin');
  adminId = a.id;
  admin = await signedIn(h, a.email);
  manager = await signedIn(h, (await createUser(h.db, partnerId, 'manager')).email);
  viewer = await signedIn(h, (await createUser(h.db, partnerId, 'viewer')).email);
});
afterAll(() => h.close());

describe('team (§4.9)', () => {
  it('an invited person sets their own password and can sign in', async () => {
    const res = await invite(admin);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('invited');
    await new Promise((r) => setImmediate(r));
    const mail = h.mail.messages.find((m) => m.to === res.body.email)!;
    const c = await client(h);
    expect((await c.login(res.body.email)).status).toBe(401);
    expect((await c.post('/auth/password/reset', { token: linkToken(mail.text), password: PASSWORD })).status).toBe(204);
    expect((await c.login(res.body.email)).status).toBe(200);
  });

  it('internal roles can never be assigned from a partner account', async () => {
    for (const role of ['ops_agent', 'ops_lead', 'finance', 'super_admin', 'kyc_reviewer']) {
      expect((await invite(admin, { role })).status, role).toBe(422);
    }
    const u = await createUser(h.db, partnerId, 'executive');
    expect((await admin.patch(`/users/${u.id}`, { role: 'super_admin' })).status).toBe(422);
  });

  it('there is no way to set a password for someone', async () => {
    const u = await createUser(h.db, partnerId, 'executive');
    expect((await admin.patch(`/users/${u.id}`, { password: 'Something-long-1' })).status).toBe(422);
  });

  it('an email already in use, in any organisation, is refused without saying where', async () => {
    const other = await createUser(h.db, await createPartner(h.db), 'viewer');
    const res = await invite(admin, { email: other.email });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('EMAIL_UNAVAILABLE');
  });

  it('a resent invite replaces the old link', async () => {
    const res = await invite(admin);
    await new Promise((r) => setImmediate(r));
    const first = h.mail.messages.find((m) => m.to === res.body.email)!;
    expect((await admin.post(`/users/${res.body.id}/resend-invite`)).status).toBe(204);
    await new Promise((r) => setImmediate(r));
    const c = await client(h);
    expect((await c.post('/auth/password/reset', { token: linkToken(first.text), password: PASSWORD })).status).toBe(400);
    const second = h.mail.messages.find((m) => m.to === res.body.email && m.text !== first.text)!;
    expect((await c.post('/auth/password/reset', { token: linkToken(second.text), password: PASSWORD })).status).toBe(204);
    expect((await admin.post(`/users/${res.body.id}/resend-invite`)).body.code).toBe('USER_NOT_INVITED');
  });

  it('changing a role signs that person out, so they get the new rules', async () => {
    const u = await createUser(h.db, partnerId, 'executive');
    const c = await signedIn(h, u.email);
    expect((await c.get('/me')).status).toBe(200);
    expect((await admin.patch(`/users/${u.id}`, { role: 'viewer' })).body.role).toBe('viewer');
    expect((await c.get('/me')).status).toBe(401);
  });

  it('an Admin can force someone out of all their sessions', async () => {
    const u = await createUser(h.db, partnerId, 'viewer');
    const c = await signedIn(h, u.email);
    expect((await admin.post(`/users/${u.id}/sign-out`)).status).toBe(204);
    expect((await c.get('/me')).status).toBe(401);
  });

  it('a deactivated person is out at once, and can come back', async () => {
    const u = await createUser(h.db, partnerId, 'viewer');
    const c = await signedIn(h, u.email);
    expect((await admin.post(`/users/${u.id}/deactivate`, {})).status).toBe(204);
    expect((await c.get('/me')).status).toBe(401);
    expect((await (await client(h)).login(u.email)).status).toBe(401);
    expect((await admin.post(`/users/${u.id}/reactivate`)).status).toBe(204);
    expect((await (await client(h)).login(u.email)).status).toBe(200);
  });

  it('open cases must go to someone else first', async () => {
    const leaver = await createUser(h.db, partnerId, 'executive');
    const c = await signedIn(h, leaver.email);
    const made = await makeCase(h, c, lender);
    const stays = await createUser(h.db, partnerId, 'executive');
    const staysSession = await signedIn(h, stays.email);
    const needs = await admin.post(`/users/${leaver.id}/deactivate`, {});
    expect(needs.status).toBe(409);
    expect(needs.body.code).toBe('REASSIGN_REQUIRED');
    const v = await createUser(h.db, partnerId, 'viewer');
    expect((await admin.post(`/users/${leaver.id}/deactivate`, { reassignTo: v.id })).body.code).toBe('REASSIGN_INVALID');
    expect((await admin.post(`/users/${leaver.id}/deactivate`, { reassignTo: stays.id })).status).toBe(204);
    expect((await staysSession.get(`/cases/${made.id}`)).status).toBe(200);
  });

  it('keeps at least one Admin, and you can not deactivate yourself', async () => {
    const pid = await createPartner(h.db);
    const only = await createUser(h.db, pid, 'admin');
    const a = await signedIn(h, only.email);
    expect((await a.post(`/users/${only.id}/deactivate`, {})).body.code).toBe('CANNOT_DEACTIVATE_SELF');
    expect((await a.patch(`/users/${only.id}`, { role: 'viewer' })).body.code).toBe('LAST_ADMIN');
    expect((await admin.post(`/users/${adminId}/deactivate`, {})).body.code).toBe('CANNOT_DEACTIVATE_SELF');
  });

  it('a user in another organisation can not be touched', async () => {
    const other = await createUser(h.db, await createPartner(h.db), 'executive');
    for (const res of [
      await admin.patch(`/users/${other.id}`, { role: 'viewer' }), await admin.post(`/users/${other.id}/deactivate`, {}),
      await admin.post(`/users/${other.id}/sign-out`), await admin.post(`/users/${other.id}/resend-invite`),
    ]) expect(res.status).toBe(404);
    const row = await h.db.query('SELECT role, status FROM app_user WHERE id = $1', [other.id]);
    expect(row.rows[0]).toEqual({ role: 'executive', status: 'active' });
  });

  it('only an Admin manages users, and every change is audited', async () => {
    expect((await invite(manager)).status).toBe(403);
    const res = await invite(admin);
    const audit = await h.db.query(`SELECT after FROM audit_log WHERE action = 'user.invited' AND entity_id = $1`, [res.body.id]);
    expect(audit.rows[0].after).toEqual({ role: 'executive' });
  });
});

describe('settings (§4.10)', () => {
  it('everyone can read company details, and only an Admin can edit', async () => {
    const res = await viewer.get('/partner');
    expect(res.status).toBe(200);
    expect(res.body.products.length).toBe(3);
    expect(res.body.maskCustomerContact).toBe(true);
    expect((await manager.patch('/partner', { city: 'Pune' })).status).toBe(403);
    expect((await admin.patch('/partner', { city: 'Pune', employeeBand: '6-10' })).body.city).toBe('Pune');
  });

  it('locked fields can not be changed', async () => {
    for (const body of [{ refCode: 'X' }, { channelName: 'X' }, { status: 'active' }, { kycStatus: 'approved' }, { features: {} }]) {
      expect((await admin.patch('/partner', body)).status).toBe(422);
    }
  });

  it('the app role can not change KYC or features even if the code tried', async () => {
    const { default: pg } = await import('pg');
    const role = new pg.Client({ connectionString: process.env.TEST_APP_URL });
    await role.connect();
    await expect(role.query(`UPDATE partner SET kyc_status = 'approved'`)).rejects.toThrow(/permission denied/);
    await role.end();
  });

  it('bank and PAN come back as last 4 only, and are encrypted at rest', async () => {
    const res = await admin.patch('/partner/billing', BILLING);
    expect(res.status).toBe(200);
    expect(res.body.billing).toMatchObject({ panLast4: '234F', bankLast4: '9012', verificationStatus: 'pending' });
    expect(JSON.stringify(res.body)).not.toContain(BILLING.bankAccount);
    const raw = await h.db.query('SELECT pan_enc, bank_acct_enc FROM partner_billing WHERE partner_id = $1', [partnerId]);
    expect(raw.rows[0].bank_acct_enc).not.toContain('1234567');
    expect(raw.rows[0].pan_enc).not.toContain('ABCDE');
  });

  it('checks the format of GSTIN, PAN, IFSC and account number', async () => {
    for (const bad of [{ pan: 'NOTAPAN' }, { ifsc: 'HDFC1234' }, { bankAccount: '12' }, { gstin: '12345' }]) {
      expect((await admin.patch('/partner/billing', { ...BILLING, ...bad })).status).toBe(422);
    }
    expect((await admin.patch('/partner/billing', { ...BILLING, gstin: undefined })).status).toBe(422);
  });

  it('editing verified details sends them back for checking', async () => {
    const reviewer = await opsSession(h, 'kyc_reviewer');
    await admin.patch('/partner/billing', BILLING);
    expect((await reviewer.post(`/ops/partners/${partnerId}/billing/decision`, { decision: 'rejected' })).body.code).toBe('NOTE_REQUIRED');
    expect((await reviewer.post(`/ops/partners/${partnerId}/billing/decision`, { decision: 'verified' })).status).toBe(204);
    expect((await admin.get('/partner')).body.billing.verificationStatus).toBe('verified');
    await admin.patch('/partner/billing', { ...BILLING, bankAccount: '999988887777' });
    const row = await h.db.query('SELECT verification_status, verified_by FROM partner_billing WHERE partner_id = $1', [partnerId]);
    expect(row.rows[0]).toEqual({ verification_status: 'pending', verified_by: null });
  });

  it('staff see the real numbers to check them, and each look is audited', async () => {
    const reviewer = await opsSession(h, 'kyc_reviewer');
    await admin.patch('/partner/billing', BILLING);
    const res = await reviewer.get(`/ops/partners/${partnerId}/billing`);
    expect(res.body.bankAccount).toBe(BILLING.bankAccount);
    const audit = await h.db.query(`SELECT 1 FROM audit_log WHERE action = 'billing.viewed' AND partner_id = $1`, [partnerId]);
    expect(audit.rowCount).toBeGreaterThan(0);
    await reviewer.post(`/ops/partners/${partnerId}/billing/decision`, { decision: 'rejected', note: 'Name does not match' });
    expect((await admin.get('/partner')).body.billing).toMatchObject({ verificationStatus: 'rejected', reviewerNote: 'Name does not match' });
  });
});
