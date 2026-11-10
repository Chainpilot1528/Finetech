import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { authenticator } from 'otplib';

interface Account { email: string; password: string; role: string; partner: string }
const accounts: Account[] = JSON.parse(readFileSync(join(import.meta.dirname, '../../../.dev/seed-credentials.json'), 'utf8'));
const find = (role: string, partner = 'DEL-110-0001') => accounts.find((a) => a.role === role && a.partner === partner)!;
const pdf = (name: string) => ({ name, mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\nfake test file\n%%EOF\n') });
const inbox = async (page: Page) => (await (await page.request.get('/api/v1/dev/mail')).json()).data as { to: string; subject: string; text: string }[];

async function signIn(page: Page, a: { email: string; password: string }, path = '/signin') {
  await page.goto(path);
  await page.getByLabel('Email address').fill(a.email);
  await page.getByLabel('Password').fill(a.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

async function enrol(page: Page) {
  await expect(page).toHaveURL(/two-step\/setup/);
  const secret = await page.getByTestId('mfa-secret').innerText();
  await page.getByLabel('6-digit code').fill(authenticator.generate(secret));
  await page.getByRole('button', { name: 'Turn on' }).click();
}

test('a new partner registers, completes KYC, and staff approve it', async ({ page, browser }) => {
  test.slow();
  const stamp = Date.now();
  const email = `owner-${stamp}@newco.test`;
  await page.goto('/signin');
  await page.getByRole('link', { name: /Register as a partner/ }).click();
  await page.getByLabel('Channel name').fill(`NewCo ${stamp}`);
  await page.getByLabel('Registered company name').fill('NewCo Motors Pvt Ltd');
  await page.getByLabel('City').fill('Pune');
  await page.getByLabel('Pincode').fill('411001');
  await page.getByLabel('Business email').fill(`office-${stamp}@newco.test`);
  await page.getByLabel('Used Car Loan').check();
  await page.getByLabel('Personal Loan').check();
  await page.getByLabel('Team size').selectOption('6-10');
  await page.getByLabel('Full name').fill('Neha Test');
  await page.getByLabel('Admin email').fill(email);
  await page.getByRole('button', { name: 'Register' }).click();
  await expect(page.getByRole('status')).toContainText('Reference ID');

  const mail = (await inbox(page)).find((m) => m.to === email)!;
  expect(mail.text).toMatch(/PUN-411-\d+/);
  await page.goto(/https?:\/\/\S+/.exec(mail.text)![0]);
  const password = `e2e-${stamp}-Secret`;
  await page.getByLabel('New password', { exact: true }).fill(password);
  await page.getByLabel('Confirm new password').fill(password);
  await page.getByRole('button', { name: 'Save password' }).click();
  await expect(page.getByRole('status')).toContainText('saved');

  await signIn(page, { email, password });
  await enrol(page);
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

  // Case creation is locked until KYC is approved.
  await page.getByRole('link', { name: 'Create Case' }).click();
  await expect(page.getByText('Your KYC must be approved')).toBeVisible();

  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'KYC' }).click();
  await expect(page.getByRole('button', { name: 'Submit for review' })).toBeDisabled();
  await page.getByRole('button', { name: 'I accept this agreement' }).click();
  await expect(page.getByText('Agreement accepted.')).toBeVisible();
  for (const label of ['PAN card', 'Address proof', 'Bank details (cancelled cheque or statement)']) {
    await page.getByLabel(`Upload ${label}`).setInputFiles(pdf(`${label}.pdf`));
    await expect(page.getByRole('listitem').filter({ hasText: label }).getByText('Uploaded')).toBeVisible();
  }
  await page.getByRole('button', { name: 'Submit for review' }).click();
  await expect(page.getByText('Under review')).toBeVisible();

  const staffContext = await browser.newContext();
  const staff = await staffContext.newPage();
  await signIn(staff, find('kyc_reviewer', 'internal'), '/ops/signin');
  await enrol(staff);
  await expect(staff.getByRole('heading', { name: 'KYC review queue' })).toBeVisible();
  await staff.getByRole('row', { name: new RegExp(`NewCo ${stamp}`) }).getByRole('link', { name: 'Open' }).click();
  await staff.getByRole('button', { name: 'Reject PAN card' }).click();
  await expect(staff.getByText('Say why this document was rejected.')).toBeVisible();
  await staff.getByLabel('Reason for rejecting: PAN card').fill('Photo is blurred');
  await staff.getByRole('button', { name: 'Reject PAN card' }).click();
  await staff.getByRole('button', { name: 'Approve Address proof' }).click();
  await staff.getByRole('button', { name: 'Approve Bank details (cancelled cheque or statement)' }).click();
  await staff.getByRole('button', { name: 'Send back to partner' }).click();
  await expect(staff.getByText('not awaiting review')).toBeVisible();

  await page.reload();
  await expect(page.getByText('Photo is blurred')).toBeVisible();
  await page.getByLabel('Upload PAN card').setInputFiles(pdf('pan-new.pdf'));
  await expect(page.getByText('pan-new.pdf')).toBeVisible();
  await page.getByRole('button', { name: 'Submit for review' }).click();
  await expect(page.getByText('Under review')).toBeVisible();

  await staff.reload();
  await staff.getByRole('button', { name: 'Approve PAN card' }).click();
  await expect(staff.getByText('pan-new.pdf · approved')).toBeVisible();
  await staff.getByRole('button', { name: 'Approve partner' }).click();
  await expect(staff.getByText('not awaiting review')).toBeVisible();
  await staffContext.close();

  await page.reload();
  await expect(page.getByText('Approved. You can create cases.')).toBeVisible();
});

test('an Executive creates a case end to end, with the customer consenting on their own page', async ({ page, browser }) => {
  test.slow();
  await signIn(page, find('executive'));
  await page.getByRole('link', { name: 'Create Case' }).click();
  await page.getByRole('button', { name: 'Start a new case' }).click();

  await page.getByRole('button', { name: 'Next step' }).click();
  await expect(page.getByText('This field is required.').first()).toBeVisible();
  await page.getByLabel('Used Car Loan').check();
  await page.getByLabel(/^Purchase/).check();
  await page.getByLabel('Preferred bank or NBFC').selectOption({ label: 'Test Bank One' });
  await page.getByRole('button', { name: 'Next step' }).click();

  const customerEmail = `customer-${Date.now()}@example.test`;
  await page.getByLabel('Full name').fill('Ravi Test');
  await page.getByLabel('Email (optional)').fill(customerEmail);
  await page.getByLabel('Mobile number').fill('9876543210');
  await page.getByLabel('PAN').fill(`abcde${String(Date.now()).slice(-4)}f`);
  await page.getByLabel('Aadhaar, last 4 digits only').fill('4321');
  await page.getByLabel('Date of birth').fill('2015-01-01');
  await page.getByLabel('Address').fill('12 Test Road');
  await page.getByLabel('Pincode').fill('110001');
  await page.getByLabel('City').fill('Delhi');
  await page.getByLabel('State').fill('Delhi');
  await page.getByRole('button', { name: 'Next step' }).click();
  await expect(page.getByText('must be 18 or older')).toBeVisible();
  await page.getByLabel('Date of birth').fill('1990-01-01');
  await page.getByRole('button', { name: 'Next step' }).click();

  await page.getByLabel('Car make').fill('Maruti');
  await page.getByLabel('Car model').fill('Swift');
  await page.getByLabel('Manufacturing year').fill('2020');
  await page.getByLabel('Registration number').fill(`MH 12 AB ${String(Date.now()).slice(-4)}`);
  await page.getByLabel('Chassis number').fill('CHASSIS123');
  await page.getByLabel('Engine number').fill('ENGINE1234');
  await page.getByLabel('Valuation (₹)').fill('500000');
  await page.getByLabel('Seller').selectOption('dealer');
  await page.getByRole('button', { name: 'Next step' }).click();

  await page.getByLabel('Loan amount (₹)').fill('450000');
  await expect(page.getByText('Loan to value: 90%')).toBeVisible();
  await expect(page.getByText('above the usual 85% limit')).toBeVisible();
  await page.getByLabel('Loan amount (₹)').fill('400000');
  await expect(page.getByText('Loan to value: 80%')).toBeVisible();
  await page.getByLabel('Tenure (months)').fill('48');
  await page.getByRole('button', { name: 'Next step' }).click();

  await page.getByLabel('Employment type').selectOption('salaried');
  await page.getByLabel('Monthly income (₹)').fill('60000');
  await page.getByLabel('Existing EMIs per month (₹)').fill('5000');
  await expect(page.getByText(/Estimated FOIR/)).toBeVisible();
  await page.getByRole('button', { name: 'Next step' }).click();

  await expect(page.getByRole('button', { name: 'Create case' })).toBeDisabled();
  const uploads = page.getByLabel(/^Upload /);
  const labels = await uploads.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')!));
  expect(labels.join()).toContain('Sale agreement');
  expect(labels.join()).toContain('Salary slips');
  expect(labels.join()).not.toContain('ITR');
  for (const label of labels) {
    await page.getByLabel(label, { exact: true }).setInputFiles(pdf('doc.pdf'));
    await expect(page.getByRole('listitem').filter({ hasText: label.replace('Upload ', '') }).getByText('doc.pdf')).toBeVisible();
  }
  await page.getByLabel(/I confirm the Aadhaar copy is masked/).check();
  await page.getByRole('button', { name: 'Send consent link' }).click();
  await expect(page.getByTestId('consent-status')).toContainText('Waiting for the customer');

  // The link goes to the customer's phone only, never to the email typed in the wizard (SEC-01).
  const mail = (await inbox(page)).find((m) => m.to === 'sms:+919876543210' && /\/consent\//.test(m.text))!;
  expect((await inbox(page)).some((m) => m.to === customerEmail)).toBe(false);
  const customerContext = await browser.newContext();
  const customer = await customerContext.newPage();
  await customer.setViewportSize({ width: 375, height: 800 });
  await customer.goto(/https?:\/\/\S+/.exec(mail.text)![0]);
  await expect(customer.getByText('Alpha Motors')).toBeVisible();
  await expect(customer.getByText('Test Bank One')).toBeVisible();
  await expect(customer.getByText('Ravi Test')).toHaveCount(0);
  await customer.getByRole('button', { name: 'Text me a code' }).click();
  await expect(customer.getByText('Code sent')).toBeVisible();
  const code = /\b(\d{6})\b/.exec((await inbox(page)).find((m) => m.subject === 'Your consent code')!.text)![1]!;
  await customer.getByLabel('6-digit code').fill(code);
  await customer.getByRole('button', { name: 'I agree' }).click();
  await expect(customer.getByRole('status')).toContainText('recorded');
  await customerContext.close();

  await expect(page.getByTestId('consent-status')).toContainText('has given consent', { timeout: 3 * Number(process.env.E2E_EXPECT_MS ?? 5_000) });
  await page.getByRole('button', { name: 'Create case' }).click();
  await expect(page.getByTestId('case-no')).toHaveText(/^CASE-\d{6}-[A-Z2-9]{6}$/);
});

test('a saved draft can be resumed after leaving', async ({ page }) => {
  await signIn(page, find('executive'));
  await page.getByRole('link', { name: 'Create Case' }).click();
  await page.getByRole('button', { name: 'Start a new case' }).click();
  await page.getByLabel('Personal Loan').check();
  await page.getByLabel(/^Fresh/).check();
  await page.getByLabel('Preferred bank or NBFC').selectOption({ label: 'Test Bank Two' });
  await page.getByRole('button', { name: 'Next step' }).click();
  await expect(page.getByLabel('Mobile number')).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Continue' }).first().click();
  await expect(page.getByRole('radio', { name: 'Personal Loan', exact: true })).toBeChecked();
});

test('a draft open in two tabs never silently overwrites the other (BUG-01)', async ({ page, context }) => {
  await signIn(page, find('executive'));
  await page.getByRole('link', { name: 'Create Case' }).click();
  await page.getByRole('button', { name: 'Start a new case' }).click();
  await expect(page.getByTestId('reference-id')).toContainText(/[A-Z]+-\d{3}-\d+/);
  await page.getByLabel('Personal Loan').check();
  await page.getByLabel(/^Fresh/).check();
  await page.getByLabel('Preferred bank or NBFC').selectOption({ label: 'Test Bank Two' });
  await page.getByRole('button', { name: 'Next step' }).click();
  await expect(page.getByLabel('Mobile number')).toBeVisible();

  const second = await context.newPage();
  await second.goto(page.url());
  await second.getByRole('button', { name: 'Continue' }).first().click();
  await expect(second.getByRole('radio', { name: 'Personal Loan', exact: true })).toBeChecked();

  // The first tab changes the loan type and saves.
  await page.getByRole('button', { name: 'Previous' }).click();
  await page.getByLabel(/^BT/).check();
  await page.getByRole('button', { name: 'Next step' }).click();
  await expect(page.getByLabel('Mobile number')).toBeVisible();

  // The second tab, still on the old version, is stopped instead of overwriting it.
  await second.getByLabel(/^Top-Up/).check();
  await second.getByRole('button', { name: 'Next step' }).click();
  await expect(second.getByText('changed in another tab')).toBeVisible();
  await second.getByRole('button', { name: 'Load the latest version' }).click();
  await expect(second.getByLabel(/^BT/)).toBeChecked();
  await second.close();
});

test('the wizard fits a phone', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page, find('executive'));
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('link', { name: 'Create Case' }).click();
  await page.getByRole('button', { name: 'Start a new case' }).click();
  await expect(page.getByLabel('Used Car Loan')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
});

test('partner users can not open the ops console', async ({ page }) => {
  await signIn(page, find('viewer'));
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await page.goto('/ops');
  await expect(page).toHaveURL(/app\/dashboard/);
  const res = await page.request.get('/api/v1/ops/partners');
  expect(res.status()).toBe(403);
});
