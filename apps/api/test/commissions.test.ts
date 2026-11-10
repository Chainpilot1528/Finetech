import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyBps, breakdown, financialYear, invoiceNumber } from '../src/modules/commissions/domain/money.js';
import {
  createLender, createPartner, createUser, disburse, enableProducts, harness, makeCase, opsSession, opsVersion, signedIn, toDisbursing,
  type Client, type Harness,
} from './helpers.js';

let h: Harness;
let finance: Client;
let finance2: Client;
let ops: Client;
let reviewer: Client;

const BILLING = { gstRegistered: true, gstin: '07ABCDE1234F1Z5', pan: 'ABCDE1234F', bankAccount: '123456789012', ifsc: 'HDFC0001234', bankName: 'Test Bank', branch: 'Delhi' };

async function rateCard(lenderId: string, pctBps = 100, over = {}) {
  const made = await finance.post('/ops/rate-cards', { lenderId, product: 'used_car', slabMin: 0, pctBps, clawbackMonths: 6, validFrom: '2020-01-01', ...over });
  expect(made.status).toBe(201);
  const ok = await finance2.post(`/ops/rate-cards/${made.body.id}/decision`, { decision: 'active' });
  expect(ok.status).toBe(200);
  return made.body.id as string;
}

/** A partner with verified billing and a rate card, ready to earn. */
async function setup(gstRegistered = true) {
  const partnerId = await createPartner(h.db, {}, 'approved');
  await enableProducts(h.db, partnerId);
  const admin = await signedIn(h, (await createUser(h.db, partnerId, 'admin')).email);
  const lender = await createLender(h.db);
  await rateCard(lender);
  expect((await admin.patch('/partner/billing', { ...BILLING, gstRegistered })).status).toBe(200);
  expect((await reviewer.post(`/ops/partners/${partnerId}/billing/decision`, { decision: 'verified' })).status).toBe(204);
  return { partnerId, admin, lender };
}

async function disbursedInvoice(s: { admin: Client; lender: string }, amount = 400000) {
  const c = await makeCase(h, s.admin, s.lender, { amount });
  await toDisbursing(ops, c.id, s.lender, amount);
  await disburse(h, ops, c.id, amount);
  const list = (await s.admin.get('/invoices')).body.data;
  return { caseId: c.id, invoice: list.find((i: { caseId: string }) => i.caseId === c.id) };
}

const version = async (c: Client, id: string) => String((await c.get(`/invoices/${id}`)).body.version);
const raise = async (c: Client, id: string) => {
  const v = await version(c, id);
  return c.post(`/invoices/${id}/raise`).set('if-match', v);
};
const opsInvoice = async (id: string) => (await finance.get('/ops/invoices')).body.data.find((i: { id: string }) => i.id === id);
const opsPost = async (c: Client, id: string, action: string, body?: object) => {
  const v = String((await opsInvoice(id)).version);
  return c.post(`/ops/invoices/${id}/${action}`, body).set('if-match', v);
};

async function paid(s: { admin: Client }, id: string) {
  await raise(s.admin, id);
  await opsPost(finance, id, 'approve');
  await opsPost(finance, id, 'mark-paid', { payoutRef: 'NEFT-0001' });
  return opsPost(finance2, id, 'confirm-paid');
}

beforeAll(async () => {
  h = await harness();
  finance = await opsSession(h, 'finance');
  finance2 = await opsSession(h, 'finance');
  ops = await opsSession(h, 'ops_agent');
  reviewer = await opsSession(h, 'kyc_reviewer');
});
afterAll(() => h.close());

describe('money (§4.7)', () => {
  it('works out 1% commission with GST and TDS', () => {
    expect(breakdown(40000000n, 100, 1800, 200)).toEqual({ gross: 400000n, gst: 72000n, tds: 8000n, net: 464000n });
  });
  it('rounds half up, in whole paise', () => {
    expect(applyBps(50n, 100)).toBe(1n);
    expect(applyBps(49n, 100)).toBe(0n);
  });
  it('net always equals gross plus GST minus TDS', () => {
    fc.assert(fc.property(fc.bigInt({ min: 1n, max: 10n ** 12n }), fc.integer({ min: 1, max: 1000 }), fc.integer({ min: 0, max: 2800 }), fc.integer({ min: 0, max: 1000 }), (amount, rate, gst, tds) => {
      const b = breakdown(amount, rate, gst, tds);
      return b.net === b.gross + b.gst - b.tds && b.gross >= 0n;
    }));
  });
  it('uses the April to March year in India time', () => {
    expect(financialYear(new Date('2027-03-15T00:00:00Z'))).toBe('2026-27');
    expect(financialYear(new Date('2027-03-31T19:00:00Z'))).toBe('2027-28');
    expect(financialYear(new Date('2099-12-01T00:00:00Z'))).toBe('2099-00');
    expect(invoiceNumber('2026-27', 12)).toBe('INV/2026-27/000012');
  });
});

