import nodemailer from 'nodemailer';
import type { Mailer, MailMessage } from '../ports/index.js';

export class SmtpMailer implements Mailer {
  private readonly transport;
  constructor(url: string, private readonly from: string) {
    // The outbox puts a time limit on every send, so a stuck mail server can't hold a request (BUG-03).
    this.transport = nodemailer.createTransport(url);
  }
  async send(message: MailMessage): Promise<void> {
    await this.transport.sendMail({ ...message, from: this.from });
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
