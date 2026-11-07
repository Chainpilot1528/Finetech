import { Sensitive } from '@vittora/shared-kernel';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decrypt, encrypt } from '../src/platform/crypto.js';
import { loadConfig } from '../src/platform/config.js';
import * as rules from '../src/modules/identity/domain/rules.js';

describe('progressive delay', () => {
  it('starts at the 5th failure and never exceeds 5 seconds', () => {
    expect(rules.progressiveDelayMs(4)).toBe(0);
    expect(rules.progressiveDelayMs(5)).toBe(1000);
    fc.assert(fc.property(fc.nat(10_000), (n) => {
      const d = rules.progressiveDelayMs(n);
      return d >= 0 && d <= 5000 && d <= rules.progressiveDelayMs(n + 1);
    }));
  });
  it('locks at 10 failures', () => {
    expect(rules.shouldLock(9)).toBe(false);
    expect(rules.shouldLock(10)).toBe(true);
  });
});

describe('session lifetime', () => {
  const now = new Date('2026-11-07T10:00:00Z');
  const base = { lastSeenAt: now, expiresAt: new Date(now.getTime() + rules.HOUR), revokedAt: null };
  it('ends after 30 idle minutes', () => {
    expect(rules.isSessionLive(base, new Date(now.getTime() + rules.SESSION_IDLE_MS - 1))).toBe(true);
    expect(rules.isSessionLive(base, new Date(now.getTime() + rules.SESSION_IDLE_MS))).toBe(false);
  });
  it('ends at its absolute expiry, and when revoked', () => {
    expect(rules.isSessionLive({ ...base, lastSeenAt: base.expiresAt }, base.expiresAt)).toBe(false);
    expect(rules.isSessionLive({ ...base, revokedAt: now }, now)).toBe(false);
  });
});

describe('password rules', () => {
  it('needs 10 characters and can not contain the email name', () => {
    expect(rules.passwordProblem('short', 'a@b.c')).toBe('PASSWORD_TOO_SHORT');
    expect(rules.passwordProblem('xx-priya-long-enough', 'priya@b.c')).toBe('PASSWORD_CONTAINS_EMAIL');
    expect(rules.passwordProblem('a-perfectly-fine-one', 'priya@b.c')).toBeNull();
  });
});

describe('platform safety', () => {
  const key = Buffer.alloc(32, 7).toString('base64');
  it('round-trips encryption and detects tampering', () => {
    fc.assert(fc.property(fc.string(), (s) => decrypt(key, encrypt(key, s)) === s));
    const [iv, tag, data] = encrypt(key, 'secret').split('.');
    expect(() => decrypt(key, [iv, tag, `A${data}`].join('.'))).toThrow();
  });
  it('Sensitive never leaks through JSON or strings', () => {
    const s = new Sensitive('ABCDE1234F');
    expect(JSON.stringify({ s })).not.toContain('ABCDE');
    expect(`${s}`).toBe('[REDACTED]');
    expect(s.unwrap()).toBe('ABCDE1234F');
  });
  it('refuses to boot on bad settings', () => {
    expect(() => loadConfig({})).toThrow(/Invalid configuration/);
    expect(() => loadConfig({
      NODE_ENV: 'production', WEB_ORIGIN: 'https://x.test', APP_DATABASE_URL: 'a', AUTH_DATABASE_URL: 'b',
      ENCRYPTION_KEY: key, HMAC_KEY: 'k'.repeat(32), DEV_MAILBOX: 'true',
    })).toThrow(/DEV_MAILBOX/);
  });
});
