import { describe, expect, it } from 'vitest';
import { checkAccess, linksText } from '../../../scripts/demo-auth.js';
import { cloudflaredAsset } from '../../../scripts/demo-tools.js';

/** The demo tunnel's password proxy (D-031). */
const pw = { SITE_USER: 'client', SITE_PASS: 'site-secret', INBOX_USER: 'inbox', INBOX_PASS: 'inbox-secret' };
const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

describe('demo password proxy', () => {
  it('asks for a password when none or a wrong one is given', () => {
    expect(checkAccess('/signin', undefined, pw)).toEqual({ ok: false, realm: 'Vittora demo' });
    expect(checkAccess('/signin', basic('client', 'nope'), pw).ok).toBe(false);
    expect(checkAccess('/inbox', undefined, pw)).toEqual({ ok: false, realm: 'Vittora demo inbox' });
  });

  it('opens the app with the site password but keeps the inbox closed', () => {
    expect(checkAccess('/ops/signin', basic('client', 'site-secret'), pw).ok).toBe(true);
    expect(checkAccess('/inbox', basic('client', 'site-secret'), pw).ok).toBe(false);
  });

  it('keeps the app open after the browser switches to the inbox password', () => {
    // Browsers keep one password per site and send the last one everywhere, so after visiting
    // /inbox every app request carries the inbox password. It must still open the app.
    expect(checkAccess('/inbox', basic('inbox', 'inbox-secret'), pw).ok).toBe(true);
    expect(checkAccess('/api/v1/auth/login', basic('inbox', 'inbox-secret'), pw).ok).toBe(true);
    expect(checkAccess('/ops/signin', basic('inbox', 'inbox-secret'), pw).ok).toBe(true);
  });
});

describe('links.txt', () => {
  it('lists the main pages on the current link', () => {
    const text = linksText('https://abc-def.trycloudflare.com', new Date('2026-11-18T10:00:00Z'));
    for (const path of ['/inbox', '/signin', '/app/create-case', '/ops/signin', '/ops/cases']) {
      expect(text).toContain(`https://abc-def.trycloudflare.com${path}`);
    }
    expect(text).not.toMatch(/PASS=/);
  });
});

describe('cloudflared download', () => {
  const base = 'https://github.com/cloudflare/cloudflared/releases/latest/download/';
  it('fetches the Mac archive on a Mac', () => {
    expect(cloudflaredAsset('darwin', 'arm64')).toEqual({ url: `${base}cloudflared-darwin-arm64.tgz`, archive: true });
    expect(cloudflaredAsset('darwin', 'x64')).toEqual({ url: `${base}cloudflared-darwin-amd64.tgz`, archive: true });
  });

  it('fetches the plain Linux program in a codespace', () => {
    expect(cloudflaredAsset('linux', 'x64')).toEqual({ url: `${base}cloudflared-linux-amd64`, archive: false });
    expect(cloudflaredAsset('linux', 'arm64')).toEqual({ url: `${base}cloudflared-linux-arm64`, archive: false });
  });

  it('refuses other systems', () => {
    expect(() => cloudflaredAsset('win32', 'x64')).toThrow(/macOS or Linux/);
  });
});
