/** Current time. Injected so tests can freeze it (§14.4). */
export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };

export { DomainError } from './errors.js';
export { Money, type Paise } from './money.js';

/**
 * Wraps PII or secrets so they can't reach logs or JSON by accident (§14.8).
 * Reading the value needs an explicit call to unwrap().
 */
export class Sensitive<T> {
  readonly #value: T;
  constructor(value: T) {
    this.#value = value;
  }
  unwrap(): T {
    return this.#value;
  }
  toString(): string {
    return '[REDACTED]';
  }
  toJSON(): string {
    return '[REDACTED]';
  }
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return '[REDACTED]';
  }
}

export const PARTNER_ROLES = ['admin', 'manager', 'executive', 'viewer'] as const;
export type PartnerRole = (typeof PARTNER_ROLES)[number];
export const INTERNAL_ROLES = ['ops_agent', 'ops_lead', 'kyc_reviewer', 'finance', 'super_admin'] as const;
export type InternalRole = (typeof INTERNAL_ROLES)[number];
export type Role = PartnerRole | InternalRole;
