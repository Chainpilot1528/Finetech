import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OPEN_STATUSES, TERMINAL_STATUSES, assertTransition, nextStatuses } from '../src/modules/cases/domain/lifecycle.js';
import { csvCell, maskEmail, maskName, maskPhone } from '../src/modules/cases/domain/masking.js';
import {
  PDF, createLender, createPartner, createUser, disburse, enableProducts, harness, makeCase, opsMove, opsSession, opsVersion, signedIn,
  toDisbursing, utr, type Client, type Harness,
} from './helpers.js';

let h: Harness;
let lender: string;
let partnerId: string;
let admin: Client;
let exec: Client;
let otherExec: Client;
let viewer: Client;
let ops: Client;
let lead: Client;
let execId: string;

const month = () => new Date(h.clock.now().getTime() + 330 * 60_000).toISOString().slice(0, 7);
const partnerMove = async (c: Client, id: string, body: object) => {
  const version = String((await c.get(`/cases/${id}`)).body.version);
  return c.post(`/cases/${id}/transitions`, body).set('if-match', version);
};

beforeAll(async () => {
  h = await harness();
  lender = await createLender(h.db);
  partnerId = await createPartner(h.db, {}, 'approved');
  await enableProducts(h.db, partnerId);
  const e = await createUser(h.db, partnerId, 'executive');
  execId = e.id;
  exec = await signedIn(h, e.email);
  otherExec = await signedIn(h, (await createUser(h.db, partnerId, 'executive')).email);
  admin = await signedIn(h, (await createUser(h.db, partnerId, 'admin')).email);
  viewer = await signedIn(h, (await createUser(h.db, partnerId, 'viewer')).email);
  ops = await opsSession(h, 'ops_agent');
  lead = await opsSession(h, 'ops_lead');
});
afterAll(() => h.close());

describe('lifecycle rules (§4.6)', () => {
  it('terminal states go nowhere, for anyone', () => {
    for (const s of [...TERMINAL_STATUSES, 'DISBURSED']) {
      expect(nextStatuses(s, 'ops', null)).toEqual([]);
      expect(nextStatuses(s, 'partner', null)).toEqual([]);
    }
  });
  it('partners can only withdraw, or answer a relook', () => {
    for (const s of OPEN_STATUSES.filter((x) => x !== 'RELOOK')) expect(nextStatuses(s, 'partner', null)).toEqual(['WITHDRAWN']);
    expect(nextStatuses('RELOOK', 'partner', 'IN_REVIEW')).toEqual(['IN_REVIEW', 'WITHDRAWN']);
  });
  it('nobody can jump a stage or set DISBURSED directly', () => {
    expect(() => assertTransition('REGISTERED', 'APPROVED', 'ops', null)).toThrow();
    expect(() => assertTransition('DISBURSAL_IN_PROGRESS', 'DISBURSED', 'ops', null)).toThrow();
    expect(() => assertTransition('DISBURSED', 'REVERSED', 'ops', null)).toThrow();
  });
  it('masks names, phones and emails', () => {
    expect(maskName('Ravi Kumar')).toBe('R*** K****');
    expect(maskPhone('9876543210')).toBe('******3210');
    expect(maskEmail('ravi@example.test')).toBe('r***@example.test');
  });
  it('stops a spreadsheet running a cell as a formula', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+91')).toBe(`"'+91"`);
  });
});