describe('rate cards', () => {
  it('need a second person to approve them', async () => {
    const lender = await createLender(h.db);
    const made = await finance.post('/ops/rate-cards', { lenderId: lender, product: 'used_car', slabMin: 0, pctBps: 100, clawbackMonths: 0, validFrom: '2020-01-01' });
    const self = await finance.post(`/ops/rate-cards/${made.body.id}/decision`, { decision: 'active' });
    expect(self.status).toBe(403);
    expect(self.body.code).toBe('SECOND_APPROVER_REQUIRED');
  });

  it('an unapproved rate card prices nothing, and approving it prices what was waiting', async () => {
    const partnerId = await createPartner(h.db, {}, 'approved');
    await enableProducts(h.db, partnerId);
    const admin = await signedIn(h, (await createUser(h.db, partnerId, 'admin')).email);
    const lender = await createLender(h.db);
    const made = await finance.post('/ops/rate-cards', { lenderId: lender, product: 'used_car', slabMin: 0, pctBps: 150, clawbackMonths: 0, validFrom: '2020-01-01' });
    const { invoice } = await disbursedInvoice({ admin, lender });
    expect(invoice.status).toBe('PENDING_RATE_CARD');
    expect((await raise(admin, invoice.id)).status).toBe(409);
    expect((await finance2.post(`/ops/rate-cards/${made.body.id}/decision`, { decision: 'active' })).body.priced).toBeGreaterThan(0);
    const after = (await admin.get(`/invoices/${invoice.id}`)).body;
    expect(after.status).toBe('DRAFT');
    expect(after.grossPaise).toBe(600000);
  });

  it('picks the slab from the sanctioned amount, for every tranche', async () => {
    const s = await setup();
    await rateCard(s.lender, 300, { slabMin: 300000, slabMax: 500000, loanType: 'purchase' });
    const c = await makeCase(h, s.admin, s.lender);
    await toDisbursing(ops, c.id, s.lender, 400000);
    await disburse(h, ops, c.id, 100000, false);
    await disburse(h, ops, c.id, 300000, true);
    const rows = (await s.admin.get('/invoices')).body.data;
    expect(rows.map((r: { grossPaise: number }) => r.grossPaise).sort((a: number, b: number) => a - b)).toEqual([300000, 900000]);
  });
});

