import nodemailer from 'nodemailer';
import type { Mailer, MailMessage } from '../ports/index.js';

/**
 * Texts are addressed `sms:+91…`. There is no SMS provider yet (D-011), so a mail server may carry them
 * only when it is a test inbox (demo mode); anywhere else sending one is an error, never a silent drop.
 */
export function mailRecipient(to: string, textsToInbox: boolean): string {
  if (!to.startsWith('sms:')) return to;
  if (!textsToInbox) throw new Error('No SMS provider is configured, so this text cannot be sent.');
  return `text-${to.slice(4).replace(/\D/g, '')}@sms.invalid`;
}

export class SmtpMailer implements Mailer {
  private readonly transport;
  constructor(url: string, private readonly from: string, private readonly textsToInbox = false) {
    // The outbox puts a time limit on every send, so a stuck mail server can't hold a request (BUG-03).
    this.transport = nodemailer.createTransport(url);
  }
  async send(message: MailMessage): Promise<void> {
    const to = mailRecipient(message.to, this.textsToInbox);
    const subject = to === message.to ? message.subject : `[Text] ${message.subject}`;
    await this.transport.sendMail({ ...message, to, subject, from: this.from });
  }
}

/** Development inbox held in memory and shown at /dev/inbox. Refused in production by config. */
export class DevMailbox implements Mailer {
  readonly messages: (MailMessage & { at: string })[] = [];
  async send(message: MailMessage): Promise<void> {
    this.messages.unshift({ ...message, at: new Date().toISOString() });
    this.messages.length = Math.min(this.messages.length, 100);
  }
}
