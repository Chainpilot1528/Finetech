import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { hash } from '@node-rs/argon2';
import type { Clock, Role } from '@vittora/shared-kernel';
import { authenticator } from 'otplib';
import pg from 'pg';
import request from 'supertest';
import { v7 as uuid } from 'uuid';
import { createApp } from '../src/app.js';
import { DevMailbox } from '../src/modules/identity/index.js';
import { loadConfig } from '../src/platform/config.js';

export class FakeClock implements Clock {
  private t = Date.now();
  now() { return new Date(this.t); }
  advance(ms: number) { this.t += ms; }
}

export const PASSWORD = 'correct-horse-battery-9';
export const owner = () => new pg.Pool({ connectionString: process.env.TEST_OWNER_URL, max: 2 });

export interface Harness {
  app: INestApplication;
  clock: FakeClock;
  mail: DevMailbox;
  delays: number[];
  breached: Set<string>;
  db: pg.Pool;
  storageDir: string;
  close(): Promise<void>;
}

export async function harness(): Promise<Harness> {
  const clock = new FakeClock();
  const mail = new DevMailbox();
  const delays: number[] = [];
  const breached = new Set<string>();
  const storageDir = mkdtempSync(join(tmpdir(), 'vittora-files-'));
  const config = loadConfig({
    NODE_ENV: 'test',
    WEB_ORIGIN: 'http://localhost:3000',
    APP_DATABASE_URL: process.env.TEST_APP_URL,
    AUTH_DATABASE_URL: process.env.TEST_AUTH_URL,
    OPS_DATABASE_URL: process.env.TEST_OPS_URL,
    STORAGE_DIR: storageDir,
    ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    HMAC_KEY: randomBytes(32).toString('hex'),
    DEV_MAILBOX: 'false',
    OUTBOX_POLL_MS: '0',
  });
  const app = await createApp(config, {
    clock,
    mailer: mail,
    delay: { wait: async (ms) => { delays.push(ms); } },
    breached: { isBreached: async (p) => breached.has(p) },
  });
  await app.init();
  const db = owner();
  return { app, clock, mail, delays, breached, db, storageDir, close: async () => { await app.close(); await db.end(); rmSync(storageDir, { recursive: true, force: true }); } };
}

let n = 0;
export async function createPartner(db: pg.Pool, features: object = {}, kycStatus = 'not_started') {
  const id = uuid();
  n += 1;
  await db.query(
    `INSERT INTO partner (id, ref_code, legal_name, channel_name, city, pincode, status, features, kyc_status)
     VALUES ($1,$2,'Test Co','Test Channel','Testville','110001','active',$3,$4)`,
    [id, `TST-110-${id.slice(-6)}-${n}`, JSON.stringify(features), kycStatus],
  );
  return id;
}

const passwordHash = hash(PASSWORD);

export async function createUser(db: pg.Pool, partnerId: string | null, role: Role, opts: { status?: string; password?: boolean } = {}) {
  const id = uuid();
  const email = `user-${id.slice(-12)}@example.test`;
  await db.query(
    `INSERT INTO app_user (id, partner_id, name, email, role, status, password_hash) VALUES ($1,$2,'Test User',$3,$4,$5,$6)`,
    [id, partnerId, email, role, opts.status ?? 'active', opts.password === false ? null : await passwordHash],
  );
  return { id, email };
}

/** A browser: holds cookies and sends the CSRF header like the web app does. */
export class Client {
  readonly agent;
  private csrf = '';
  ip = `10.0.0.${Math.floor(Math.random() * 250) + 1}`;
  constructor(app: INestApplication, private readonly ua = 'vitest-browser') {
    this.agent = request.agent(app.getHttpServer());
  }
  async start() {
    const res = await this.agent.get('/api/v1/auth/csrf');
    this.csrf = res.body.csrfToken;
    return this;
  }
  get(path: string) {
    return this.agent.get(`/api/v1${path}`).set('user-agent', this.ua);
  }
  post(path: string, body?: object) {
    return this.agent.post(`/api/v1${path}`).set('user-agent', this.ua).set('x-csrf-token', this.csrf).send(body);
  }
  login(email: string, password = PASSWORD) {
    return this.post('/auth/login', { email, password });
  }
  patch(path: string, body?: object) {
    return this.agent.patch(`/api/v1${path}`).set('user-agent', this.ua).set('x-csrf-token', this.csrf).send(body);
  }
  upload(path: string, file: Buffer, name = 'file.pdf') {
    return this.agent.post(`/api/v1${path}`).set('user-agent', this.ua).set('x-csrf-token', this.csrf).attach('file', file, name);
  }
}

export const client = (h: Harness, ua?: string) => new Client(h.app, ua).start();

const totpSecrets = new Map<string, string>();

/** Signs in and finishes two-step when the role needs it. */
export async function signedIn(h: Harness, email: string, realm: 'partner' | 'ops' = 'partner') {
  const c = await client(h);
  const res = realm === 'ops' ? await c.post('/ops/auth/login', { email, password: PASSWORD }) : await c.login(email);
  const totp = (secret: string) => authenticator.clone({ epoch: h.clock.now().getTime() }).generate(secret);
  if (res.body.mfaState === 'enroll') {
    const setup = await c.post('/auth/mfa/setup');
    totpSecrets.set(email, setup.body.secret);
    const enabled = await c.post('/auth/mfa/enable', { code: totp(setup.body.secret) });
    if (enabled.status !== 204) throw new Error(`enable failed: ${JSON.stringify(enabled.body)}`);
  }
  if (res.body.mfaState === 'pending') {
    h.clock.advance(61_000); // a code can't be reused, so move to a fresh one
    const verified = await c.post('/auth/mfa/verify', { code: totp(totpSecrets.get(email)!) });
    if (verified.status !== 204) throw new Error(`verify failed: ${JSON.stringify(verified.body)}`);
  }
  return c;
}

