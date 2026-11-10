import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Browser, type Page, expect, test } from '@playwright/test';
import { authenticator } from 'otplib';

interface Account { email: string; password: string; role: string; partner: string }
const accounts: Account[] = JSON.parse(readFileSync(join(import.meta.dirname, '../../../.dev/seed-credentials.json'), 'utf8'));
const GAMMA = 'PUN-411-0003';
const find = (role: string, partner = GAMMA) => accounts.find((a) => a.role === role && a.partner === partner)!;
const staff = (handle: string) => accounts.find((a) => a.email === `${handle}@vittora.test`)!;
const inbox = async (page: Page) => (await (await page.request.get('/api/v1/dev/mail')).json()).data as { to: string; subject: string; text: string }[];

async function signIn(page: Page, a: { email: string; password: string }, path = '/signin') {
  await page.goto(path);
  await page.getByLabel('Email address').fill(a.email);
  await page.getByLabel('Password').fill(a.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((u) => !u.pathname.endsWith('signin'));
  if (/two-step\/setup/.test(page.url())) {
    const secret = await page.getByTestId('mfa-secret').innerText();
    await page.getByLabel('6-digit code').fill(authenticator.generate(secret));
    await page.getByRole('button', { name: 'Turn on' }).click();
  }
}

async function asStaff(browser: Browser, handle: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, staff(handle), '/ops/signin');
  await expect(page.getByRole('link', { name: 'Partners' })).toBeVisible();
  return { page, close: () => context.close() };
}

