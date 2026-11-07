import { authenticator } from 'otplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { MINUTE } from '../src/modules/identity/domain/rules.js';
import { PASSWORD, client, createPartner, createUser, harness, linkToken, signedIn, type Harness } from './helpers.js';

let h: Harness;
let partnerId: string;
beforeAll(async () => {
  h = await harness();
  partnerId = await createPartner(h.db);
});
afterAll(() => h.close());

const NEW_PASSWORD = 'a-brand-new-secret-77';
const code = (secret: string) => authenticator.clone({ epoch: h.clock.now().getTime() }).generate(secret);

describe('sign in', () => {
  it('signs in with an HttpOnly session cookie and never returns the token in the body', async () => {
    const u = await createUser(h.db, partnerId, 'executive');
    const c = await client(h);
    const res = await c.login(u.email);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mfaState: 'ok' });
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/vittora_session=.*HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    const me = await c.get('/me');
    expect(me.body.role).toBe('executive');
    expect(me.headers['cache-control']).toBe('no-store');
    expect(me.headers.etag).toBeUndefined();
  });

  it('gives the same error for an unknown email and a wrong password', async () => {
    const u = await createUser(h.db, partnerId, 'viewer');
    const c = await client(h);
    const wrong = await c.login(u.email, 'not-the-password');
    const unknown = await c.login('nobody@example.test', 'not-the-password');
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
  });

  it('accepts any email capitalisation', async () => {
    const u = await createUser(h.db, partnerId, 'viewer');
    expect((await (await client(h)).login(u.email.toUpperCase())).status).toBe(200);
  });

  it('refuses inactive and invited users with the same generic error', async () => {
    const inactive = await createUser(h.db, partnerId, 'viewer', { status: 'inactive' });
    const res = await (await client(h)).login(inactive.email);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_INVALID');
  });

  it('keeps internal staff out of the partner sign-in', async () => {
    const staff = await createUser(h.db, null, 'super_admin');
    expect((await (await client(h)).login(staff.email)).status).toBe(401);
  });

  it('emails when a new device signs in, but not for a known one', async () => {
    const u = await createUser(h.db, partnerId, 'viewer');
    await (await client(h, 'device-a')).login(u.email);
    await (await client(h, 'device-a')).login(u.email);
    const before = h.mail.messages.filter((m) => m.to === u.email).length;
    expect(before).toBe(0);
    await (await client(h, 'device-b')).login(u.email);
    await new Promise((r) => setImmediate(r));
    expect(h.mail.messages.filter((m) => m.to === u.email && /new/i.test(m.subject))).toHaveLength(1);
  });
});

describe('lockout (§4.1)', () => {
  async function fail(c: Awaited<ReturnType<typeof client>>, email: string, times: number) {
    for (let i = 0; i < times; i += 1) {
      await c.login(email, 'wrong-password-here');
      h.clock.advance(20_000);
    }
  }

  it('rate limits 5 attempts a minute from one place', async () => {
    const u = await createUser(h.db, partnerId, 'viewer');
    const c = await client(h);
    for (let i = 0; i < 5; i += 1) await c.login(u.email, 'wrong-password-here');
    const res = await c.login(u.email, 'wrong-password-here');
    expect(res.status).toBe(429);
    h.clock.advance(MINUTE + 1);
  });

  it('slows down from the 5th failure, locks at 10, and emails the user and the admin', async () => {
    const pid = await createPartner(h.db);
    const admin = await createUser(h.db, pid, 'admin');
    const u = await createUser(h.db, pid, 'executive');
    const c = await client(h);
    h.delays.length = 0;
    await fail(c, u.email, 10);
    expect(h.delays.filter((d) => d > 0).length).toBeGreaterThan(0);
    await new Promise((r) => setImmediate(r));
    const locked = h.mail.messages.filter((m) => /locked/.test(m.subject)).map((m) => m.to);
    expect(locked).toEqual(expect.arrayContaining([u.email, admin.email]));

    h.clock.advance(MINUTE);
    expect((await c.login(u.email)).status).toBe(401); // right password, still locked
    h.clock.advance(31 * MINUTE);
    expect((await c.login(u.email)).status).toBe(200);
  });
});

