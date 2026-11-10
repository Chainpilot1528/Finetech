import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PDF, createLender, createPartner, createUser, enableProducts, harness, makeCase, opsSession, signedIn, type Harness,
} from './helpers.js';

let h: Harness;
beforeAll(async () => { h = await harness(); });
afterAll(async () => h?.close());

const audits = async (action: string, entityId: string) =>
  (await h.db.query('SELECT actor_id, partner_id, after FROM audit_log WHERE action = $1 AND entity_id = $2', [action, entityId])).rows;

describe('staff reads of partner data are audited (SEC-02)', () => {
  it('logs viewing a partner, the partner list and a KYC file', async () => {
    const partner = await createPartner(h.db);
    const admin = await signedIn(h, (await createUser(h.db, partner, 'admin')).email);
    expect((await admin.upload('/kyc/documents/pan', PDF)).status).toBe(204);
    const reviewer = await opsSession(h, 'kyc_reviewer');
    const me = (await reviewer.get('/me')).body.userId as string;

    const detail = await reviewer.get(`/ops/partners/${partner}`);
    expect(detail.status).toBe(200);
    expect(await audits('ops.partner_viewed', partner)).toEqual([expect.objectContaining({ actor_id: me, partner_id: partner })]);

    expect((await reviewer.get('/ops/partners')).status).toBe(200);
    const listed = (await h.db.query(`SELECT after FROM audit_log WHERE action = 'ops.partners_listed' AND actor_id = $1`, [me])).rows;
    expect(listed).toHaveLength(1);

    const doc = detail.body.documents[0].id as string;
    expect((await reviewer.get(`/ops/kyc/documents/${doc}/url`)).status).toBe(200);
    expect(await audits('ops.kyc_document_viewed', doc)).toEqual([expect.objectContaining({ actor_id: me, partner_id: partner })]);
  });

  it('logs opening a case in the ops console', async () => {
    const partner = await createPartner(h.db, {}, 'approved');
    await enableProducts(h.db, partner);
    const lender = await createLender(h.db);
    const exec = await signedIn(h, (await createUser(h.db, partner, 'executive')).email);
    const { id } = await makeCase(h, exec, lender);
    const ops = await opsSession(h, 'ops_agent');
    expect((await ops.get(`/ops/cases/${id}`)).status).toBe(200);
    expect(await audits('ops.case_viewed', id)).toHaveLength(1);
  });
});

describe('identifying product details are encrypted at rest (SEC-03)', () => {
  it('keeps registration, chassis and engine numbers out of the plain column, but shows them on screen', async () => {
    const partner = await createPartner(h.db, {}, 'approved');
    await enableProducts(h.db, partner);
    const lender = await createLender(h.db);
    const exec = await signedIn(h, (await createUser(h.db, partner, 'executive')).email);
    const { id, registration } = await makeCase(h, exec, lender);
    const { rows: [row] } = await h.db.query('SELECT product_details, product_details_enc FROM loan_case WHERE id = $1', [id]);
    expect(row.product_details).toMatchObject({ carMake: 'Maruti', carValue: 600000 });
    for (const k of ['registrationNumber', 'chassisNumber', 'engineNumber']) expect(row.product_details[k]).toBeUndefined();
    expect(row.product_details_enc).toBeTruthy();
    expect(row.product_details_enc).not.toContain(registration);
    expect(row.product_details_enc).not.toContain('CHASSIS123');

    expect((await exec.get(`/cases/${id}`)).body.details).toMatchObject({ registrationNumber: registration, chassisNumber: 'CHASSIS123', carMake: 'Maruti' });
    const ops = await opsSession(h, 'ops_agent');
    expect((await ops.get(`/ops/cases/${id}`)).body.details.engineNumber).toBe('ENGINE1234');
    // Search by registration still works through the blind index.
    expect((await exec.get(`/cases?q=${registration}`)).body.data.map((c: { id: string }) => c.id)).toContain(id);
  });
});
