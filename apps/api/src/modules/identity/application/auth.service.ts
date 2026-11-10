import { randomInt } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { type Clock, DomainError, type Role } from '@vittora/shared-kernel';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import { v7 as uuid } from 'uuid';
import type { Config } from '../../../platform/config.js';
import { decrypt, encrypt, hmac, randomToken, sha256 } from '../../../platform/crypto.js';
import type { Db, Tx } from '../../../platform/db.js';
import { Outbox, type Pending } from '../../../platform/outbox.js';
import { writeAudit } from '../../audit/index.js';
import * as repo from '../adapters/identity.repository.js';
import type { MfaState } from '../adapters/identity.repository.js';
import { type Features, requiresMfa } from '../domain/permissions.js';
import * as rules from '../domain/rules.js';
import {
  BREACHED_PASSWORDS, type BreachedPasswordChecker, CLOCK, CONFIG, DB, DELAY, type Delay,
  type MailMessage,
} from '../ports/index.js';

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

/** Who is calling, resolved from the session cookie. */
export interface Principal {
  userId: string;
  partnerId: string | null;
  role: Role;
  mfaState: MfaState;
  mfaEnabled: boolean;
  features: Features;
  sessionHash: string;
}

const invalidCredentials = () => new DomainError('AUTH_INVALID', 401, 'Incorrect email or password.');
const invalidCode = () => new DomainError('MFA_INVALID_CODE', 401, 'That code is not valid.');