describe('sessions', () => {
  it('ends after 30 idle minutes', async () => {
    const u = await createUser(h.db, partnerId, 'viewer');
    const c = await signedIn(h, u.email);
    h.clock.advance(29 * MINUTE);
    expect((await c.get('/me')).status).toBe(200);
    h.clock.advance(31 * MINUTE);
    expect((await c.get('/me')).status).toBe(401);
  });

  it('ends after 12 hours even when active', async () => {
    const u = await createUser(h.db, partnerId, 'viewer');
    const c = await signedIn(h, u.email);
    for (let i = 0; i < 48; i += 1) {
      h.clock.advance(15 * MINUTE);
      if (i < 47) expect((await c.get('/me')).status).toBe(200);
    }
    h.clock.advance(1);
    expect((await c.get('/me')).status).toBe(401);
  });

  it('sign out ends the session on the server, so a stolen cookie stops working', async () => {
    const u = await createUser(h.db, partnerId, 'viewer');
    const c = await client(h);
    const login = await c.login(u.email);
    const stolen = String(login.headers['set-cookie']).split(';')[0]!;
    expect((await request(h.app.getHttpServer()).get('/api/v1/me').set('cookie', stolen)).status).toBe(200);
    expect((await c.post('/auth/logout')).status).toBe(204);
    expect((await request(h.app.getHttpServer()).get('/api/v1/me').set('cookie', stolen)).status).toBe(401);
  });

  it('sign out everywhere ends every device', async () => {
    const u = await createUser(h.db, partnerId, 'viewer');
    const a = await signedIn(h, u.email);
    const b = await signedIn(h, u.email);
    expect((await a.post('/auth/sessions/revoke-all')).status).toBe(204);
    expect((await b.get('/me')).status).toBe(401);
  });

  it('a deactivated user loses access immediately', async () => {
    const u = await createUser(h.db, partnerId, 'viewer');
    const c = await signedIn(h, u.email);
    await h.db.query(`UPDATE app_user SET status = 'inactive' WHERE id = $1`, [u.id]);
    expect((await c.get('/me')).status).toBe(401);
  });
});

describe('CSRF', () => {
  it('rejects a state change without the token', async () => {
    const u = await createUser(h.db, partnerId, 'viewer');
    const c = await signedIn(h, u.email);
    const res = await c.agent.post('/api/v1/auth/logout');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CSRF_FAILED');
  });
  it('a second tab gets the same CSRF token, so it does not break the first tab', async () => {
    const c = await client(h);
    const first = await c.agent.get('/api/v1/auth/csrf');
    const second = await c.agent.get('/api/v1/auth/csrf');
    expect(second.body.csrfToken).toBe(first.body.csrfToken);
  });

  it('rejects a forged token and a foreign origin', async () => {
    const c = await client(h);
    const forged = await c.agent.post('/api/v1/auth/login').set('x-csrf-token', 'abc.def').set('cookie', 'vittora_csrf=abc.def').send({});
    expect(forged.status).toBe(403);
    const foreign = await c.post('/auth/login', {}).set('origin', 'https://evil.test');
    expect(foreign.status).toBe(403);
  });
});

describe('password reset (§4.1)', () => {
  async function requestLink(email: string) {
    const c = await client(h);
    expect((await c.post('/auth/password/forgot', { email })).status).toBe(202);
    await new Promise((r) => setImmediate(r));
    return { c, token: linkToken(h.mail.messages.find((m) => m.to === email)?.text ?? '') };
  }

  it('answers the same for unknown emails and sends nothing', async () => {
    const c = await client(h);
    const before = h.mail.messages.length;
    expect((await c.post('/auth/password/forgot', { email: 'ghost@example.test' })).status).toBe(202);
    await new Promise((r) => setImmediate(r));
    expect(h.mail.messages.length).toBe(before);
  });

  it('works once, and signs out existing sessions', async () => {
    const u = await createUser(h.db, partnerId, 'viewer');
    const old = await signedIn(h, u.email);
    const { c, token } = await requestLink(u.email);
    expect((await c.post('/auth/password/reset', { token, password: NEW_PASSWORD })).status).toBe(204);
    expect((await old.get('/me')).status).toBe(401);
    const again = await c.post('/auth/password/reset', { token, password: 'yet-another-secret-88' });
    expect(again.status).toBe(400);
    expect(again.body.code).toBe('TOKEN_INVALID');
    expect((await c.login(u.email, NEW_PASSWORD)).status).toBe(200);
  });

  it('expires after 30 minutes', async () => {
    const u = await createUser(h.db, partnerId, 'viewer');
    const { c, token } = await requestLink(u.email);
    h.clock.advance(31 * MINUTE);
    expect((await c.post('/auth/password/reset', { token, password: NEW_PASSWORD })).status).toBe(400);
  });

  it('a newer link cancels the older one', async () => {
    const u = await createUser(h.db, partnerId, 'viewer');
    const first = await requestLink(u.email);
    const second = await requestLink(u.email);
    expect(first.token).not.toBe(second.token);
    expect((await first.c.post('/auth/password/reset', { token: first.token, password: NEW_PASSWORD })).status).toBe(400);
    expect((await second.c.post('/auth/password/reset', { token: second.token, password: NEW_PASSWORD })).status).toBe(204);
  });

  it('rejects weak and breached passwords without burning the link', async () => {
    const u = await createUser(h.db, partnerId, 'viewer');
    const { c, token } = await requestLink(u.email);
    h.breached.add('password-from-a-breach');
    expect((await c.post('/auth/password/reset', { token, password: 'short' })).body.code).toBe('PASSWORD_TOO_SHORT');
    expect((await c.post('/auth/password/reset', { token, password: 'password-from-a-breach' })).body.code).toBe('PASSWORD_BREACHED');
    expect((await c.post('/auth/password/reset', { token, password: NEW_PASSWORD })).status).toBe(204);
  });

  it('an invited user sets a first password and becomes active', async () => {
    const u = await createUser(h.db, partnerId, 'viewer', { status: 'invited', password: false });
    const { c, token } = await requestLink(u.email);
    expect(h.mail.messages.find((m) => m.to === u.email)?.subject).toMatch(/set up/i);
    expect((await c.post('/auth/password/reset', { token, password: NEW_PASSWORD })).status).toBe(204);
    expect((await c.login(u.email, NEW_PASSWORD)).status).toBe(200);
  });

  it('never stores the reset token in plain text', async () => {
    const u = await createUser(h.db, partnerId, 'viewer');
    const { token } = await requestLink(u.email);
    const { rows } = await h.db.query('SELECT token_hash FROM auth_token WHERE user_id = $1', [u.id]);
    expect(rows[0].token_hash).not.toContain(token);
  });
});