export const PDF = Buffer.from('%PDF-1.4\nfake test document\n%%EOF\n');

export async function enableProducts(db: pg.Pool, partnerId: string, products = ['used_car', 'loan_against_car', 'personal']) {
  for (const p of products) {
    await db.query('INSERT INTO partner_product (partner_id, product_code, enabled_at) VALUES ($1,$2,now())', [partnerId, p]);
  }
}

export async function createLender(db: pg.Pool, products = ['used_car', 'loan_against_car', 'personal']) {
  const id = uuid();
  await db.query(`INSERT INTO lender (id, name, type) VALUES ($1,'Test Bank','bank')`, [id]);
  for (const p of products) await db.query('INSERT INTO lender_product (lender_id, product_code) VALUES ($1,$2)', [id, p]);
  return id;
}

export const linkToken = (text: string) => /token=([\w-]+)/.exec(text)?.[1] ?? '';

let caseSeq = 0;

/** Takes a case all the way through the wizard: draft, documents, customer consent, submit. */
export async function makeCase(h: Harness, c: Client, lenderId: string, over: { name?: string; phone?: string; amount?: number } = {}) {
  caseSeq += 1;
  const n = String(1000 + caseSeq + Math.floor(Math.random() * 8000)).slice(-4);
  const draft = (await c.post('/cases/drafts').set('idempotency-key', uuid())).body;
  const saved = await c.patch(`/cases/drafts/${draft.id}`, {
    version: draft.version,
    data: {
      setup: { product: 'used_car', loanType: 'purchase', lenderId },
      applicant: {
        fullName: over.name ?? 'Ravi Kumar', email: `cust-${uuid()}@example.test`, phone: over.phone ?? `98765${n}0`.slice(0, 10), pan: `ABCDE${n}F`,
        aadhaarLast4: '4321', dob: '1990-05-01', address: '12 Test Road, Delhi', pincode: '110001', city: 'Delhi', state: 'Delhi',
      },
      details: {
        carMake: 'Maruti', carModel: 'Swift', carYear: 2020, registrationNumber: `MH12AB${n}`, chassisNumber: 'CHASSIS123',
        engineNumber: 'ENGINE1234', carValue: 600000, seller: 'dealer',
      },
      loan: { amount: over.amount ?? 400000, tenureMonths: 48, purpose: 'Buy a car' },
      income: { employmentType: 'salaried', monthlyIncome: 60000, companyName: 'Acme', workExperienceYears: 5, existingEmi: 5000 },
      documents: { aadhaarMaskedConfirmed: true },
    },
  });
  if (saved.status !== 200) throw new Error(`draft failed: ${JSON.stringify(saved.body)}`);
  for (const d of saved.body.requiredDocuments.filter((x: { required: boolean }) => x.required)) {
    await c.upload(`/cases/drafts/${draft.id}/documents/${d.code}`, PDF);
  }
  await c.post(`/cases/drafts/${draft.id}/consent-requests`);
  await new Promise((r) => setImmediate(r));
  const link = h.mail.messages.find((m) => m.subject.includes('confirm your loan'))!;
  const token = /\/consent\/([\w-]+)/.exec(link.text)![1];
  const customer = await client(h, 'customer-phone');
  await customer.post(`/public/consent/${token}/code`);
  const code = /\b(\d{6})\b/.exec(h.mail.messages[0]!.text)![1];
  await customer.post(`/public/consent/${token}`, { code });
  const res = await c.post(`/cases/drafts/${draft.id}/submit`, { confirmDuplicate: true }).set('idempotency-key', uuid());
  if (res.status !== 201) throw new Error(`submit failed: ${JSON.stringify(res.body)}`);
  return { id: res.body.id as string, caseNo: res.body.caseNo as string, registration: `MH12AB${n}` };
}

export const opsSession = async (h: Harness, role: Role) => signedIn(h, (await createUser(h.db, null, role)).email, 'ops');

export const opsVersion = async (ops: Client, id: string) => String((await ops.get(`/ops/cases/${id}`)).body.version);

export async function opsMove(ops: Client, id: string, body: object) {
  const version = await opsVersion(ops, id);
  return ops.post(`/ops/cases/${id}/transitions`, body).set('if-match', version);
}

/** Runs a case from REGISTERED to DISBURSAL_IN_PROGRESS. */
export async function toDisbursing(ops: Client, id: string, lenderId: string, sanctionedAmount = 400000) {
  for (const body of [
    { to: 'IN_REVIEW', lenderId },
    { to: 'APPROVED', sanctionedAmount, roiBps: 1150, tenureMonths: 48 },
    { to: 'CUSTOMER_APPROVED' },
    { to: 'DISBURSAL_IN_PROGRESS', checklistComplete: true },
  ]) {
    const res = await opsMove(ops, id, body);
    if (res.status !== 200) throw new Error(`move failed: ${JSON.stringify(res.body)}`);
  }
}

let utrSeq = 0;
export const utr = () => `UTR${Date.now()}${String((utrSeq += 1)).padStart(4, '0')}`.slice(0, 22);

export async function disburse(h: Harness, ops: Client, id: string, amount: number, isFinal = true) {
  const version = await opsVersion(ops, id);
  return ops.post(`/ops/cases/${id}/disbursals`, { utr: utr(), amount, disbursedOn: h.clock.now().toISOString().slice(0, 10), isFinal }).set('if-match', version);
}
