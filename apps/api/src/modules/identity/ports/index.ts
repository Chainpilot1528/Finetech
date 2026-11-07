export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export interface BreachedPasswordChecker {
  isBreached(password: string): Promise<boolean>;
}

/** Waits during progressive delay. A port so tests don't really sleep. */
export interface Delay {
  wait(ms: number): Promise<void>;
}

export const MAILER = Symbol('MAILER');
export const BREACHED_PASSWORDS = Symbol('BREACHED_PASSWORDS');
export const DELAY = Symbol('DELAY');
export { CLOCK, CONFIG, DB } from '../../../platform/tokens.js';
