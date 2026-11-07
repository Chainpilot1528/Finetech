import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { authenticator } from 'otplib';

interface Account { email: string; password: string; role: string; partner: string }
const accounts: Account[] = JSON.parse(readFileSync(join(import.meta.dirname, '../../../.dev/seed-credentials.json'), 'utf8'));
const find = (role: string, partner = 'DEL-110-0001') => accounts.find((a) => a.role === role && a.partner === partner)!;

async function signIn(page: Page, a: Pick<Account, 'email' | 'password'>) {
  await page.goto('/signin');
  await page.getByLabel('Email address').fill(a.email);
  await page.getByLabel('Password').fill(a.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

const inbox = async (page: Page) => (await (await page.request.get('/api/v1/dev/mail')).json()).data as { to: string; subject: string; text: string }[];

test('a wrong password shows a generic error', async ({ page }) => {
  await signIn(page, { email: find('viewer').email, password: 'definitely-not-it' });
  await expect(page.getByText('Incorrect email or password.')).toBeVisible();
});

test('Viewer signs in and only sees what the role allows', async ({ page }) => {
  await signIn(page, find('viewer'));
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(nav.getByRole('link', { name: 'All Cases' })).toBeVisible();
  for (const hidden of ['Create Case', 'Invoices', 'Users']) await expect(nav.getByRole('link', { name: hidden })).toHaveCount(0);
  await expect(page.getByTestId('org-name')).toHaveText('Alpha Motors');
});

test('Executive sees Create Case but not Users, and sign out really signs out', async ({ page }) => {
  await signIn(page, find('executive'));
  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(nav.getByRole('link', { name: 'Create Case' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Users' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/signin/);
  await page.goto('/app/dashboard');
  await expect(page).toHaveURL(/signin/);
});

test('signed-out visitors can not open the app', async ({ page }) => {
  await page.goto('/app/users');
  await expect(page).toHaveURL(/signin/);
});

test('Admin must set up two-step, then sees only their own team', async ({ page, context }) => {
  const admin = find('admin');
  await signIn(page, admin);
  await expect(page).toHaveURL(/two-step\/setup/);
  const secret = await page.getByTestId('mfa-secret').innerText();
  await page.getByLabel('6-digit code').fill(authenticator.generate(secret));
  await page.getByRole('button', { name: 'Turn on' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

  await page.getByRole('link', { name: 'Users' }).click();
  await expect(page.getByRole('cell', { name: 'admin@alpha.test' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'admin@beta.test' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Sign out' }).click();
  await context.clearCookies();
  await signIn(page, admin);
  await expect(page).toHaveURL(/two-step$/);
  await page.getByRole('button', { name: 'Email me a code instead' }).click();
  await expect(page.getByRole('status')).toContainText('emailed');
  const mail = (await inbox(page)).find((m) => m.to === admin.email && /sign-in code/.test(m.subject))!;
  await page.getByLabel('6-digit code').fill(/(\d{6})/.exec(mail.text)![1]!);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
});

test('an invited user sets a first password from the emailed link', async ({ page }) => {
  await page.goto('/forgot-password');
  await page.getByLabel('Email address').fill('invited@alpha.test');
  await page.getByRole('button', { name: 'Send link' }).click();
  await expect(page.getByRole('status')).toContainText('on its way');

  await page.goto('/dev/inbox');
  await page.getByRole('link', { name: /reset-password/ }).first().click();
  const password = `e2e-${Date.now()}-Secret`;
  await page.getByLabel('New password', { exact: true }).fill(password);
  await page.getByLabel('Confirm new password').fill(password);
  await page.getByRole('button', { name: 'Save password' }).click();
  await expect(page.getByRole('status')).toContainText('saved');

  await signIn(page, { email: 'invited@alpha.test', password });
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
});

test('works at phone width with no sideways scroll and a working menu', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page, find('executive', 'MUM-400-0002'));
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
});

test('pages carry security headers and run clean under the CSP', async ({ page }) => {
  const violations: string[] = [];
  page.on('console', (m) => { if (/content security policy/i.test(m.text())) violations.push(m.text()); });
  const res = await page.goto('/signin');
  const headers = res!.headers();
  expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(headers['x-frame-options']).toBe('DENY');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  expect(violations).toEqual([]);
});

test('the session is not readable by page scripts', async ({ page }) => {
  await signIn(page, find('viewer', 'MUM-400-0002'));
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  const visible = await page.evaluate(() => document.cookie + JSON.stringify(localStorage) + JSON.stringify(sessionStorage));
  expect(visible).not.toContain('vittora_session');
});
