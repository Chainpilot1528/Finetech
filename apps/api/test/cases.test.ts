import { randomUUID } from 'node:crypto';
import { estimatedEmi, foirPercent, ltvPercent, validateStep } from '@vittora/product-schemas';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PDF, client, createLender, createPartner, createUser, enableProducts, harness, signedIn, type Client, type Harness,
} from './helpers.js';

let h: Harness;
let lender: string;
let partnerId: string;
let exec: Client;

const consentToken = (text: string) => /\/consent\/([\w-]+)/.exec(text)?.[1] ?? '';
let phoneSeq = 0;
const pan = () => `ABCDE${String(1000 + (phoneSeq += 1)).padStart(4, '0')}F`;
const reg = () => `MH12AB${String(1000 + phoneSeq).padStart(4, '0')}`;

const usedCarData = (lenderId: string, over: { pan?: string; reg?: string; email?: string } = {}) => {
  const p = over.pan ?? pan();
  return {
    setup: { product: 'used_car', loanType: 'purchase', lenderId },
    applicant: {
      fullName: 'Ravi Kumar', email: over.email ?? `cust-${randomUUID()}@example.test`, phone: '9876543210', pan: p, aadhaarLast4: '4321',
      dob: '1990-05-01', address: '12 Test Road, Delhi', pincode: '110001', city: 'Delhi', state: 'Delhi',
    },
    details: {
      carMake: 'Maruti', carModel: 'Swift', carYear: 2020, registrationNumber: over.reg ?? reg(), chassisNumber: 'CHASSIS123',
      engineNumber: 'ENGINE1234', carValue: 600000, seller: 'dealer',
    },
    loan: { amount: 400000, tenureMonths: 48, purpose: 'Buy a car' },
    income: { employmentType: 'salaried', monthlyIncome: 60000, companyName: 'Acme', workExperienceYears: 5, existingEmi: 5000 },
    documents: { aadhaarMaskedConfirmed: true },
  };
};

async function newDraft(c: Client) {
  const res = await c.post('/cases/drafts').set('idempotency-key', randomUUID());
  expect(res.status).toBe(201);
  return res.body as { id: string; version: number };
}

async function save(c: Client, id: string, version: number, data: object) {
  const res = await c.patch(`/cases/drafts/${id}`, { version, data });
  expect(res.status).toBe(200);
  return res.body;
}