describe('All Cases (§4.5)', () => {
  let mine: Awaited<ReturnType<typeof makeCase>>;
  let theirs: Awaited<ReturnType<typeof makeCase>>;
  beforeAll(async () => {
    mine = await makeCase(h, exec, lender, { name: 'Sunita Sharma', phone: '9811122334' });
    theirs = await makeCase(h, otherExec, lender);
  });

  it('an Executive sees only their own cases', async () => {
    const ids = (await exec.get('/cases?limit=100')).body.data.map((c: { id: string }) => c.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(theirs.id);
    expect((await exec.get(`/cases/${theirs.id}`)).status).toBe(404);
  });

  it('Admin and Viewer see the whole organisation', async () => {
    for (const c of [admin, viewer]) {
      const ids = (await c.get('/cases?limit=100')).body.data.map((x: { id: string }) => x.id);
      expect(ids).toEqual(expect.arrayContaining([mine.id, theirs.id]));
    }
  });

  it("another partner's cases simply don't exist", async () => {
    const pid = await createPartner(h.db, {}, 'approved');
    const c = await signedIn(h, (await createUser(h.db, pid, 'viewer')).email);
    expect((await c.get('/cases')).body.data).toEqual([]);
    expect((await c.get(`/cases/${mine.id}`)).status).toBe(404);
  });

  it('shows the applicant masked, in the list and on the case', async () => {
    const list = await admin.get(`/cases?q=${mine.caseNo}`);
    expect(JSON.stringify(list.body)).not.toContain('Sunita');
    expect(list.body.data[0].applicant).toBe('S***** S*****');
    const detail = await admin.get(`/cases/${mine.id}`);
    expect(JSON.stringify(detail.body)).not.toContain('Sunita');
    expect(JSON.stringify(detail.body)).not.toContain('9811122334');
    expect(detail.body.applicant.phone).toBe('******2334');
  });

  it('finds a case by case ID, phone suffix, full phone and vehicle number', async () => {
    for (const q of [mine.caseNo.slice(-6), '2334', '9811122334', mine.registration, mine.registration.toLowerCase()]) {
      const ids = (await admin.get(`/cases?limit=100&q=${q}`)).body.data.map((c: { id: string }) => c.id);
      expect(ids, q).toContain(mine.id);
    }
    expect((await admin.get('/cases?q=NOTHING-MATCHES')).body.data).toEqual([]);
  });

  it('treats % in a search as a plain character', async () => {
    expect((await admin.get('/cases?q=%25')).body.data).toEqual([]);
  });

  it('pages and filters on the server', async () => {
    const page = await admin.get('/cases?limit=1&page=2');
    expect(page.body.data).toHaveLength(1);
    expect(page.body.pagination.totalItems).toBeGreaterThanOrEqual(2);
    expect((await admin.get('/cases?limit=101')).status).toBe(422);
    expect((await admin.get('/cases?bucket=disbursed&product=personal')).body.data).toEqual([]);
    expect((await admin.get('/cases?product=used_car,personal')).body.data.length).toBeGreaterThan(0);
    expect((await admin.get(`/cases?registrationMonth=${month()}`)).body.data.length).toBeGreaterThan(0);
    expect((await admin.get('/cases?registrationMonth=2020-01')).body.data).toEqual([]);
  });
});

describe('export (§4.5)', () => {
  it('gives Admin a masked CSV, and audits it', async () => {
    await makeCase(h, exec, lender, { name: 'Export Person' });
    const res = await admin.post('/cases/export', {});
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text).toContain('E***** P*****');
    expect(res.text).not.toContain('Export Person');
    const audit = await h.db.query(`SELECT 1 FROM audit_log WHERE partner_id = $1 AND action = 'case.exported'`, [partnerId]);
    expect(audit.rowCount).toBeGreaterThan(0);
  });
  it('is refused for Executive and Viewer', async () => {
    expect((await exec.post('/cases/export', {})).status).toBe(403);
    expect((await viewer.post('/cases/export', {})).status).toBe(403);
  });
});

