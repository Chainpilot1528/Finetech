import type { Role } from '@vittora/shared-kernel';
import type { Tx } from '../../../platform/db.js';
import type { Features } from '../domain/permissions.js';

export interface UserRow {
  id: string;
  partnerId: string | null;
  name: string;
  email: string;
  role: Role;
  status: 'invited' | 'active' | 'inactive';
  passwordHash: string | null;
  mfaEnabled: boolean;
  mfaSecretEnc: string | null;
  mfaLastStep: string | null;
  lockedUntil: Date | null;
}

export type MfaState = 'pending' | 'enroll' | 'ok';

export interface SessionRow {
  idHash: string;
  userId: string;
  partnerId: string | null;
  mfaState: MfaState;
  mfaFailures: number;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  role: Role;
  mfaEnabled: boolean;
  userStatus: string;
  features: Features | null;
  partnerStatus: string | null;
}

const USER_COLUMNS = `id, partner_id AS "partnerId", name, email, role, status,
  password_hash AS "passwordHash", mfa_enabled AS "mfaEnabled", mfa_secret_enc AS "mfaSecretEnc",
  mfa_last_step AS "mfaLastStep", locked_until AS "lockedUntil"`;

export async function findUserByEmail(tx: Tx, email: string): Promise<UserRow | null> {
  const { rows } = await tx.query(`SELECT ${USER_COLUMNS} FROM app_user WHERE lower(email) = lower($1)`, [email]);
  return rows[0] ?? null;
}

export async function findUserById(tx: Tx, id: string): Promise<UserRow | null> {
  const { rows } = await tx.query(`SELECT ${USER_COLUMNS} FROM app_user WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function findPartnerAdminEmails(tx: Tx, partnerId: string): Promise<string[]> {
  const { rows } = await tx.query(
    `SELECT email FROM app_user WHERE partner_id = $1 AND role = 'admin' AND status = 'active'`,
    [partnerId],
  );
  return rows.map((r) => r.email);
}

export async function recordAttempt(tx: Tx, emailHash: string, ip: string | null, success: boolean, at: Date) {
  await tx.query('INSERT INTO login_attempt (email_hash, ip, success, at) VALUES ($1,$2,$3,$4)', [
    emailHash, ip, success, at,
  ]);
}

export async function countRecentAttempts(tx: Tx, emailHash: string, ip: string | null, since: Date): Promise<number> {
  const { rows } = await tx.query(
    'SELECT count(*)::int AS n FROM login_attempt WHERE email_hash = $1 AND ip IS NOT DISTINCT FROM $2 AND at > $3',
    [emailHash, ip, since],
  );
  return rows[0].n;
}

/** Failures in the window that came after the last successful sign-in. */
export async function countRecentFailures(tx: Tx, emailHash: string, since: Date): Promise<number> {
  const { rows } = await tx.query(
    `SELECT count(*)::int AS n FROM login_attempt
     WHERE email_hash = $1 AND success = false AND at > $2
       AND at > coalesce((SELECT max(at) FROM login_attempt WHERE email_hash = $1 AND success = true), '-infinity')`,
    [emailHash, since],
  );
  return rows[0].n;
}

export async function insertSession(
  tx: Tx,
  s: { idHash: string; userId: string; partnerId: string | null; mfaState: MfaState; ip: string | null;
       userAgent: string | null; deviceHash: string; now: Date; expiresAt: Date },
) {
  await tx.query(
    `INSERT INTO session (id_hash, user_id, partner_id, mfa_state, ip, user_agent, device_hash, created_at, last_seen_at, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9)`,
    [s.idHash, s.userId, s.partnerId, s.mfaState, s.ip, s.userAgent, s.deviceHash, s.now, s.expiresAt],
  );
}

export async function findSession(tx: Tx, idHash: string): Promise<SessionRow | null> {
  const { rows } = await tx.query(
    `SELECT s.id_hash AS "idHash", s.user_id AS "userId", s.partner_id AS "partnerId", s.mfa_state AS "mfaState",
            s.mfa_failures AS "mfaFailures", s.last_seen_at AS "lastSeenAt", s.expires_at AS "expiresAt",
            s.revoked_at AS "revokedAt", u.role, u.mfa_enabled AS "mfaEnabled", u.status AS "userStatus", p.features, p.status AS "partnerStatus"
     FROM session s JOIN app_user u ON u.id = s.user_id LEFT JOIN partner p ON p.id = s.partner_id
     WHERE s.id_hash = $1`,
    [idHash],
  );
  return rows[0] ?? null;
}

export async function hasOtherDevice(tx: Tx, userId: string, deviceHash: string) {
  const { rows } = await tx.query(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE device_hash = $2)::int AS same FROM session WHERE user_id = $1`,
    [userId, deviceHash],
  );
  return { isFirstEver: rows[0].total === 0, isKnown: rows[0].same > 0 };
}

export async function revokeSessions(tx: Tx, userId: string, now: Date, exceptIdHash?: string) {
  await tx.query(
    `UPDATE session SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL AND id_hash IS DISTINCT FROM $3`,
    [userId, now, exceptIdHash ?? null],
  );
}

export type TokenPurpose = 'password_setup' | 'password_reset' | 'email_otp';

/** Issuing a new token cancels earlier unused ones of the same family (§4.1). */
export async function replaceToken(
  tx: Tx,
  t: { id: string; userId: string; purpose: TokenPurpose; tokenHash: string; expiresAt: Date; now: Date },
) {
  const family = t.purpose === 'email_otp' ? ['email_otp'] : ['password_setup', 'password_reset'];
  await tx.query(`UPDATE auth_token SET used_at = $3 WHERE user_id = $1 AND purpose = ANY($2) AND used_at IS NULL`, [
    t.userId, family, t.now,
  ]);
  await tx.query(
    `INSERT INTO auth_token (id, user_id, purpose, token_hash, expires_at, created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
    [t.id, t.userId, t.purpose, t.tokenHash, t.expiresAt, t.now],
  );
}

export async function findLiveToken(tx: Tx, tokenHash: string, purposes: TokenPurpose[], now: Date) {
  const { rows } = await tx.query(
    `SELECT id, user_id AS "userId", purpose FROM auth_token
     WHERE token_hash = $1 AND purpose = ANY($2) AND used_at IS NULL AND expires_at > $3`,
    [tokenHash, purposes, now],
  );
  return (rows[0] ?? null) as { id: string; userId: string; purpose: TokenPurpose } | null;
}

/** Returns false if someone else used the token first. */
export async function consumeToken(tx: Tx, id: string, now: Date): Promise<boolean> {
  const res = await tx.query('UPDATE auth_token SET used_at = $2 WHERE id = $1 AND used_at IS NULL', [id, now]);
  return res.rowCount === 1;
}
