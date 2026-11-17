import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { DevMailbox, mailRecipient } from '../src/modules/identity/index.js';
import { loadConfig } from '../src/platform/config.js';

/**
 * Demo mode: a shared test link for a client, with fake data only (D-030). It must keep every
 * message on the server (Mailpit on loopback), use secure cookies, and never open the dev inbox.
 */
const key = randomBytes(32).toString('base64');
const demo = {
  DEPLOY_MODE: 'demo', WEB_ORIGIN: 'https://demo.example.test', APP_DATABASE_URL: 'a', AUTH_DATABASE_URL: 'b',
  OPS_DATABASE_URL: 'c', ENCRYPTION_KEY: key, HMAC_KEY: 'k'.repeat(32), SMTP_URL: 'smtp://127.0.0.1:1025',
};

describe('demo configuration', () => {
  it('accepts the safe demo settings', () => {
    expect(loadConfig(demo).DEPLOY_MODE).toBe('demo');
    expect(loadConfig({ ...demo, SMTP_URL: 'smtp://localhost:1025' }).DEPLOY_MODE).toBe('demo');
  });

  it('refuses the dev inbox', () => {
    expect(() => loadConfig({ ...demo, DEV_MAILBOX: 'true' })).toThrow(/DEV_MAILBOX/);
  });

  it('only sends mail to a test inbox on the same server', () => {
    expect(() => loadConfig({ ...demo, SMTP_URL: undefined })).toThrow(/SMTP_URL/);
    expect(() => loadConfig({ ...demo, SMTP_URL: 'smtp://mail.example.com:587' })).toThrow(/SMTP_URL/);
  });

  it('needs HTTPS and keeps the API off the network', () => {
    expect(() => loadConfig({ ...demo, WEB_ORIGIN: 'http://demo.example.test' })).toThrow(/https/);
    expect(() => loadConfig({ ...demo, API_HOST: '0.0.0.0' })).toThrow(/API_HOST/);
  });
});

describe('texts in demo mode', () => {
  it('turns a text into a message the test inbox can show', () => {
    expect(mailRecipient('sms:+919876543210', true)).toBe('text-919876543210@sms.invalid');
    expect(mailRecipient('someone@example.test', true)).toBe('someone@example.test');
  });

  it('refuses to email a phone number when texts are not allowed through the mail server', () => {
    expect(() => mailRecipient('sms:+919876543210', false)).toThrow(/SMS provider/);
  });
});

describe('demo cookies', () => {
  const storageDir = mkdtempSync(join(tmpdir(), 'vittora-demo-'));
  let close: () => Promise<void> = async () => {};
  afterAll(async () => { await close(); rmSync(storageDir, { recursive: true, force: true }); });

  it('are secure and host-only', async () => {
    const config = loadConfig({
      ...demo, NODE_ENV: 'test', STORAGE_DIR: storageDir, OUTBOX_POLL_MS: '0',
      APP_DATABASE_URL: process.env.TEST_APP_URL, AUTH_DATABASE_URL: process.env.TEST_AUTH_URL, OPS_DATABASE_URL: process.env.TEST_OPS_URL,
    });
    const app = await createApp(config, { mailer: new DevMailbox() });
    await app.init();
    close = () => app.close();
    const res = await request(app.getHttpServer()).get('/api/v1/auth/csrf');
    const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    expect(cookies.length).toBeGreaterThan(0);
    for (const c of cookies) {
      expect(c).toMatch(/^__Host-/);
      expect(c).toMatch(/; Secure/i);
    }
    // The dev inbox is never mounted.
    expect((await request(app.getHttpServer()).get('/api/v1/dev/mail')).status).not.toBe(200);
  });
});