/** Creates a case through the API with the page's own session, so this test can focus on what comes after. */
async function createCase(page: Page, name: string) {
  const csrf = (await (await page.request.get('/api/v1/auth/csrf')).json()).csrfToken as string;
  const headers = { 'x-csrf-token': csrf };
  const n = String(Date.now()).slice(-4);
  const draft = await (await page.request.post('/api/v1/cases/drafts', { headers: { ...headers, 'idempotency-key': `e2e-${Date.now()}` } })).json();
  const lenders = await (await page.request.get('/api/v1/lenders?product=used_car')).json();
  const lenderId = lenders.data.find((l: { name: string }) => l.name === 'Test Bank One').id;
  const email = `customer-${Date.now()}@example.test`;
  const saved = await (await page.request.patch(`/api/v1/cases/drafts/${draft.id}`, {
    headers,
    data: {
      version: draft.version,
      data: {
        setup: { product: 'used_car', loanType: 'purchase', lenderId },
        applicant: { fullName: name, email, phone: `98765${n}1`, pan: `ABCDE${n}F`, aadhaarLast4: '4321', dob: '1990-05-01', address: '12 Test Road', pincode: '411001', city: 'Pune', state: 'Maharashtra' },
        details: { carMake: 'Maruti', carModel: 'Swift', carYear: 2020, registrationNumber: `MH12AB${n}`, chassisNumber: 'CHASSIS123', engineNumber: 'ENGINE1234', carValue: 600000, seller: 'dealer' },
        loan: { amount: 400000, tenureMonths: 48, purpose: 'Buy a car' },
        income: { employmentType: 'salaried', monthlyIncome: 60000, companyName: 'Acme', workExperienceYears: 5, existingEmi: 5000 },
        documents: { aadhaarMaskedConfirmed: true },
      },
    },
  })).json();
  for (const d of saved.requiredDocuments.filter((x: { required: boolean }) => x.required)) {
    await page.request.post(`/api/v1/cases/drafts/${draft.id}/documents/${d.code}`, {
      headers, multipart: { file: { name: `${d.code}.pdf`, mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\nfake test file\n%%EOF\n') } },
    });
  }
  await page.request.post(`/api/v1/cases/drafts/${draft.id}/consent-requests`, { headers });
  const phone = `sms:+9198765${n}1`;
  const consentMail = async () => (await inbox(page)).find((m) => m.to === phone && /\/consent\//.test(m.text));
  await expect.poll(async () => !!(await consentMail())).toBe(true);
  const link = /\/consent\/([\w-]+)/.exec((await consentMail())!.text)![1];
  await page.request.post(`/api/v1/public/consent/${link}/code`, { headers });
  const code = /\b(\d{6})\b/.exec((await inbox(page)).find((m) => m.to === phone && m.subject === 'Your consent code')!.text)![1];
  await page.request.post(`/api/v1/public/consent/${link}`, { headers, data: { code } });
  const made = await (await page.request.post(`/api/v1/cases/drafts/${draft.id}/submit`, { headers: { ...headers, 'idempotency-key': `e2e-${Date.now()}` }, data: {} })).json();
  return { id: made.id as string, caseNo: made.caseNo as string, registration: `MH12AB${n}`, phoneTail: `${n}1`.slice(-4) };
}

async function opsMove(page: Page, to: string, fill: () => Promise<void> = async () => {}) {
  await page.getByLabel('Move to').selectOption({ label: to });
  await fill();
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByRole('main').getByText(to, { exact: true }).first()).toBeVisible();
}

test('a case runs from creation to paid commission, across partner and staff screens', async ({ page, browser }) => {
  test.slow();
  await signIn(page, find('admin'));
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  const c = await createCase(page, 'Meera Nair');

  // All Cases: masked, searchable.
  await page.getByRole('link', { name: 'All Cases' }).click();
  await expect(page.getByRole('link', { name: c.caseNo })).toBeVisible();
  await expect(page.getByRole('main')).toContainText('M**** N***');
  await expect(page.getByRole('main')).not.toContainText('Meera');
  await page.getByLabel(/Search case ID/).fill(c.registration);
  await page.getByLabel(/Search case ID/).press('Enter');
  await expect(page).toHaveURL(/q=MH12AB/);
  await expect(page.getByRole('link', { name: c.caseNo })).toBeVisible();

  // Case detail: reveal needs a reason, notes save.
  await page.getByRole('link', { name: c.caseNo }).click();
  await page.getByRole('button', { name: 'Show' }).first().click();
  await page.getByLabel('Reason').fill('Calling about the documents');
  await page.getByRole('button', { name: 'Show details' }).click();
  await expect(page.getByTestId('revealed-phone')).toContainText(c.phoneTail);
  await page.getByLabel('Add a note').fill('Spoke to the customer');
  await page.getByRole('button', { name: 'Save note' }).click();
  await expect(page.getByText('Spoke to the customer', { exact: true })).toBeVisible();

  // Ops picks it up and sends it back.
  const agent = await asStaff(browser, 'ops.agent');
  await agent.page.goto(`/ops/cases/${c.id}`);
  await expect(agent.page.getByText('Customer identity is not shown')).toBeVisible();
  await expect(agent.page.getByRole('main')).not.toContainText('Meera');
  await agent.page.getByRole('button', { name: 'Take this case' }).click();
  await expect(agent.page.getByRole('button', { name: 'Take this case' })).toBeHidden();
  await opsMove(agent.page, 'In Review');
  await agent.page.getByLabel('Move to').selectOption({ label: 'Needs Action' });
  await agent.page.getByLabel('Note').fill('Bank statement is unreadable');
  await agent.page.getByRole('button', { name: 'Apply' }).click();
  await expect(agent.page.getByText('Bank statement is unreadable').first()).toBeVisible();

  // The partner sees the bell and answers.
  await page.reload();
  await expect(page.getByTestId('unread')).toBeVisible();
  await expect(page.getByText('This case needs your action')).toBeVisible();
  await page.getByLabel('What did you change?').fill('Uploaded a clear statement');
  await page.getByRole('button', { name: 'Send back for review' }).click();
  await expect(page.getByText('Uploaded a clear statement')).toBeVisible();

  // Ops takes it through to disbursal.
  await agent.page.reload();
  await opsMove(agent.page, 'Approved', async () => {
    await agent.page.getByLabel('Rate of interest').fill('11.5');
  });
  await opsMove(agent.page, 'Customer Approved');
  await opsMove(agent.page, 'Disbursing', async () => {
    await agent.page.getByLabel('The disbursal checklist is complete').check();
  });
  await agent.page.getByLabel('UTR').fill(`UTR${Date.now()}`);
  await agent.page.getByLabel('Amount (Rs)').fill('400000');
  await agent.page.getByLabel('Date', { exact: true }).fill(new Date().toISOString().slice(0, 10));
  await agent.page.getByLabel('This is the final disbursal').check();
  await agent.page.getByRole('button', { name: 'Record disbursal' }).click();
  await expect(agent.page.getByRole('main').getByText('Disbursed', { exact: true }).first()).toBeVisible();
  await agent.close();

  // Dashboard and invoice.
  await page.goto('/app/dashboard');
  await expect(page.getByTestId('stage-disbursed')).toContainText('1');
  await page.getByRole('link', { name: 'Invoices' }).click();
  await page.getByRole('link', { name: 'Not raised' }).click();
  await expect(page.getByText('₹4,640.00')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Raise invoice' })).toBeDisabled();
  await expect(page.getByText(/must be verified before you can raise/)).toBeVisible();

  // Bank and GST, then staff verify them.
  await page.getByRole('link', { name: 'Open Settings' }).click();
  await page.getByLabel('We are GST registered').check();
  await page.getByLabel('GSTIN').fill('27ABCDE1234F1Z5');
  await page.getByLabel('PAN', { exact: true }).fill('ABCDE1234F');
  await page.getByLabel('Bank account number').fill('123456789012');
  await page.getByLabel('IFSC').fill('HDFC0001234');
  await page.getByLabel('Bank name').fill('Test Bank');
  await page.getByLabel('Branch').fill('Pune');
  await page.getByRole('button', { name: 'Save and send for verification' }).click();
  await expect(page.getByText('Pending verification')).toBeVisible();
  await expect(page.getByText('A/c ••••9012')).toBeVisible();

  const reviewer = await asStaff(browser, 'super.admin');
  await reviewer.page.getByRole('button', { name: 'All partners' }).click();
  await reviewer.page.getByRole('row', { name: /Gamma Autos/ }).getByRole('link', { name: 'Open' }).click();
  await reviewer.page.getByRole('button', { name: 'Show details' }).click();
  await expect(reviewer.page.getByText('123456789012')).toBeVisible();
  await reviewer.page.getByRole('button', { name: 'Verify' }).click();
  await expect(reviewer.page.getByText('Verified')).toBeVisible();
  await reviewer.close();

  // Raise: GST 18% and TDS 2% on a 1% commission of Rs 4,00,000.
  await page.goto('/app/invoices');
  await page.getByRole('link', { name: 'Not raised' }).click();
  await page.getByRole('button', { name: 'Raise invoice' }).click();
  await expect(page.getByRole('heading', { name: /INV\/\d{4}-\d{2}\/000001/ })).toBeVisible();
  await expect(page.getByText('₹4,640.00')).toBeVisible();

  // Finance: one person records the payout, a second confirms it.
  const one = await asStaff(browser, 'finance.one');
  await one.page.getByRole('link', { name: 'Invoices' }).click();
  await one.page.getByRole('button', { name: 'Approve' }).click();
  await one.page.getByLabel('Payout reference').fill('NEFT-E2E-1');
  await one.page.getByRole('button', { name: 'Record payout' }).click();
  await expect(one.page.getByRole('button', { name: 'Confirm paid' })).toBeDisabled();
  await one.close();
  const two = await asStaff(browser, 'finance.two');
  await two.page.getByRole('link', { name: 'Invoices' }).click();
  await two.page.getByRole('button', { name: 'Confirm paid' }).click();
  await expect(two.page.getByRole('cell', { name: 'Paid', exact: true })).toBeVisible();
  await two.close();

  await page.goto('/app/invoices');
  await expect(page.getByText('Paid lifetime')).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Paid', exact: true })).toBeVisible();
  await expect(page.getByText('₹4,640.00').first()).toBeVisible();
});

test('an Admin invites a teammate, who joins and is then deactivated', async ({ page, browser }) => {
  test.slow();
  await signIn(page, find('manager'));
  await expect(page.getByRole('link', { name: 'Users' })).toBeHidden();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL(/signin/);

  const admin = find('admin');
  await page.goto('/signin');
  await page.getByLabel('Email address').fill(admin.email);
  await page.getByLabel('Password').fill(admin.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/two-step$/);
  await page.getByRole('button', { name: 'Email me a code instead' }).click();
  await expect(page.getByRole('status')).toContainText('emailed');
  const code = (await inbox(page)).find((m) => m.to === admin.email && /sign-in code/.test(m.subject))!;
  await page.getByLabel('6-digit code').fill(/(\d{6})/.exec(code.text)![1]!);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

  await page.getByRole('link', { name: 'Users' }).click();
  const stamp = Date.now();
  const joinerName = `Joiner ${stamp}`;
  const email = `joiner-${stamp}@gamma.test`;
  await page.getByRole('button', { name: 'Invite user' }).click();
  await page.getByLabel('Name').fill(joinerName);
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Send invite', exact: true }).click();
  await expect(page.getByText('Invite sent.')).toBeVisible();
  await expect(page.getByRole('row', { name: new RegExp(joinerName) })).toContainText('Invited');

  const context = await browser.newContext();
  const joiner = await context.newPage();
  await expect.poll(async () => (await inbox(page)).some((m) => m.to === email)).toBe(true);
  const mail = (await inbox(page)).find((m) => m.to === email)!;
  await joiner.goto(/https?:\/\/\S+/.exec(mail.text)![0]);
  const password = `e2e-${Date.now()}-Secret`;
  await joiner.getByLabel('New password', { exact: true }).fill(password);
  await joiner.getByLabel('Confirm new password').fill(password);
  await joiner.getByRole('button', { name: 'Save password' }).click();
  await expect(joiner.getByRole('status')).toContainText('saved');
  await signIn(joiner, { email, password });
  await expect(joiner.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(joiner.getByRole('link', { name: 'Invoices' })).toBeHidden();

  await page.reload();
  const row = page.getByRole('row', { name: new RegExp(joinerName) });
  await row.getByRole('button', { name: 'Deactivate' }).click();
  await row.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByRole('row', { name: new RegExp(joinerName) })).toContainText('Inactive');
  await joiner.reload();
  await expect(joiner).toHaveURL(/signin/);
  await context.close();
});

test('Help is searchable, and a phone-width screen does not scroll sideways', async ({ page }) => {
  await signIn(page, find('viewer'));
  await page.setViewportSize({ width: 375, height: 800 });
  for (const path of ['/app/dashboard', '/app/cases', '/app/settings', '/app/help']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, path).toBeLessThanOrEqual(0);
  }
  await page.getByLabel('Search help').fill('clawback');
  await expect(page.getByRole('heading', { name: 'Clawbacks' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Quick start' })).toBeHidden();
});
