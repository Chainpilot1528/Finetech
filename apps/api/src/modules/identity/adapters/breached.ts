import { createHash } from 'node:crypto';
import type { BreachedPasswordChecker } from '../ports/index.js';

/**
 * k-anonymity check: only the first 5 characters of the password's SHA-1 leave the server.
 * If the service is slow or down, sign-up continues rather than blocking users (§14.12).
 */
export class PwnedPasswordsChecker implements BreachedPasswordChecker {
  async isBreached(password: string): Promise<boolean> {
    const hash = createHash('sha1').update(password).digest('hex').toUpperCase();
    try {
      const res = await fetch(`https://api.pwnedpasswords.com/range/${hash.slice(0, 5)}`, {
        signal: AbortSignal.timeout(2000),
        headers: { 'Add-Padding': 'true' },
      });
      if (!res.ok) return false;
      const suffix = hash.slice(5);
      return (await res.text()).split('\n').some((line) => {
        const [candidate, count] = line.trim().split(':');
        return candidate === suffix && Number(count) > 0;
      });
    } catch {
      return false;
    }
  }
}

export class NoBreachCheck implements BreachedPasswordChecker {
  async isBreached(): Promise<boolean> {
    return false;
  }
}