describe('invoices', () => {
  it('one per disbursal, priced with GST and TDS', async () => {
    const s = await setup();
    const { invoice } = await disbursedInvoice(s);
    expect(invoice).toMatchObject({ status: 'DRAFT', grossPaise: 400000, gstPaise: 72000, tdsPaise: 8000, netPaise: 464000, invoiceNo: null });
    expect(invoice.applicant).toBe('R*** K****');
  });

  it('no GST when the partner is not registered', async () => {
    const s = await setup(false);
    const { invoice } = await disbursedInvoice(s);
    expect(invoice).toMatchObject({ gstPaise: 0, netPaise: 392000 });
  });

  it('raising is blocked until bank and GST details are verified', async () => {
    const partnerId = await createPartner(h.db, {}, 'approved');
    await enableProducts(h.db, partnerId);
    const admin = await signedIn(h, (await createUser(h.db, partnerId, 'admin')).email);
    const lender = await createLender(h.db);
    await rateCard(lender);
    const { invoice } = await disbursedInvoice({ admin, lender });
    expect((await admin.get(`/invoices/${invoice.id}`)).body.canRaise).toBe(false);
    const blocked = await raise(admin, invoice.id);
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('BILLING_NOT_VERIFIED');
    await admin.patch('/partner/billing', BILLING);
    expect((await raise(admin, invoice.id)).status).toBe(403);
    await reviewer.post(`/ops/partners/${partnerId}/billing/decision`, { decision: 'verified' });
    expect((await raise(admin, invoice.id)).status).toBe(200);
  });

  it('numbers run in order with no gaps, per partner, and a failed raise uses none', async () => {
    const s = await setup();
    const other = await setup();
    const a = await disbursedInvoice(s);
    const b = await disbursedInvoice(s);
    const c = await disbursedInvoice(other);
    const stale = await s.admin.post(`/invoices/${a.invoice.id}/raise`).set('if-match', '999');
    expect(stale.status).toBe(409);
    const first = (await raise(s.admin, a.invoice.id)).body.invoiceNo as string;
    const second = (await raise(s.admin, b.invoice.id)).body.invoiceNo as string;
    const theirs = (await raise(other.admin, c.invoice.id)).body.invoiceNo as string;
    expect(first.endsWith('/000001')).toBe(true);
    expect(second.endsWith('/000002')).toBe(true);
    expect(theirs.endsWith('/000001')).toBe(true);
  });

  it('settles GST at raise time if registration changed after the draft', async () => {
    const s = await setup(false);
    const { invoice } = await disbursedInvoice(s);
    await s.admin.patch('/partner/billing', BILLING);
    await reviewer.post(`/ops/partners/${s.partnerId}/billing/decision`, { decision: 'verified' });
    await raise(s.admin, invoice.id);
    expect((await s.admin.get(`/invoices/${invoice.id}`)).body).toMatchObject({ gstPaise: 72000, netPaise: 464000 });
  });

  it('a raised invoice can not change, even at the database', async () => {
    const s = await setup();
    const { invoice } = await disbursedInvoice(s);
    await raise(s.admin, invoice.id);
    await expect(h.db.query('UPDATE invoice SET gross_paise = 1 WHERE id = $1', [invoice.id])).rejects.toThrow(/cannot be changed/);
    await expect(h.db.query(`UPDATE invoice SET invoice_no = 'X' WHERE id = $1`, [invoice.id])).rejects.toThrow(/cannot be changed/);
    expect((await raise(s.admin, invoice.id)).status).toBe(409);
  });

  it('keeps a snapshot of the rate and the billing details', async () => {
    const s = await setup();
    const { invoice } = await disbursedInvoice(s);
    await raise(s.admin, invoice.id);
    const d = (await s.admin.get(`/invoices/${invoice.id}`)).body;
    expect(d.rate.pctBps).toBe(100);
    expect(d.billing).toMatchObject({ gstin: BILLING.gstin, bankLast4: '9012', sacCode: '998399' });
    expect(JSON.stringify(d)).not.toContain(BILLING.bankAccount);
    expect(d.events.map((e: { toStatus: string }) => e.toStatus)).toEqual(['DRAFT', 'RAISED']);
  });

  it("is Admin only, and another partner's invoices don't exist", async () => {
    const s = await setup();
    const { invoice } = await disbursedInvoice(s);
    const manager = await signedIn(h, (await createUser(h.db, s.partnerId, 'manager')).email);
    expect((await manager.get('/invoices')).status).toBe(403);
    const other = await setup();
    expect((await other.admin.get(`/invoices/${invoice.id}`)).status).toBe(404);
    expect((await other.admin.get('/invoices')).body.data).toEqual([]);
  });

  it('a dispute can be reinstated or voided, with a note', async () => {
    const s = await setup();
    const { invoice } = await disbursedInvoice(s);
    const dispute = async () => {
      const v = await version(s.admin, invoice.id);
      return s.admin.post(`/invoices/${invoice.id}/dispute`, { note: 'Wrong rate used' }).set('if-match', v);
    };
    expect((await dispute()).status).toBe(409);
    await raise(s.admin, invoice.id);
    expect((await dispute()).status).toBe(204);
    expect((await opsPost(finance, invoice.id, 'approve')).status).toBe(409);
    expect((await opsPost(finance, invoice.id, 'resolve-dispute', { outcome: 'reinstate', note: 'Rate confirmed correct' })).status).toBe(204);
    expect((await s.admin.get(`/invoices/${invoice.id}`)).body.status).toBe('RAISED');
    await dispute();
    await opsPost(finance, invoice.id, 'resolve-dispute', { outcome: 'void', note: 'Raised in error' });
    expect((await s.admin.get(`/invoices/${invoice.id}`)).body.status).toBe('VOID');
  });

  it('marking paid needs two different people', async () => {
    const s = await setup();
    const { invoice } = await disbursedInvoice(s);
    await raise(s.admin, invoice.id);
    await opsPost(finance, invoice.id, 'approve');
    expect((await opsPost(finance, invoice.id, 'confirm-paid')).body.code).toBe('PAYOUT_NOT_REQUESTED');
    await opsPost(finance, invoice.id, 'mark-paid', { payoutRef: 'NEFT-1234' });
    expect((await s.admin.get(`/invoices/${invoice.id}`)).body.status).toBe('APPROVED');
    expect((await opsPost(finance, invoice.id, 'confirm-paid')).body.code).toBe('SECOND_APPROVER_REQUIRED');
    const done = await opsPost(finance2, invoice.id, 'confirm-paid');
    expect(done.body).toEqual({ payoutPaise: 464000, recoveredPaise: 0 });
    const list = (await s.admin.get('/invoices?group=paid')).body;
    expect(list.data).toHaveLength(1);
    expect(list.summary.paidPaise).toBe(464000);
  });

  it('ops agents can not touch money', async () => {
    expect((await ops.get('/ops/invoices')).status).toBe(403);
    expect((await ops.get('/ops/rate-cards')).status).toBe(403);
  });
});