describe('moving a case', () => {
  it('runs from Registered to Disbursed, writing history at every step', async () => {
    const c = await makeCase(h, exec, lender);
    await toDisbursing(ops, c.id, lender);
    const done = await disburse(h, ops, c.id, 400000);
    expect(done.status).toBe(201);
    const detail = (await exec.get(`/cases/${c.id}`)).body;
    expect(detail.status).toBe('DISBURSED');
    expect(detail.history.map((x: { toStatus: string }) => x.toStatus)).toEqual(
      ['REGISTERED', 'IN_REVIEW', 'APPROVED', 'CUSTOMER_APPROVED', 'DISBURSAL_IN_PROGRESS', 'DISBURSED'],
    );
    expect(detail.history[1].actor).toBe('Vittora team');
    expect(detail.sanctionedAmountPaise).toBe(40000000);
    expect(detail.allowedTransitions).toEqual([]);
  });

  it('needs the input each step asks for', async () => {
    const c = await makeCase(h, exec, lender);
    expect((await opsMove(ops, c.id, { to: 'IN_REVIEW' })).body.code).toBe('LENDER_REQUIRED');
    await opsMove(ops, c.id, { to: 'IN_REVIEW', lenderId: lender });
    expect((await opsMove(ops, c.id, { to: 'APPROVED', sanctionedAmount: 100 })).body.code).toBe('SANCTION_REQUIRED');
    expect((await opsMove(ops, c.id, { to: 'RELOOK' })).body.code).toBe('NOTE_REQUIRED');
    expect((await opsMove(ops, c.id, { to: 'REJECTED', note: 'no' })).body.code).toBe('REASON_REQUIRED');
    await opsMove(ops, c.id, { to: 'APPROVED', sanctionedAmount: 300000, roiBps: 1200, tenureMonths: 36 });
    await opsMove(ops, c.id, { to: 'CUSTOMER_APPROVED' });
    expect((await opsMove(ops, c.id, { to: 'DISBURSAL_IN_PROGRESS' })).body.code).toBe('CHECKLIST_REQUIRED');
  });

  it('refuses an illegal jump on the server', async () => {
    const c = await makeCase(h, exec, lender);
    const res = await opsMove(ops, c.id, { to: 'DISBURSED' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INVALID_TRANSITION');
  });

  it('refuses a stale version, and needs one at all', async () => {
    const c = await makeCase(h, exec, lender);
    const version = await opsVersion(ops, c.id);
    await opsMove(ops, c.id, { to: 'IN_REVIEW', lenderId: lender });
    const stale = await ops.post(`/ops/cases/${c.id}/transitions`, { to: 'RELOOK', note: 'x' }).set('if-match', version);
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('VERSION_CONFLICT');
    expect((await ops.post(`/ops/cases/${c.id}/transitions`, { to: 'RELOOK', note: 'x' })).status).toBe(428);
  });

  it('a relook goes back to the partner, and returns to the stage it left', async () => {
    const c = await makeCase(h, exec, lender);
    await opsMove(ops, c.id, { to: 'IN_REVIEW', lenderId: lender });
    await opsMove(ops, c.id, { to: 'RELOOK', note: 'Bank statement is unreadable' });
    const needs = (await exec.get('/cases?bucket=needs_action&limit=100')).body.data.map((x: { id: string }) => x.id);
    expect(needs).toContain(c.id);
    expect((await exec.get(`/cases/${c.id}`)).body.allowedTransitions).toEqual(['IN_REVIEW', 'WITHDRAWN']);
    expect((await partnerMove(exec, c.id, { to: 'APPROVED', note: 'done' })).status).toBe(409);
    expect((await partnerMove(exec, c.id, { to: 'IN_REVIEW', note: 'New statement uploaded' })).status).toBe(200);
    expect((await exec.get(`/cases/${c.id}`)).body.status).toBe('IN_REVIEW');
  });

  it('a partner can withdraw with a reason, and a Viewer can not', async () => {
    const c = await makeCase(h, exec, lender);
    expect((await viewer.post(`/cases/${c.id}/transitions`, { to: 'WITHDRAWN', note: 'x' }).set('if-match', '1')).status).toBe(403);
    expect((await partnerMove(exec, c.id, { to: 'WITHDRAWN', note: 'Customer changed mind' })).body.code).toBe('REASON_REQUIRED');
    expect((await partnerMove(exec, c.id, { to: 'WITHDRAWN', reasonCode: 'CUSTOMER_REQUEST', note: 'Customer changed mind' })).status).toBe(200);
    expect((await partnerMove(exec, c.id, { to: 'WITHDRAWN', reasonCode: 'X', note: 'again' })).status).toBe(409);
  });

  it('an Executive can not move a colleague\'s case', async () => {
    const c = await makeCase(h, exec, lender);
    expect((await otherExec.post(`/cases/${c.id}/transitions`, { to: 'WITHDRAWN', reasonCode: 'X', note: 'n' }).set('if-match', '1')).status).toBe(404);
  });

  it('history can not be edited, even by the app', async () => {
    const app = new pg.Client({ connectionString: process.env.TEST_APP_URL });
    await app.connect();
    await expect(app.query(`UPDATE case_status_history SET note = 'x'`)).rejects.toThrow(/permission denied/);
    await app.end();
  });
});

describe('disbursals (§4.6)', () => {
  it('stays in progress until a tranche is final', async () => {
    const c = await makeCase(h, exec, lender);
    await toDisbursing(ops, c.id, lender);
    expect((await disburse(h, ops, c.id, 150000, false)).body.trancheNo).toBe(1);
    expect((await exec.get(`/cases/${c.id}`)).body.status).toBe('DISBURSAL_IN_PROGRESS');
    expect((await disburse(h, ops, c.id, 250000, true)).body.trancheNo).toBe(2);
    const detail = (await exec.get(`/cases/${c.id}`)).body;
    expect(detail.status).toBe('DISBURSED');
    expect(detail.disbursals).toHaveLength(2);
  });

  it('refuses more than was sanctioned, a reused UTR and a future date', async () => {
    const c = await makeCase(h, exec, lender);
    await toDisbursing(ops, c.id, lender);
    expect((await disburse(h, ops, c.id, 400001)).body.code).toBe('OVER_SANCTIONED');
    const today = h.clock.now().toISOString().slice(0, 10);
    const v = await opsVersion(ops, c.id);
    const ref = utr();
    await ops.post(`/ops/cases/${c.id}/disbursals`, { utr: ref, amount: 1000, disbursedOn: today, isFinal: false }).set('if-match', v);
    const v2 = await opsVersion(ops, c.id);
    const again = await ops.post(`/ops/cases/${c.id}/disbursals`, { utr: ref, amount: 1000, disbursedOn: today, isFinal: false }).set('if-match', v2);
    expect(again.body.code).toBe('UTR_DUPLICATE');
    const late = await ops.post(`/ops/cases/${c.id}/disbursals`, { utr: utr(), amount: 1000, disbursedOn: '2099-01-01', isFinal: false }).set('if-match', v2);
    expect(late.body.code).toBe('DATE_IN_FUTURE');
  });

  it('a case with money paid out can not be rejected or withdrawn', async () => {
    const c = await makeCase(h, exec, lender);
    await toDisbursing(ops, c.id, lender);
    await disburse(h, ops, c.id, 1000, false);
    expect((await opsMove(ops, c.id, { to: 'REJECTED', reasonCode: 'X', note: 'n' })).body.code).toBe('HAS_DISBURSALS');
    expect((await partnerMove(exec, c.id, { to: 'WITHDRAWN', reasonCode: 'X', note: 'n' })).body.code).toBe('HAS_DISBURSALS');
  });
});

describe('notes, documents and contact details', () => {
  it('a repeated note request saves one note, and notes are encrypted', async () => {
    const c = await makeCase(h, exec, lender);
    const key = randomUUID();
    for (let i = 0; i < 2; i += 1) expect((await exec.post(`/cases/${c.id}/notes`, { body: 'Called the customer' }).set('idempotency-key', key)).status).toBe(201);
    const detail = (await exec.get(`/cases/${c.id}`)).body;
    expect(detail.notes.map((n: { body: string }) => n.body)).toEqual(['Called the customer']);
    const raw = await h.db.query('SELECT body_enc FROM case_note WHERE case_id = $1', [c.id]);
    expect(raw.rows[0].body_enc).not.toContain('Called');
    expect((await viewer.post(`/cases/${c.id}/notes`, { body: 'x' }).set('idempotency-key', randomUUID())).status).toBe(403);
  });

  it('accepts more documents while open, and gives a link to read them', async () => {
    const c = await makeCase(h, exec, lender);
    expect((await exec.upload(`/cases/${c.id}/documents`, PDF, 'extra.pdf')).status).toBe(204);
    const detail = (await exec.get(`/cases/${c.id}`)).body;
    const doc = detail.documents.find((d: { fileName: string }) => d.fileName === 'extra.pdf');
    const link = await exec.get(`/cases/${c.id}/documents/${doc.id}/url`);
    expect(link.body.url).toContain('/files/');
    await partnerMove(exec, c.id, { to: 'WITHDRAWN', reasonCode: 'X', note: 'n' });
    expect((await exec.upload(`/cases/${c.id}/documents`, PDF)).body.code).toBe('CASE_CLOSED');
  });

  it('revealing needs a reason, is logged, and the audit row holds no free text', async () => {
    const c = await makeCase(h, exec, lender, { phone: '9822233445' });
    expect((await exec.post(`/cases/${c.id}/pii-reveal`, { field: 'phone', reason: 'x' })).status).toBe(422);
    const res = await exec.post(`/cases/${c.id}/pii-reveal`, { field: 'phone', reason: 'Calling about documents' });
    expect(res.body.value).toBe('9822233445');
    const log = await h.db.query('SELECT actor_id, reason FROM pii_reveal_log WHERE partner_id = $1 ORDER BY at DESC LIMIT 1', [partnerId]);
    expect(log.rows[0]).toEqual({ actor_id: execId, reason: 'Calling about documents' });
    const audit = await h.db.query(`SELECT reason, after FROM audit_log WHERE action = 'pii.revealed' AND entity_id = $1`, [c.id]);
    expect(audit.rows[0].reason).toBeNull();
    expect(JSON.stringify(audit.rows[0].after)).not.toContain('Calling');
    expect((await viewer.post(`/cases/${c.id}/pii-reveal`, { field: 'phone', reason: 'just looking' })).status).toBe(403);
  });

  it('with masking off, roles that may reveal see contact details, and a Viewer still does not', async () => {
    const pid = await createPartner(h.db, {}, 'approved');
    await enableProducts(h.db, pid);
    const a = await signedIn(h, (await createUser(h.db, pid, 'admin')).email);
    const v = await signedIn(h, (await createUser(h.db, pid, 'viewer')).email);
    const c = await makeCase(h, a, lender, { phone: '9833344556' });
    expect((await a.patch('/partner', { maskCustomerContact: false })).status).toBe(200);
    expect((await a.get(`/cases/${c.id}`)).body.applicant.phone).toBe('9833344556');
    expect((await v.get(`/cases/${c.id}`)).body.applicant.phone).toBe('******4556');
  });
});

describe('notifications (§4.11)', () => {
  it('tells the case owner, with ids and codes only', async () => {
    const c = await makeCase(h, exec, lender, { name: 'Private Person' });
    await opsMove(ops, c.id, { to: 'IN_REVIEW', lenderId: lender });
    await opsMove(ops, c.id, { to: 'RELOOK', note: 'Need the bank statement' });
    const res = await exec.get('/notifications');
    const mine = res.body.data.filter((n: { payload: { caseId: string } }) => n.payload.caseId === c.id);
    expect(mine[0].type).toBe('pending_documentation');
    expect(JSON.stringify(mine)).not.toContain('Private');
    expect(res.body.unreadCount).toBeGreaterThan(0);
    await new Promise((r) => setImmediate(r));
    const mail = h.mail.messages.find((m) => m.subject.includes(c.caseNo));
    expect(mail?.subject).toContain('Needs your action');
    expect(mail?.text).not.toContain('Private');
  });

  it('marks read, and only ever touches your own', async () => {
    const before = (await exec.get('/notifications')).body;
    const adminBefore = (await admin.get('/notifications')).body.unreadCount;
    await exec.post('/notifications/read', { ids: [before.data[0].id] });
    expect((await exec.get('/notifications')).body.unreadCount).toBe(before.unreadCount - 1);
    await exec.post('/notifications/read', {});
    expect((await exec.get('/notifications')).body.unreadCount).toBe(0);
    expect((await admin.get('/notifications')).body.unreadCount).toBe(adminBefore);
  });

  it('respects a person\'s email preference', async () => {
    const off = Object.fromEntries(['approval', 'rejection', 'pending_documentation', 'new_case', 'any_status'].map((e) => [e, { email: false, inApp: true }]));
    const u = await createUser(h.db, partnerId, 'executive');
    const quiet = await signedIn(h, u.email);
    expect((await quiet.patch('/partner/notification-prefs', { prefs: off })).status).toBe(200);
    const c = await makeCase(h, quiet, lender);
    await opsMove(ops, c.id, { to: 'IN_REVIEW', lenderId: lender });
    await opsMove(ops, c.id, { to: 'RELOOK', note: 'x' });
    await new Promise((r) => setImmediate(r));
    expect(h.mail.messages.filter((m) => m.to === u.email && m.subject.includes(c.caseNo))).toEqual([]);
    expect((await quiet.get('/notifications')).body.unreadCount).toBeGreaterThan(0);
    expect((await quiet.patch('/partner/notification-prefs', { prefs: { unknown: { email: true, inApp: true } } })).status).toBe(422);
  });
});

describe('dashboard (§4.3, §5)', () => {
  it('counts match the list a tile links to', async () => {
    const pid = await createPartner(h.db, {}, 'approved');
    await enableProducts(h.db, pid);
    const a = await signedIn(h, (await createUser(h.db, pid, 'admin')).email);
    const e = await signedIn(h, (await createUser(h.db, pid, 'executive')).email);
    const one = await makeCase(h, a, lender);
    const two = await makeCase(h, e, lender);
    const three = await makeCase(h, e, lender);
    await toDisbursing(ops, one.id, lender);
    await disburse(h, ops, one.id, 400000);
    await opsMove(ops, two.id, { to: 'IN_REVIEW', lenderId: lender });
    await opsMove(ops, two.id, { to: 'REJECTED', reasonCode: 'POLICY', note: 'Income too low' });
    await opsMove(ops, three.id, { to: 'RELOOK', note: 'Missing page' });

    const d = (await a.get(`/dashboard/summary?month=${month()}`)).body;
    expect(d.registered).toBe(3);
    expect(d.stages).toEqual([
      { key: 'registered', count: 1 }, { key: 'in_review', count: 0 }, { key: 'approved', count: 0 }, { key: 'disbursing', count: 0 }, { key: 'disbursed', count: 1 },
    ]);
    expect(d.needsAction).toBe(1);
    expect(d.approval).toEqual({ approved: 1, decided: 2, ratePct: 50 });
    expect(d.revenue.amountPaise).toBe(40000000);
    expect(d.revenue.byProduct[0].product).toBe('used_car');
    expect(d.recent).toHaveLength(3);
    expect((await a.get('/cases?bucket=needs_action')).body.pagination.totalItems).toBe(d.needsAction);

    const own = (await e.get(`/dashboard/summary?month=${month()}`)).body;
    expect(own.registered).toBe(2);
    expect(own.revenue.amountPaise).toBe(0);
    expect(own.commission).toBeNull();
    expect((await a.get(`/dashboard/summary?month=${month()}&product=personal`)).body.registered).toBe(0);
    expect((await a.get('/dashboard/summary?month=2020-01')).body.registered).toBe(0);
  });

  it('uses India time for month boundaries', async () => {
    const pid = await createPartner(h.db, {}, 'approved');
    await enableProducts(h.db, pid);
    const a = await signedIn(h, (await createUser(h.db, pid, 'admin')).email);
    const c = await makeCase(h, a, lender);
    // 31 Jan 20:00 UTC is already 1 Feb in India.
    await h.db.query(`UPDATE loan_case SET created_at = '2026-01-31T20:00:00Z' WHERE id = $1`, [c.id]);
    expect((await a.get('/dashboard/summary?month=2026-02')).body.registered).toBe(1);
    expect((await a.get('/dashboard/summary?month=2026-01')).body.registered).toBe(0);
  });

  it('needs a valid month', async () => {
    expect((await admin.get('/dashboard/summary?month=2026-13')).status).toBe(422);
  });
});

describe('ops queue (§4.13)', () => {
  it('lists cases oldest first with no customer identity, and flags duplicates', async () => {
    const c = await makeCase(h, exec, lender, { name: 'Hidden Name' });
    const queue = await ops.get('/ops/cases?status=REGISTERED&limit=100');
    expect(queue.body.data.some((r: { id: string }) => r.id === c.id)).toBe(true);
    const detail = await ops.get(`/ops/cases/${c.id}`);
    expect(detail.body.location.city).toBe('Delhi');
    expect(JSON.stringify(detail.body)).not.toContain('Hidden');
  });

  it('the ops database role can not read customer identity at all', async () => {
    const role = new pg.Client({ connectionString: process.env.TEST_OPS_URL });
    await role.connect();
    await expect(role.query('SELECT full_name_enc FROM applicant LIMIT 1')).rejects.toThrow(/permission denied/);
    await expect(role.query('SELECT phone_enc FROM applicant LIMIT 1')).rejects.toThrow(/permission denied/);
    await role.end();
  });

  it('agents take cases, leads assign them, and a taken case stays taken', async () => {
    const c = await makeCase(h, exec, lender);
    expect((await ops.post(`/ops/cases/${c.id}/take`)).status).toBe(204);
    const other = await opsSession(h, 'ops_agent');
    expect((await other.post(`/ops/cases/${c.id}/take`)).body.code).toBe('ALREADY_ASSIGNED');
    expect((await ops.post(`/ops/cases/${c.id}/assign`, { userId: randomUUID() })).status).toBe(403);
    const team = (await lead.get('/ops/staff')).body.data;
    expect((await lead.post(`/ops/cases/${c.id}/assign`, { userId: team[0].id })).status).toBe(204);
    expect((await lead.post(`/ops/cases/${c.id}/assign`, { userId: randomUUID() })).body.code).toBe('ASSIGNEE_INVALID');
  });

  it('auto-assign shares waiting cases across agents', async () => {
    await makeCase(h, exec, lender);
    const res = await lead.post('/ops/cases/auto-assign');
    expect(res.status).toBe(200);
    expect(res.body.assigned).toBeGreaterThan(0);
    expect((await lead.get('/ops/cases?assigned=none&status=REGISTERED')).body.data).toEqual([]);
  });

  it('partners can not reach the queue', async () => {
    expect((await admin.get('/ops/cases')).status).toBe(403);
  });
});
