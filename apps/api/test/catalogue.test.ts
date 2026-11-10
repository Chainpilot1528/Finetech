import { randomUUID } from 'node:crypto';
import { PRODUCTS, REGISTRATION_PRODUCTS, documentsFor, validateStep } from '@vittora/product-schemas';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLender, createPartner, createUser, enableProducts, harness, signedIn, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => { h = await harness(); });
afterAll(async () => h?.close());

const today = new Date('2026-11-09T00:00:00Z');
const carLoan = (carYear: number, tenureMonths: number, amount = 400000, carValue = 600000) => ({
  setup: { product: 'used_car', loanType: 'purchase', lenderId: 'x' },
  details: { carYear, carValue },
  loan: { amount, tenureMonths },
});

describe('one definition per product (ARCH-03)', () => {
  it('the database knows exactly the products in the catalogue', async () => {
    const { rows } = await h.db.query('SELECT code, active FROM product ORDER BY code');
    expect(rows.map((r) => r.code).sort()).toEqual(REGISTRATION_PRODUCTS.map((p) => p.code).sort());
    // Only products with a definition may be switched on.
    for (const r of rows.filter((x) => x.active)) expect(PRODUCTS[r.code]).toBeDefined();
  });

  it('takes names from the definitions and lists every product for sign-up', () => {
    expect(REGISTRATION_PRODUCTS.find((p) => p.code === 'used_car')!.name).toBe(PRODUCTS.used_car!.name);
    expect(REGISTRATION_PRODUCTS.map((p) => p.code)).toEqual(['used_car', 'loan_against_car', 'personal', 'business', 'home', 'education']);
  });

  it('lets a product leave out common documents', () => {
    const personal = { ...PRODUCTS.personal!, excludeCommonDocuments: ['salary_slips'] };
    expect(documentsFor(personal, 'fresh', 'salaried').map((d) => d.code)).not.toContain('salary_slips');
    expect(documentsFor(PRODUCTS.personal!, 'fresh', 'salaried').map((d) => d.code)).toContain('salary_slips');
  });
});

describe('car loan limits come from the product definition (GAP-04)', () => {
  it('refuses a tenure that would leave the car over 12 years old', () => {
    expect(validateStep('loan', carLoan(2020, 48), today).tenureMonths).toBeUndefined(); // 6 + 4 = 10 years
    expect(validateStep('loan', carLoan(2016, 24), today).tenureMonths).toBeUndefined(); // 10 + 2 = 12 years
    expect(validateStep('loan', carLoan(2016, 36), today).tenureMonths).toMatch(/over 12 years/); // 10 + 3 = 13 years
  });

  it('refuses a loan above the valuation', () => {
    expect(validateStep('loan', carLoan(2020, 48, 600000, 600000), today).amount).toBeUndefined();
    expect(validateStep('loan', carLoan(2020, 48, 650000, 600000), today).amount).toMatch(/100% of the valuation/);
  });

  it('the API enforces the same rule when a draft is saved and submitted', async () => {
    const partner = await createPartner(h.db, {}, 'approved');
    await enableProducts(h.db, partner);
    const exec = await signedIn(h, (await createUser(h.db, partner, 'executive')).email);
    const d = (await exec.post('/cases/drafts').set('idempotency-key', randomUUID())).body;
    const lender = await createLender(h.db);
    await exec.patch(`/cases/drafts/${d.id}`, { version: d.version, data: { setup: { product: 'used_car', loanType: 'purchase', lenderId: lender }, details: { carYear: 2012, carValue: 600000 }, loan: { amount: 400000, tenureMonths: 60 } } });
    const res = await exec.post(`/cases/drafts/${d.id}/submit`, {}).set('idempotency-key', randomUUID());
    expect(res.status).toBe(422);
    expect(res.body.errors.tenureMonths).toMatch(/over 12 years/);
  });
});

describe('lenders are mapped to loan types (GAP-02)', () => {
  it('offers a lender only for the loan types it takes', async () => {
    const partner = await createPartner(h.db, {}, 'approved');
    await enableProducts(h.db, partner);
    const exec = await signedIn(h, (await createUser(h.db, partner, 'executive')).email);
    const lender = await createLender(h.db, ['used_car']);
    await h.db.query(`UPDATE lender_product SET loan_types = ARRAY['purchase'] WHERE lender_id = $1`, [lender]);
    const ids = async (loanType: string) => (await exec.get(`/lenders?product=used_car&loanType=${loanType}`)).body.data.map((l: { id: string }) => l.id);
    expect(await ids('purchase')).toContain(lender);
    expect(await ids('refinance')).not.toContain(lender);
    expect((await exec.get('/lenders?product=used_car')).body.data.map((l: { id: string }) => l.id)).toContain(lender);
  });
});