@Injectable()
export class AuthService {
  private dummyHash?: Promise<string>;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(BREACHED_PASSWORDS) private readonly breached: BreachedPasswordChecker,
    @Inject(DELAY) private readonly delay: Delay,
    @Inject(Outbox) private readonly outbox: Outbox,
  ) {}

  private emailKey(email: string, scope = 'login') {
    return hmac(this.config.HMAC_KEY, `${scope}:${email.trim().toLowerCase()}`);
  }

  /** Queues mail in the caller's transaction, so it goes only if the change commits (ARCH-02). */
  private async queue(tx: Tx, topic: string, messages: MailMessage[]): Promise<Pending> {
    const ids: Pending = [];
    for (const m of messages) ids.push(await this.outbox.mail(tx, topic, m));
    return ids;
  }

  /** Mail problems must never break sign-in or reveal whether an account exists; the outbox retries. */
  private async deliver(topic: string, messages: MailMessage[]) {
    if (!messages.length) return;
    const ids = await this.db.withAuth((tx) => this.queue(tx, topic, messages));
    await this.outbox.deliver(ids);
  }

  async login(
    email: string, password: string, meta: RequestMeta, realm: 'partner' | 'ops' = 'partner',
  ): Promise<{ token: string; mfaState: MfaState }> {
    const now = this.clock.now();
    const emailHash = this.emailKey(email);

    const { recentFailures, user } = await this.db.withAuth(async (tx) => {
      const recent = await repo.countRecentAttempts(tx, emailHash, meta.ip, new Date(now.getTime() - rules.MINUTE));
      if (recent >= rules.AUTH_RATE_LIMIT_PER_MINUTE) {
        throw new DomainError('AUTH_RATE_LIMITED', 429, 'Too many attempts. Please wait a minute and try again.');
      }
      return {
        recentFailures: await repo.countRecentFailures(tx, emailHash, new Date(now.getTime() - rules.FAILURE_WINDOW_MS)),
        user: await repo.findUserByEmail(tx, email),
      };
    });

    await this.delay.wait(rules.progressiveDelayMs(recentFailures));

    // Always run a verify, so unknown emails take as long as wrong passwords.
    this.dummyHash ??= argonHash(randomToken());
    const passwordOk = await argonVerify(user?.passwordHash ?? (await this.dummyHash), password);

    const locked = !!user?.lockedUntil && user.lockedUntil > now;
    // Each realm has its own sign-in. Internal staff can't use the partner one, or the reverse (§7.2).
    const inRealm = realm === 'ops' ? user?.partnerId === null : !!user?.partnerId;
    const allowed = !!user && passwordOk && !locked && user.status === 'active' && inRealm;

    if (!allowed) {
      await this.recordFailure(emailHash, recentFailures + 1, user, meta, now);
      throw invalidCredentials();
    }

    const mfaState: MfaState = user.mfaEnabled ? 'pending' : requiresMfa(user.role) ? 'enroll' : 'ok';
    const token = randomToken();
    const deviceHash = hmac(this.config.HMAC_KEY, `${user.id}:${meta.userAgent ?? ''}`);

    const device = await this.db.withAuth(async (tx) => {
      const seen = await repo.hasOtherDevice(tx, user.id, deviceHash);
      await repo.recordAttempt(tx, emailHash, meta.ip, true, now);
      await repo.insertSession(tx, {
        idHash: sha256(token), userId: user.id, partnerId: user.partnerId, mfaState, ip: meta.ip,
        userAgent: meta.userAgent, deviceHash, now, expiresAt: new Date(now.getTime() + rules.SESSION_ABSOLUTE_MS),
      });
      if (mfaState === 'ok') await tx.query('UPDATE app_user SET last_login_at = $2 WHERE id = $1', [user.id, now]);
      await writeAudit(tx, {
        actorId: user.id, partnerId: user.partnerId, action: 'auth.sign_in', entity: 'user', entityId: user.id,
        ip: meta.ip, userAgent: meta.userAgent, after: { mfaState },
      });
      return seen;
    });

    if (!device.isFirstEver && !device.isKnown) {
      await this.deliver('auth.new_device', [{
        to: user.email,
        subject: 'New sign-in to your Vittora account',
        text: 'Your account was just signed in from a new device. If this was not you, reset your password now.',
      }]);
    }
    return { token, mfaState };
  }

  private async recordFailure(
    emailHash: string, failures: number, user: repo.UserRow | null, meta: RequestMeta, now: Date,
  ) {
    const notify = await this.db.withAuth(async (tx) => {
      await repo.recordAttempt(tx, emailHash, meta.ip, false, now);
      const alreadyLocked = !!user?.lockedUntil && user.lockedUntil > now;
      if (!user || alreadyLocked || !rules.shouldLock(failures)) return [];
      await tx.query('UPDATE app_user SET locked_until = $2 WHERE id = $1', [
        user.id, new Date(now.getTime() + rules.LOCK_MS),
      ]);
      await writeAudit(tx, {
        actorId: user.id, partnerId: user.partnerId, action: 'auth.account_locked', entity: 'user', entityId: user.id,
        ip: meta.ip, userAgent: meta.userAgent,
      });
      const admins = user.partnerId ? await repo.findPartnerAdminEmails(tx, user.partnerId) : [];
      return [...new Set([user.email, ...admins])];
    });
    await this.deliver('auth.account_locked', notify.map((to) => ({
      to,
      subject: 'A Vittora account was locked',
      text: 'After too many failed sign-ins, an account in your organisation is locked for 30 minutes.',
    })));
  }

  /** Resolves a session cookie, or null when it is missing, expired, revoked or its user is disabled. */
  async authenticate(token: string | undefined): Promise<Principal | null> {
    if (!token) return null;
    const now = this.clock.now();
    const idHash = sha256(token);
    return this.db.withAuth(async (tx) => {
      const s = await repo.findSession(tx, idHash);
      if (!s || !rules.isSessionLive(s, now) || s.userStatus !== 'active' || s.partnerStatus === 'suspended') return null;
      if (now.getTime() - s.lastSeenAt.getTime() > rules.MINUTE) {
        await tx.query('UPDATE session SET last_seen_at = $2 WHERE id_hash = $1', [idHash, now]);
      }
      return {
        userId: s.userId, partnerId: s.partnerId, role: s.role, mfaState: s.mfaState, mfaEnabled: s.mfaEnabled,
        features: s.features ?? {}, sessionHash: idHash,
      };
    });
  }

  async logout(p: Principal, meta: RequestMeta) {
    const now = this.clock.now();
    await this.db.withAuth(async (tx) => {
      await tx.query('UPDATE session SET revoked_at = $2 WHERE id_hash = $1', [p.sessionHash, now]);
      await writeAudit(tx, { actorId: p.userId, partnerId: p.partnerId, action: 'auth.sign_out', ip: meta.ip, userAgent: meta.userAgent });
    });
  }

  async signOutEverywhere(p: Principal, meta: RequestMeta) {
    const now = this.clock.now();
    await this.db.withAuth(async (tx) => {
      await repo.revokeSessions(tx, p.userId, now);
      await writeAudit(tx, { actorId: p.userId, partnerId: p.partnerId, action: 'auth.sign_out_everywhere', ip: meta.ip, userAgent: meta.userAgent });
    });
  }

  /** Issues a first-password link in the caller's transaction, and returns the URL to send. */
  async issueSetupLink(tx: Tx, userId: string): Promise<string> {
    const now = this.clock.now();
    const token = randomToken();
    await repo.replaceToken(tx, {
      id: uuid(), userId, purpose: 'password_setup', tokenHash: sha256(token),
      expiresAt: new Date(now.getTime() + rules.LINK_TTL_MS), now,
    });
    return `${this.config.WEB_ORIGIN}/reset-password?token=${token}`;
  }

  /** Always succeeds from the caller's view, so it can't be used to discover accounts. */
  async forgotPassword(email: string, meta: RequestMeta): Promise<void> {
    const now = this.clock.now();
    const key = this.emailKey(email, 'forgot');
    const token = randomToken();
    const queued = await this.db.withAuth(async (tx): Promise<Pending> => {
      const recent = await repo.countRecentAttempts(tx, key, meta.ip, new Date(now.getTime() - rules.MINUTE));
      if (recent >= rules.AUTH_RATE_LIMIT_PER_MINUTE) return [];
      await repo.recordAttempt(tx, key, meta.ip, false, now);
      const user = await repo.findUserByEmail(tx, email);
      if (!user || user.status === 'inactive' || user.partnerId === null) return [];
      const purpose = user.status === 'invited' ? 'password_setup' : 'password_reset';
      await repo.replaceToken(tx, {
        id: uuid(), userId: user.id, purpose, tokenHash: sha256(token),
        expiresAt: new Date(now.getTime() + rules.LINK_TTL_MS), now,
      });
      await writeAudit(tx, { actorId: user.id, partnerId: user.partnerId, action: `auth.${purpose}_requested`, entity: 'user', entityId: user.id, ip: meta.ip, userAgent: meta.userAgent });
      const setup = purpose === 'password_setup';
      return this.queue(tx, `auth.${purpose}`, [{
        to: user.email,
        subject: setup ? 'Set up your Vittora password' : 'Reset your Vittora password',
        text: `Open this link within 30 minutes. It works once.\n\n${this.config.WEB_ORIGIN}/reset-password?token=${token}`,
      }]);
    });
    await this.outbox.deliver(queued);
  }

  private async assertPasswordAllowed(password: string, email: string) {
    const problem = rules.passwordProblem(password, email);
    if (problem) throw new DomainError(problem, 422, 'Please choose a stronger password.');
    if (await this.breached.isBreached(password)) {
      throw new DomainError('PASSWORD_BREACHED', 422, 'This password has appeared in a data breach. Please choose another.');
    }
  }

  async resetPassword(token: string, password: string, meta: RequestMeta): Promise<void> {
    const now = this.clock.now();
    const tokenHash = sha256(token);
    const invalid = () => new DomainError('TOKEN_INVALID', 400, 'This link has expired or was already used.');

    const found = await this.db.withAuth(async (tx) => {
      const row = await repo.findLiveToken(tx, tokenHash, ['password_setup', 'password_reset'], now);
      return row ? { row, user: await repo.findUserById(tx, row.userId) } : null;
    });
    if (!found?.user || found.user.status === 'inactive') throw invalid();
    const { row, user } = found;

    // A rejected password leaves the link usable, so the person can try again.
    await this.assertPasswordAllowed(password, user.email);
    const passwordHash = await argonHash(password);

    await this.db.withAuth(async (tx) => {
      if (!(await repo.consumeToken(tx, row.id, now))) throw invalid();
      await tx.query(
        `UPDATE app_user SET password_hash = $2, locked_until = NULL,
           status = CASE WHEN status = 'invited' THEN 'active' ELSE status END WHERE id = $1`,
        [user.id, passwordHash],
      );
      await repo.revokeSessions(tx, user.id, now);
      await writeAudit(tx, { actorId: user.id, partnerId: user.partnerId, action: `auth.${row.purpose}_completed`, entity: 'user', entityId: user.id, ip: meta.ip, userAgent: meta.userAgent });
    });
  }

  async changePassword(p: Principal, current: string, next: string, meta: RequestMeta): Promise<void> {
    const now = this.clock.now();
    const user = await this.db.withAuth((tx) => repo.findUserById(tx, p.userId));
    if (!user?.passwordHash || !(await argonVerify(user.passwordHash, current))) {
      throw new DomainError('AUTH_INVALID', 401, 'Your current password is incorrect.');
    }
    await this.assertPasswordAllowed(next, user.email);
    const passwordHash = await argonHash(next);
    const queued = await this.db.withAuth(async (tx) => {
      await tx.query('UPDATE app_user SET password_hash = $2 WHERE id = $1', [user.id, passwordHash]);
      await repo.revokeSessions(tx, user.id, now, p.sessionHash);
      await writeAudit(tx, { actorId: user.id, partnerId: user.partnerId, action: 'auth.password_changed', entity: 'user', entityId: user.id, ip: meta.ip, userAgent: meta.userAgent });
      return this.queue(tx, 'auth.password_changed', [{ to: user.email, subject: 'Your Vittora password was changed', text: 'If this was not you, reset your password now.' }]);
    });
    await this.outbox.deliver(queued);
  }

  private totp() {
    return authenticator.clone({ epoch: this.clock.now().getTime(), window: 1 });
  }

  /** Returns the time step of a valid code, or null. */
  private matchTotp(secret: string, code: string): number | null {
    const delta = this.totp().checkDelta(code, secret);
    if (delta === null) return null;
    return Math.floor(this.clock.now().getTime() / 30_000) + delta;
  }

  async startMfaSetup(p: Principal): Promise<{ secret: string; otpauthUrl: string; qrDataUrl: string }> {
    const user = await this.db.withAuth((tx) => repo.findUserById(tx, p.userId));
    if (!user) throw invalidCredentials();
    if (user.mfaEnabled) throw new DomainError('MFA_ALREADY_ENABLED', 409, 'Two-step sign-in is already on.');
    const secret = authenticator.generateSecret();
    await this.db.withAuth((tx) =>
      tx.query('UPDATE app_user SET mfa_secret_enc = $2 WHERE id = $1', [user.id, encrypt(this.config.ENCRYPTION_KEY, secret)]),
    );
    const otpauthUrl = authenticator.keyuri(user.email, 'Vittora', secret);
    return { secret, otpauthUrl, qrDataUrl: await QRCode.toDataURL(otpauthUrl) };
  }

  async enableMfa(p: Principal, code: string, meta: RequestMeta): Promise<void> {
    const now = this.clock.now();
    await this.db.withAuth(async (tx) => {
      const user = await repo.findUserById(tx, p.userId);
      if (!user?.mfaSecretEnc || user.mfaEnabled) throw new DomainError('MFA_NOT_STARTED', 409, 'Start setup first.');
      const step = this.matchTotp(decrypt(this.config.ENCRYPTION_KEY, user.mfaSecretEnc), code);
      if (step === null) throw invalidCode();
      await tx.query('UPDATE app_user SET mfa_enabled = true, mfa_last_step = $2, last_login_at = $3 WHERE id = $1', [user.id, step, now]);
      await tx.query(`UPDATE session SET mfa_state = 'ok' WHERE id_hash = $1`, [p.sessionHash]);
      await writeAudit(tx, { actorId: user.id, partnerId: user.partnerId, action: 'auth.mfa_enabled', entity: 'user', entityId: user.id, ip: meta.ip, userAgent: meta.userAgent });
    });
  }

  private otpHash(userId: string, code: string) {
    return hmac(this.config.HMAC_KEY, `otp:${userId}:${code}`);
  }

  /** Email fallback when the authenticator app isn't available (§4.1). */
  async sendEmailOtp(p: Principal): Promise<void> {
    if (p.mfaState !== 'pending') throw new DomainError('MFA_NOT_PENDING', 409, 'No code is needed right now.');
    const now = this.clock.now();
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const queued = await this.db.withAuth(async (tx) => {
      const u = await repo.findUserById(tx, p.userId);
      if (!u) throw invalidCredentials();
      await repo.replaceToken(tx, {
        id: uuid(), userId: u.id, purpose: 'email_otp', tokenHash: this.otpHash(u.id, code),
        expiresAt: new Date(now.getTime() + rules.EMAIL_OTP_TTL_MS), now,
      });
      return this.queue(tx, 'auth.email_otp', [{ to: u.email, subject: 'Your Vittora sign-in code', text: `Your code is ${code}. It expires in 10 minutes.` }]);
    });
    await this.outbox.deliver(queued);
  }

  async verifyMfa(p: Principal, code: string, meta: RequestMeta): Promise<void> {
    if (p.mfaState !== 'pending') throw new DomainError('MFA_NOT_PENDING', 409, 'No code is needed right now.');
    const now = this.clock.now();

    const ok = await this.db.withAuth(async (tx) => {
      const user = await repo.findUserById(tx, p.userId);
      if (!user?.mfaSecretEnc) return false;
      if (await this.acceptCode(tx, user, code, now)) {
        await tx.query('UPDATE app_user SET last_login_at = $2 WHERE id = $1', [user.id, now]);
        await tx.query(`UPDATE session SET mfa_state = 'ok' WHERE id_hash = $1`, [p.sessionHash]);
        await writeAudit(tx, { actorId: user.id, partnerId: user.partnerId, action: 'auth.mfa_verified', entity: 'user', entityId: user.id, ip: meta.ip, userAgent: meta.userAgent });
        return true;
      }
      return false;
    });
    if (ok) return;

    await this.db.withAuth(async (tx) => {
      const { rows } = await tx.query(
        'UPDATE session SET mfa_failures = mfa_failures + 1 WHERE id_hash = $1 RETURNING mfa_failures',
        [p.sessionHash],
      );
      if (rows[0]?.mfa_failures >= rules.MAX_MFA_FAILURES) {
        await tx.query('UPDATE session SET revoked_at = $2 WHERE id_hash = $1', [p.sessionHash, now]);
        await writeAudit(tx, { actorId: p.userId, partnerId: p.partnerId, action: 'auth.mfa_failed_too_often', ip: meta.ip, userAgent: meta.userAgent });
      }
    });
    throw invalidCode();
  }

  private async acceptCode(tx: Tx, user: repo.UserRow, code: string, now: Date): Promise<boolean> {
    const step = this.matchTotp(decrypt(this.config.ENCRYPTION_KEY, user.mfaSecretEnc!), code);
    if (step !== null) {
      // A code can't be used twice, even inside its 30-second window.
      if (user.mfaLastStep !== null && step <= Number(user.mfaLastStep)) return false;
      await tx.query('UPDATE app_user SET mfa_last_step = $2 WHERE id = $1', [user.id, step]);
      return true;
    }
    const otp = await repo.findLiveToken(tx, this.otpHash(user.id, code), ['email_otp'], now);
    return !!otp && otp.userId === user.id && (await repo.consumeToken(tx, otp.id, now));
  }
}
