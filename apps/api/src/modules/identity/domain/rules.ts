/** Sign-in rules from PRD §4.1 and §9.2, kept together and free of I/O. */
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

export const LINK_TTL_MS = 30 * MINUTE;
export const EMAIL_OTP_TTL_MS = 10 * MINUTE;
export const SESSION_IDLE_MS = 30 * MINUTE;
export const SESSION_ABSOLUTE_MS = 12 * HOUR;
export const FAILURE_WINDOW_MS = 15 * MINUTE;
export const DELAY_AFTER_FAILURES = 5;
export const LOCK_AFTER_FAILURES = 10;
export const LOCK_MS = 30 * MINUTE;
export const AUTH_RATE_LIMIT_PER_MINUTE = 5;
export const MAX_MFA_FAILURES = 5;
export const MIN_PASSWORD_LENGTH = 10;

/** Extra wait once a sign-in is being guessed: 1s after the 5th failure, growing to 5s. */
export function progressiveDelayMs(recentFailures: number): number {
  if (recentFailures < DELAY_AFTER_FAILURES) return 0;
  return Math.min(recentFailures - DELAY_AFTER_FAILURES + 1, 5) * 1000;
}

export const shouldLock = (recentFailures: number) => recentFailures >= LOCK_AFTER_FAILURES;

export interface SessionTimes {
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

export function isSessionLive(s: SessionTimes, now: Date): boolean {
  if (s.revokedAt) return false;
  if (now >= s.expiresAt) return false;
  return now.getTime() - s.lastSeenAt.getTime() < SESSION_IDLE_MS;
}

/** Returns a problem code, or null when the password is acceptable. No forced rotation (§9.2). */
export function passwordProblem(password: string, email: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return 'PASSWORD_TOO_SHORT';
  if (password.length > 128) return 'PASSWORD_TOO_LONG';
  if (password.toLowerCase().includes(email.split('@')[0]!.toLowerCase())) return 'PASSWORD_CONTAINS_EMAIL';
  return null;
}