async function consent(c: Client, id: string) {
  expect((await c.post(`/cases/drafts/${id}/consent-requests`)).status).toBe(202);
  await new Promise((r) => setImmediate(r));
  const token = consentToken(h.mail.messages.find((m) => /\/consent\//.test(m.text))!.text);
  const customer = await client(h, 'customer-phone');
  expect((await customer.post(`/public/consent/${token}/code`)).status).toBe(202);
  const code = /\b(\d{6})\b/.exec(h.mail.messages[0]!.text)![1];
  expect((await customer.post(`/public/consent/${token}`, { code })).status).toBe(204);
  return token;
}

async function uploadAll(c: Client, draft: { id: string; requiredDocuments: { code: string; required: boolean }[] }) {
  for (const d of draft.requiredDocuments.filter((x) => x.required)) {
    expect((await c.upload(`/cases/drafts/${draft.id}/documents/${d.code}`, PDF)).status).toBe(204);
  }
}

const submit = (c: Client, id: string, body: object = {}, key: string = randomUUID()) =>
  c.post(`/cases/drafts/${id}/submit`, body).set('idempotency-key', key);

async function readyDraft(c: Client, over = {}) {
  const d = await newDraft(c);
  const saved = await save(c, d.id, d.version, usedCarData(lender, over));
  await uploadAll(c, saved);
  await consent(c, d.id);
  return saved;
}

beforeAll(async () => {
  h = await harness();
  lender = await createLender(h.db);
  partnerId = await createPartner(h.db, {}, 'approved');
  await enableProducts(h.db, partnerId);
  exec = await signedIn(h, (await createUser(h.db, partnerId, 'executive')).email);
});
afterAll(() => h.close());

describe('who can create cases', () => {
  it('blocks partners whose KYC is not approved (§4.2)', async () => {
    const pid = await createPartner(h.db);
    const c = await signedIn(h, (await createUser(h.db, pid, 'executive')).email);
    const res = await c.post('/cases/drafts').set('idempotency-key', randomUUID());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('KYC_NOT_APPROVED');
  });

  it('Viewer can not create cases', async () => {
    const c = await signedIn(h, (await createUser(h.db, partnerId, 'viewer')).email);
    expect((await c.post('/cases/drafts').set('idempotency-key', randomUUID())).status).toBe(403);
  });

  it('shows only products switched on for the partner, and only matching lenders', async () => {
    const pid = await createPartner(h.db, {}, 'approved');
    await enableProducts(h.db, pid, ['personal', 'home']);
    const c = await signedIn(h, (await createUser(h.db, pid, 'executive')).email);
    expect((await c.get('/catalogue/products')).body.data).toEqual([{ code: 'personal', name: 'Personal Loan' }]);
    const onlyPersonal = await createLender(h.db, ['personal']);
    const cars = (await c.get('/lenders?product=used_car')).body.data.map((l: { id: string }) => l.id);
    expect(cars).toContain(lender);
    expect(cars).not.toContain(onlyPersonal);
  });
});

describe('drafts (§4.4)', () => {
  it('needs an Idempotency-Key, and the same key returns the same draft', async () => {
    expect((await exec.post('/cases/drafts')).status).toBe(400);
    const key = randomUUID();
    const a = await exec.post('/cases/drafts').set('idempotency-key', key);
    const b = await exec.post('/cases/drafts').set('idempotency-key', key);
    expect(a.body.id).toBe(b.body.id);
  });

  it('saves step by step and resumes', async () => {
    const d = await newDraft(exec);
    const saved = await save(exec, d.id, d.version, { setup: { product: 'personal', loanType: 'fresh', lenderId: lender } });
    await save(exec, d.id, saved.version, { loan: { amount: 100000 } });
    const back = (await exec.get(`/cases/drafts/${d.id}`)).body;
    expect(back.data.setup.product).toBe('personal');
    expect(back.data.loan.amount).toBe(100000);
    expect((await exec.get('/cases/drafts')).body.data.map((x: { id: string }) => x.id)).toContain(d.id);
  });

  it('refuses a stale save instead of overwriting newer work', async () => {
    const d = await newDraft(exec);
    await save(exec, d.id, d.version, { loan: { amount: 100000 } });
    const res = await exec.patch(`/cases/drafts/${d.id}`, { version: d.version, data: { loan: { amount: 5 } } });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('VERSION_CONFLICT');
  });

  it('refuses a full Aadhaar number outright, even in a draft', async () => {
    const d = await newDraft(exec);
    const res = await exec.patch(`/cases/drafts/${d.id}`, { version: d.version, data: { applicant: { aadhaarLast4: '123456789012' } } });
    expect(res.status).toBe(422);
  });

  it('encrypts draft contents in the database', async () => {
    const d = await newDraft(exec);
    await save(exec, d.id, d.version, usedCarData(lender, { pan: 'SECRT9999Z' }));
    const { rows } = await h.db.query('SELECT data_enc FROM case_draft WHERE id = $1', [d.id]);
    expect(rows[0].data_enc).not.toContain('SECRT9999Z');
    expect(rows[0].data_enc).not.toContain('Ravi');
  });

  it('changing the product clears its details and product documents', async () => {
    const d = await newDraft(exec);
    const saved = await save(exec, d.id, d.version, usedCarData(lender));
    await exec.upload(`/cases/drafts/${d.id}/documents/rc`, PDF);
    await exec.upload(`/cases/drafts/${d.id}/documents/pan_card`, PDF);
    const changed = await save(exec, d.id, saved.version, { setup: { product: 'personal', loanType: 'fresh' } });
    expect(changed.data.details).toBeUndefined();
    expect(changed.documents.map((x: { docType: string }) => x.docType)).toEqual(['pan_card']);
  });

  it('another user, even in the same partner, can not open my draft', async () => {
    const d = await newDraft(exec);
    const colleague = await signedIn(h, (await createUser(h.db, partnerId, 'executive')).email);
    expect((await colleague.get(`/cases/drafts/${d.id}`)).status).toBe(404);
    expect((await colleague.patch(`/cases/drafts/${d.id}`, { version: 1, data: {} })).status).toBe(404);
  });

  it('another partner can not reach it either', async () => {
    const d = await newDraft(exec);
    const pid = await createPartner(h.db, {}, 'approved');
    const other = await signedIn(h, (await createUser(h.db, pid, 'executive')).email);
    expect((await other.get(`/cases/drafts/${d.id}`)).status).toBe(404);
    expect((await other.upload(`/cases/drafts/${d.id}/documents/pan_card`, PDF)).status).toBe(404);
  });

  it('only accepts documents that belong to this case', async () => {
    const d = await newDraft(exec);
    await save(exec, d.id, d.version, usedCarData(lender));
    const res = await exec.upload(`/cases/drafts/${d.id}/documents/foreclosure_letter`, PDF);
    expect(res.body.code).toBe('DOCUMENT_NOT_NEEDED');
  });

  it('checklists follow product, loan type and employment', async () => {
    const d = await newDraft(exec);
    const a = await save(exec, d.id, d.version, usedCarData(lender));
    expect(a.requiredDocuments.map((x: { code: string }) => x.code)).toEqual(expect.arrayContaining(['rc', 'sale_agreement', 'salary_slips']));
    const b = await save(exec, d.id, a.version, { setup: { loanType: 'external_bt' }, income: { employmentType: 'business' } });
    const codes = b.requiredDocuments.map((x: { code: string }) => x.code);
    expect(codes).toEqual(expect.arrayContaining(['loan_statement', 'foreclosure_letter', 'itr']));
    expect(codes).not.toContain('sale_agreement');
    expect(codes).not.toContain('salary_slips');
  });
});

describe('draft edits are audited (STD-05)', () => {
  it('records which sections changed, never their values', async () => {
    const d = await newDraft(exec);
    await save(exec, d.id, d.version, usedCarData(lender, { pan: 'AUDIT1234Z' }));
    const { rows } = await h.db.query(`SELECT after FROM audit_log WHERE action = 'case.draft_updated' AND entity_id = $1`, [d.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].after.sections).toBe('setup,applicant,details,loan,income,documents');
    const text = JSON.stringify(rows);
    expect(text).not.toContain('AUDIT1234Z');
    expect(text).not.toContain('Ravi');
    expect(text).not.toContain('9876543210');
  });

  it('includes the partner Reference ID with the draft', async () => {
    const d = await newDraft(exec);
    expect((await exec.get(`/cases/drafts/${d.id}`)).body.referenceId).toMatch(/^TST-110-/);
  });
});

describe('customer consent only comes from the customer (SEC-01)', () => {
  const linkMessages = () => h.mail.messages.filter((m) => /\/consent\//.test(m.text));

  it('sends the link only to the customer\'s phone, never to an email the partner typed', async () => {
    const d = await newDraft(exec);
    const partnerEmail = `partner-own-${randomUUID()}@example.test`;
    await save(exec, d.id, d.version, usedCarData(lender, { email: partnerEmail }));
    h.mail.messages.length = 0;
    expect((await exec.post(`/cases/drafts/${d.id}/consent-requests`)).status).toBe(202);
    const sent = linkMessages();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('sms:+919876543210');
    expect(h.mail.messages.some((m) => m.to === partnerEmail)).toBe(false);
  });

  it('needs the one-time code sent to that phone, and records it as an OTP consent', async () => {
    const d = await newDraft(exec);
    await save(exec, d.id, d.version, usedCarData(lender));
    await exec.post(`/cases/drafts/${d.id}/consent-requests`);
    const token = consentToken(linkMessages()[0]!.text);
    const customer = await client(h, 'customer-phone');
    expect((await customer.post(`/public/consent/${token}`)).status).toBe(422);
    h.mail.messages.length = 0;
    expect((await customer.post(`/public/consent/${token}/code`)).status).toBe(202);
    const sms = h.mail.messages[0]!;
    expect(sms.to).toBe('sms:+919876543210');
    const code = /\b(\d{6})\b/.exec(sms.text)![1]!;
    const wrong = code === '000000' ? '111111' : '000000';
    expect((await customer.post(`/public/consent/${token}`, { code: wrong })).status).toBe(400);
    expect((await exec.get(`/cases/drafts/${d.id}`)).body.consent).toBe('sent');
    expect((await customer.post(`/public/consent/${token}`, { code })).status).toBe(204);
    const { rows } = await h.db.query('SELECT channel FROM customer_consent WHERE draft_id = $1 AND consented_at IS NOT NULL', [d.id]);
    expect(rows[0].channel).toBe('otp');
    expect((await exec.get(`/cases/drafts/${d.id}`)).body.consent).toBe('given');
  });

  it('stops accepting codes after five wrong tries', async () => {
    const d = await newDraft(exec);
    await save(exec, d.id, d.version, usedCarData(lender));
    await exec.post(`/cases/drafts/${d.id}/consent-requests`);
    const token = consentToken(linkMessages()[0]!.text);
    const customer = await client(h, 'customer-phone');
    h.mail.messages.length = 0;
    await customer.post(`/public/consent/${token}/code`);
    const code = /\b(\d{6})\b/.exec(h.mail.messages[0]!.text)![1]!;
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i += 1) expect((await customer.post(`/public/consent/${token}`, { code: wrong })).status).toBe(400);
    const locked = await customer.post(`/public/consent/${token}`, { code });
    expect(locked.status).toBe(400);
    expect(locked.body.code).toBe('CODE_LOCKED');
  });

  it('is voided when the customer\'s email changes after consent', async () => {
    const saved = await readyDraft(exec);
    const version = (await exec.get(`/cases/drafts/${saved.id}`)).body.version;
    await save(exec, saved.id, version, { applicant: { email: `changed-${randomUUID()}@example.test` } });
    expect((await exec.get(`/cases/drafts/${saved.id}`)).body.consent).toBe('none');
  });
});

describe('customer consent (§4.4)', () => {
  it('blocks submission until the customer consents, and only the customer can', async () => {
    const d = await newDraft(exec);
    const saved = await save(exec, d.id, d.version, usedCarData(lender));
    await uploadAll(exec, saved);
    expect((await submit(exec, d.id)).body.code).toBe('CONSENT_REQUIRED');
    await exec.post(`/cases/drafts/${d.id}/consent-requests`);
    expect((await exec.get(`/cases/drafts/${d.id}`)).body.consent).toBe('sent');
    expect((await submit(exec, d.id)).body.code).toBe('CONSENT_REQUIRED');
  });

  it('the consent page names the partner and lender but shows no customer details', async () => {
    const d = await newDraft(exec);
    await save(exec, d.id, d.version, usedCarData(lender, { pan: 'PRIVT1234Z' }));
    await exec.post(`/cases/drafts/${d.id}/consent-requests`);
    await new Promise((r) => setImmediate(r));
    const token = consentToken(h.mail.messages[0]!.text);
    const page = await (await client(h)).get(`/public/consent/${token}`);
    expect(page.body.partnerName).toBe('Test Channel');
    expect(page.body.lenderName).toBe('Test Bank');
    const text = JSON.stringify(page.body);
    expect(text).not.toContain('Ravi');
    expect(text).not.toContain('PRIVT1234Z');
    expect(text).not.toContain('9876543210');
  });

  it('records the customer\'s own device, not the partner\'s', async () => {
    const d = await newDraft(exec);
    await save(exec, d.id, d.version, usedCarData(lender));
    await consent(exec, d.id);
    const { rows } = await h.db.query('SELECT consented_at, user_agent, channel FROM customer_consent WHERE draft_id = $1', [d.id]);
    expect(rows[0].consented_at).toBeTruthy();
    expect(rows[0].channel).toBe('otp');
    expect(rows[0].user_agent).toBe('customer-phone');
    expect((await exec.get(`/cases/drafts/${d.id}`)).body.consent).toBe('given');
  });

  it('expires after 48 hours, and a newer link cancels the older one', async () => {
    const d = await newDraft(exec);
    await save(exec, d.id, d.version, usedCarData(lender));
    await exec.post(`/cases/drafts/${d.id}/consent-requests`);
    await new Promise((r) => setImmediate(r));
    const first = consentToken(h.mail.messages[0]!.text);
    await exec.post(`/cases/drafts/${d.id}/consent-requests`);
    await new Promise((r) => setImmediate(r));
    const second = consentToken(h.mail.messages[0]!.text);
    const customer = await client(h);
    expect((await customer.post(`/public/consent/${first}`)).status).toBe(400);

    h.clock.advance(49 * 3_600_000);
    expect((await customer.post(`/public/consent/${second}`)).status).toBe(400);
    exec = await signedIn(h, (await createUser(h.db, partnerId, 'executive')).email); // the old session idled out
  });

  it('changing the customer after consent needs a fresh consent', async () => {
    const saved = await readyDraft(exec);
    const version = (await exec.get(`/cases/drafts/${saved.id}`)).body.version;
    await save(exec, saved.id, version, { applicant: { pan: 'NEWPN1234Q' } });
    expect((await exec.get(`/cases/drafts/${saved.id}`)).body.consent).toBe('none');
    expect((await submit(exec, saved.id)).body.code).toBe('CONSENT_REQUIRED');
  });

  it('can not be requested before the customer details are complete', async () => {
    const d = await newDraft(exec);
    const res = await exec.post(`/cases/drafts/${d.id}/consent-requests`);
    expect(res.status).toBe(422);
    expect(res.body.errors.phone).toBeTruthy();
  });
});

describe('submitting a case', () => {
  it('creates a Registered case with history and audit, and encrypts the customer', async () => {
    const saved = await readyDraft(exec, { pan: 'ENCRP1111A' });
    const res = await submit(exec, saved.id);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('REGISTERED');
    expect(res.body.caseNo).toMatch(/^CASE-\d{6}-[A-Z2-9]{6}$/);

    const { rows } = await h.db.query(
      `SELECT c.loan_amount_paise, c.status, c.details_schema_version, a.pan_enc, a.full_name_enc, a.aadhaar_last4,
              h.to_status, d.data_enc, d.status AS draft_status
       FROM loan_case c JOIN applicant a ON a.id = c.applicant_id
       JOIN case_status_history h ON h.case_id = c.id JOIN case_draft d ON d.id = c.source_draft_id WHERE c.id = $1`,
      [res.body.id],
    );
    const row = rows[0];
    expect(row.loan_amount_paise).toBe('40000000');
    expect(row.to_status).toBe('REGISTERED');
    expect(row.details_schema_version).toBe(1);
    expect(row.aadhaar_last4).toBe('4321');
    expect(row.pan_enc).not.toContain('ENCRP1111A');
    expect(row.full_name_enc).not.toContain('Ravi');
    expect(row.draft_status).toBe('submitted');
    const audit = await h.db.query(`SELECT after FROM audit_log WHERE entity_id = $1 AND action = 'case.registered'`, [res.body.id]);
    expect(audit.rows[0].after).toEqual({ product: 'used_car' });
  });

  it('a double submit makes one case', async () => {
    const saved = await readyDraft(exec);
    const a = await submit(exec, saved.id);
    const b = await submit(exec, saved.id);
    expect(b.body.id).toBe(a.body.id);
    const { rows } = await h.db.query('SELECT count(*)::int AS n FROM loan_case WHERE source_draft_id = $1', [saved.id]);
    expect(rows[0].n).toBe(1);
  });

  it('a submitted draft can not be edited', async () => {
    const saved = await readyDraft(exec);
    await submit(exec, saved.id);
    const { version } = (await exec.get(`/cases/drafts/${saved.id}`)).body;
    expect((await exec.patch(`/cases/drafts/${saved.id}`, { version, data: {} })).body.code).toBe('DRAFT_SUBMITTED');
  });

  it('needs every required document', async () => {
    const d = await newDraft(exec);
    await save(exec, d.id, d.version, usedCarData(lender));
    await consent(exec, d.id);
    const res = await submit(exec, d.id);
    expect(res.body.code).toBe('DOCUMENTS_MISSING');
    expect(res.body.errors.rc).toBeTruthy();
  });

  it('re-checks everything on the server', async () => {
    const d = await newDraft(exec);
    const data = usedCarData(lender);
    data.loan.amount = 1;
    data.details.registrationNumber = 'not a reg';
    await save(exec, d.id, d.version, data);
    const res = await submit(exec, d.id);
    expect(res.status).toBe(422);
    expect(res.body.errors.amount).toBeTruthy();
    expect(res.body.errors.registrationNumber).toBeTruthy();
  });

  it('refuses a lender that does not offer the product', async () => {
    const other = await createLender(h.db, ['personal']);
    const d = await newDraft(exec);
    const saved = await save(exec, d.id, d.version, usedCarData(other));
    await uploadAll(exec, saved);
    await consent(exec, d.id);
    expect((await submit(exec, d.id)).body.code).toBe('LENDER_NOT_AVAILABLE');
  });

  it('works for all three first products', async () => {
    const personal = await newDraft(exec);
    const data = usedCarData(lender);
    const body = {
      ...data, setup: { product: 'personal', loanType: 'fresh', lenderId: lender }, details: undefined,
    };
    const saved = await save(exec, personal.id, personal.version, body);
    await uploadAll(exec, saved);
    await consent(exec, personal.id);
    expect((await submit(exec, personal.id)).status).toBe(201);

    const car = await newDraft(exec);
    const carData = usedCarData(lender);
    const s2 = await save(exec, car.id, car.version, {
      ...carData, setup: { product: 'loan_against_car', loanType: 'fresh', lenderId: lender },
      details: { ...carData.details, seller: undefined, hypothecation: 'none' },
    });
    await uploadAll(exec, s2);
    await consent(exec, car.id);
    expect((await submit(exec, car.id)).status).toBe(201);
  });
});

describe('duplicates (§4.4)', () => {
  it('warns on an open case for the same customer, and lets the partner confirm', async () => {
    const shared = { pan: 'DUPLC1234D', reg: 'DL01AB1234' };
    await submit(exec, (await readyDraft(exec, shared)).id);
    const again = await readyDraft(exec, shared);
    const res = await submit(exec, again.id);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DUPLICATE_CASE');
    expect((await submit(exec, again.id, { confirmDuplicate: true })).status).toBe(201);
  });

  it('flags a match at another partner for ops, without telling the partner', async () => {
    const shared = { pan: 'CROSS1234P', reg: 'DL02AB1234' };
    await submit(exec, (await readyDraft(exec, shared)).id);
    const pid = await createPartner(h.db, {}, 'approved');
    await enableProducts(h.db, pid);
    const other = await signedIn(h, (await createUser(h.db, pid, 'executive')).email);
    const res = await submit(other, (await readyDraft(other, shared)).id);
    expect(res.status).toBe(201);
    expect(JSON.stringify(res.body)).not.toMatch(/duplicate/i);
    const { rows } = await h.db.query('SELECT possible_duplicate FROM loan_case WHERE id = $1', [res.body.id]);
    expect(rows[0].possible_duplicate).toBe(true);
  });
});

describe('shared rules', () => {
  const today = new Date('2026-11-07T00:00:00Z');
  it('applicants must be 18', () => {
    const data = { applicant: { dob: '2009-01-01' } };
    expect(validateStep('applicant', data, today).dob).toMatch(/18/);
    expect(validateStep('applicant', { applicant: { dob: '2008-11-07' } }, today).dob).toBeUndefined();
  });
  it('limits come from the product', () => {
    const setup = { product: 'personal' };
    expect(validateStep('loan', { setup, loan: { amount: 49_999, tenureMonths: 24 } }, today).amount).toBeTruthy();
    expect(validateStep('loan', { setup, loan: { amount: 50_000, tenureMonths: 61 } }, today).tenureMonths).toBeTruthy();
    expect(validateStep('loan', { setup, loan: { amount: 50_000, tenureMonths: 60 } }, today)).toEqual({});
  });
  it('calculates LTV, EMI and FOIR', () => {
    expect(ltvPercent(400000, 500000)).toBe(80);
    expect(estimatedEmi(100000, 12, 12)).toBe(8885);
    expect(foirPercent(5000, 10000, 50000)).toBe(30);
  });
});