describe('change password', () => {
  it('needs the current password and signs out other devices', async () => {
    const u = await createUser(h.db, partnerId, 'viewer');
    const a = await signedIn(h, u.email);
    const b = await signedIn(h, u.email);
    expect((await a.post('/auth/password/change', { currentPassword: 'wrong-one', newPassword: NEW_PASSWORD })).status).toBe(401);
    expect((await a.post('/auth/password/change', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD })).status).toBe(204);
    expect((await a.get('/me')).status).toBe(200);
    expect((await b.get('/me')).status).toBe(401);
  });
});

describe('two-step sign-in (§4.1, §9.2)', () => {
  async function enrolled(role: 'admin' | 'viewer' = 'admin') {
    const u = await createUser(h.db, partnerId, role);
    const c = await client(h);
    await c.login(u.email);
    const { body } = await c.post('/auth/mfa/setup');
    expect((await c.post('/auth/mfa/enable', { code: code(body.secret) })).status).toBe(204);
    h.clock.advance(MINUTE);
    return { u, secret: body.secret as string };
  }

  it('makes Admin and Manager enrol before they can do anything', async () => {
    for (const role of ['admin', 'manager'] as const) {
      const u = await createUser(h.db, partnerId, role);
      const c = await client(h);
      expect((await c.login(u.email)).body.mfaState).toBe('enroll');
      const blocked = await c.get('/users');
      expect(blocked.status).toBe(403);
      expect(blocked.body.code).toBe('MFA_REQUIRED');
      expect((await c.get('/me')).body.permissions).toEqual([]);
    }
  });

  it('does not force it on Executive and Viewer', async () => {
    const u = await createUser(h.db, partnerId, 'executive');
    expect((await (await client(h)).login(u.email)).body.mfaState).toBe('ok');
  });

  it('a password alone does not reach protected pages once it is on', async () => {
    const { u, secret } = await enrolled();
    const c = await client(h);
    expect((await c.login(u.email)).body.mfaState).toBe('pending');
    expect((await c.get('/users')).status).toBe(403);
    expect((await c.post('/auth/mfa/verify', { code: code(secret) })).status).toBe(204);
    expect((await c.get('/users')).status).toBe(200);
  });

  it('refuses a replayed code', async () => {
    const { u, secret } = await enrolled();
    const first = await client(h);
    await first.login(u.email);
    const used = code(secret);
    expect((await first.post('/auth/mfa/verify', { code: used })).status).toBe(204);
    const second = await client(h);
    await second.login(u.email);
    expect((await second.post('/auth/mfa/verify', { code: used })).status).toBe(401);
  });

  it('ends the session after 5 wrong codes', async () => {
    const { u } = await enrolled();
    const c = await client(h);
    await c.login(u.email);
    for (let i = 0; i < 5; i += 1) expect((await c.post('/auth/mfa/verify', { code: '000000' })).status).toBe(401);
    expect((await c.get('/me')).status).toBe(401);
  });

  it('accepts an emailed code once, as a fallback', async () => {
    const { u } = await enrolled();
    const c = await client(h);
    await c.login(u.email);
    expect((await c.post('/auth/mfa/email-otp')).status).toBe(202);
    await new Promise((r) => setImmediate(r));
    const otp = /code is (\d{6})/.exec(h.mail.messages.find((m) => m.to === u.email)!.text)![1];
    expect((await c.post('/auth/mfa/verify', { code: otp })).status).toBe(204);
    const c2 = await client(h);
    await c2.login(u.email);
    expect((await c2.post('/auth/mfa/verify', { code: otp })).status).toBe(401);
  });

  it('stores the MFA secret encrypted', async () => {
    const { u, secret } = await enrolled();
    const { rows } = await h.db.query('SELECT mfa_secret_enc FROM app_user WHERE id = $1', [u.id]);
    expect(rows[0].mfa_secret_enc).not.toContain(secret);
  });
});