describe('reversal and clawback (§4.7)', () => {
  const reverse = async (id: string) => {
    const v = await opsVersion(ops, id);
    const r = await ops.post(`/ops/cases/${id}/reversal`, { reasonCode: 'BANK_RECALL', reference: 'REV-1' }).set('if-match', v);
    expect(r.status).toBe(204);
  };

  it('needs a finance approver who did not ask for it', async () => {
    const s = await setup();
    const { caseId } = await disbursedInvoice(s);
    const superAdmin = await opsSession(h, 'super_admin');
    const v = await opsVersion(ops, caseId);
    await superAdmin.post(`/ops/cases/${caseId}/reversal`, { reasonCode: 'X1', reference: 'REV-2' }).set('if-match', v);
    expect((await superAdmin.post(`/ops/cases/${caseId}/reversal/decision`, { decision: 'approved' })).body.code).toBe('SECOND_APPROVER_REQUIRED');
    expect((await ops.post(`/ops/cases/${caseId}/reversal/decision`, { decision: 'approved' })).status).toBe(403);
    expect((await finance.post(`/ops/cases/${caseId}/reversal/decision`, { decision: 'rejected' })).status).toBe(204);
    expect((await s.admin.get(`/cases/${caseId}`)).body.status).toBe('DISBURSED');
  });

  it('voids an unpaid invoice', async () => {
    const s = await setup();
    const { caseId, invoice } = await disbursedInvoice(s);
    await raise(s.admin, invoice.id);
    await reverse(caseId);
    await finance.post(`/ops/cases/${caseId}/reversal/decision`, { decision: 'approved' });
    expect((await s.admin.get(`/cases/${caseId}`)).body.status).toBe('REVERSED');
    expect((await s.admin.get(`/invoices/${invoice.id}`)).body.status).toBe('VOID');
  });

  it('claws back paid commission from the next payouts, once approved by someone else', async () => {
    const s = await setup();
    const first = await disbursedInvoice(s);
    await paid(s, first.invoice.id);
    await reverse(first.caseId);
    await finance.post(`/ops/cases/${first.caseId}/reversal/decision`, { decision: 'approved' });

    const cb = (await finance.get('/ops/clawbacks')).body.data.find((c: { status: string; partner: string }) => c.status === 'pending');
    expect(cb).toMatchObject({ status: 'pending', amountPaise: 464000 });
    expect((await finance.post(`/ops/clawbacks/${cb.id}/decision`, { decision: 'approved' })).body.code).toBe('SECOND_APPROVER_REQUIRED');

    // Not recovered while it is only pending.
    const early = await disbursedInvoice(s, 100000);
    expect((await paid(s, early.invoice.id)).body).toEqual({ payoutPaise: 116000, recoveredPaise: 0 });

    expect((await finance2.post(`/ops/clawbacks/${cb.id}/decision`, { decision: 'approved' })).status).toBe(204);

    // A small payout is taken in full, and the rest waits for the next one.
    const small = await disbursedInvoice(s, 100000);
    expect((await paid(s, small.invoice.id)).body).toEqual({ payoutPaise: 0, recoveredPaise: 116000 });
    const big = await disbursedInvoice(s, 400000);
    expect((await paid(s, big.invoice.id)).body).toEqual({ payoutPaise: 116000, recoveredPaise: 348000 });
    const after = (await finance.get('/ops/clawbacks')).body.data.find((c: { id: string }) => c.id === cb.id);
    expect(after).toMatchObject({ status: 'recovered', recoveredPaise: 464000 });
    expect((await s.admin.get(`/invoices/${first.invoice.id}`)).body.events.map((e: { note: string }) => e.note)).toContain('Clawback approved');
  });
});
