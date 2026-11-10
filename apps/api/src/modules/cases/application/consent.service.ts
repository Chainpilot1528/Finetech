import { randomInt } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { CONSENT_TEXT, CONSENT_TEXT_VERSION, type DraftData } from '@vittora/product-schemas';
import { type Clock, DomainError } from '@vittora/shared-kernel';
import { v7 as uuid } from 'uuid';
import type { Config } from '../../../platform/config.js';
import { decrypt, encrypt, hmac, randomToken, safeEqual, sha256 } from '../../../platform/crypto.js';
import type { Db, TenantContext, Tx } from '../../../platform/db.js';
import { Outbox, type Pending } from '../../../platform/outbox.js';
import { CLOCK, CONFIG, DB } from '../../../platform/tokens.js';
import { writeAudit } from '../../audit/index.js';
import type { RequestMeta } from '../../identity/index.js';

const CONSENT_TTL_MS = 48 * 3_600_000;
const CODE_TTL_MS = 10 * 60_000;
const MAX_CODE_ATTEMPTS = 5;
const MAX_CODE_SENDS = 5;

export type ConsentState = 'none' | 'sent' | 'given';

/**
 * Customer consent (ARCH-04). Consent comes from the customer, never from the partner's screen:
 * the link and the one-time code go only to the customer's phone (SEC-01), and the consent covers
 * only the phone, email and PAN it was given for.
 */
@Injectable()
export class ConsentService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(Outbox) private readonly outbox: Outbox,
  ) {}

  private blind(kind: string, value: string) {
    return hmac(this.config.HMAC_KEY, `${kind}:${value}`);
  }

  /** Who the consent is for. Any change to these voids it. */
  private fingerprint(data: DraftData) {
    return {
      phone: this.blind('phone', data.applicant?.phone ?? ''),
      email: this.blind('email', (data.applicant?.email ?? '').trim().toLowerCase()),
      pan: this.blind('pan', data.applicant?.pan ?? ''),
    };
  }

  async stateFor(tx: Tx, draftId: string, data: DraftData): Promise<ConsentState> {
    const { rows } = await tx.query(
      `SELECT recipient_hash, email_hash, pan_hash, expires_at, consented_at FROM customer_consent
       WHERE draft_id = $1 AND purpose = 'processing' AND superseded_at IS NULL ORDER BY created_at DESC LIMIT 1`,
      [draftId],
    );
    const c = rows[0];
    if (!c) return 'none';
    const now = this.fingerprint(data);
    if (c.recipient_hash !== now.phone || c.email_hash !== now.email || c.pan_hash !== now.pan) return 'none';
    if (c.consented_at) return 'given';
    return c.expires_at > this.clock.now() ? 'sent' : 'none';
  }

  /** Called inside the draft's transaction once the details are checked. Returns outbox ids to deliver. */
  async request(tx: Tx, ctx: TenantContext, draftId: string, data: DraftData, lenderName: string, actorId: string, meta: RequestMeta): Promise<Pending> {
    const now = this.clock.now();
    const token = randomToken();
    const phone = data.applicant!.phone!;
    const who = this.fingerprint(data);
    await tx.query(
      `UPDATE customer_consent SET superseded_at = $2 WHERE draft_id = $1 AND superseded_at IS NULL AND consented_at IS NULL`,
      [draftId, now],
    );
    await tx.query(
      `INSERT INTO customer_consent (id, partner_id, draft_id, purpose, text_version, channel, lender_name,
         recipient_hash, email_hash, pan_hash, recipient_enc, token_hash, expires_at, created_at)
       VALUES ($1,$2,$3,'processing',$4,'link',$5,$6,$7,$8,$9,$10,$11,$12)`,
      [uuid(), ctx.partnerId, draftId, CONSENT_TEXT_VERSION, lenderName, who.phone, who.email, who.pan,
       encrypt(this.config.ENCRYPTION_KEY, phone), sha256(token), new Date(now.getTime() + CONSENT_TTL_MS), now],
    );
    await writeAudit(tx, { actorId, partnerId: ctx.partnerId, action: 'consent.requested', entity: 'case_draft', entityId: draftId, ip: meta.ip, userAgent: meta.userAgent });
    return [await this.outbox.mail(tx, 'consent.link', {
      to: `sms:+91${phone}`,
      subject: 'Please confirm your loan application',
      text: `Your loan partner needs your consent to process your application. Open this link within 48 hours:\n\n${this.config.WEB_ORIGIN}/consent/${token}`,
    })];
  }

  /** Public. Shows no customer details, so a forwarded link reveals nothing about them. */
  page(token: string) {
    return this.db.withAuth(async (tx) => {
      const c = await this.find(tx, token);
      const partner = await tx.query('SELECT channel_name FROM partner WHERE id = $1', [c.partner_id]);
      return {
        partnerName: partner.rows[0].channel_name as string,
        lenderName: c.lender_name as string,
        text: CONSENT_TEXT,
        textVersion: c.text_version as string,
        given: !!c.consented_at,
      };
    });
  }

  /** Sends a one-time code to the same phone the link went to. */
  async sendCode(token: string, meta: RequestMeta) {
    const now = this.clock.now();
    const queued = await this.db.withAuth(async (tx) => {
      const c = await this.find(tx, token, true);
      if (c.consented_at) return [];
      if (c.otp_sends >= MAX_CODE_SENDS) {
        throw new DomainError('CODE_LIMIT', 429, 'Too many codes were sent. Ask your loan partner for a new link.');
      }
      if (!c.recipient_enc) throw new DomainError('TOKEN_INVALID', 400, 'This link has expired. Ask your loan partner for a new one.');
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      await tx.query(
        `UPDATE customer_consent SET otp_hash = $2, otp_expires_at = $3, otp_attempts = 0, otp_sends = otp_sends + 1 WHERE id = $1`,
        [c.id, this.codeHash(c.id, code), new Date(now.getTime() + CODE_TTL_MS)],
      );
      await writeAudit(tx, { partnerId: c.partner_id, action: 'consent.code_sent', entity: 'case_draft', entityId: c.draft_id, ip: meta.ip, userAgent: meta.userAgent });
      const phone = decrypt(this.config.ENCRYPTION_KEY, c.recipient_enc);
      return [await this.outbox.mail(tx, 'consent.code', {
        to: `sms:+91${phone}`,
        subject: 'Your consent code',
        text: `Your code to confirm your loan application is ${code}. It expires in 10 minutes. Don't share it with anyone.`,
      })];
    });
    await this.outbox.deliver(queued);
  }

  async give(token: string, code: string | undefined, meta: RequestMeta) {
    const outcome = await this.db.withAuth(async (tx) => {
      const c = await this.find(tx, token, true);
      if (c.consented_at) return 'ok';
      if (!code) throw new DomainError('CODE_REQUIRED', 422, 'Enter the code we sent to your phone.', { code: 'Enter the 6-digit code.' });
      if (!c.otp_hash) throw new DomainError('CODE_INVALID', 400, 'Ask for a code first.');
      if (c.otp_attempts >= MAX_CODE_ATTEMPTS) {
        throw new DomainError('CODE_LOCKED', 400, 'Too many wrong codes. Ask for a new code.');
      }
      const valid = c.otp_expires_at > this.clock.now() && safeEqual(c.otp_hash, this.codeHash(c.id, code));
      if (!valid) {
        await tx.query('UPDATE customer_consent SET otp_attempts = otp_attempts + 1 WHERE id = $1', [c.id]);
        return 'wrong';
      }
      await tx.query(
        `UPDATE customer_consent SET consented_at = $2, customer_ip = $3, user_agent = $4, channel = 'otp', otp_hash = NULL WHERE id = $1`,
        [c.id, this.clock.now(), meta.ip, meta.userAgent],
      );
      await writeAudit(tx, { partnerId: c.partner_id, action: 'consent.given', entity: 'case_draft', entityId: c.draft_id, ip: meta.ip, userAgent: meta.userAgent });
      return 'ok';
    });
    // The wrong attempt is counted in its own committed transaction before the error goes back.
    if (outcome === 'wrong') throw new DomainError('CODE_INVALID', 400, 'That code is not right, or it has expired.', { code: 'Check the code and try again.' });
  }

  /** Links the given consent to the new case. */
  async attachToCase(tx: Tx, draftId: string, caseId: string) {
    await tx.query('UPDATE customer_consent SET case_id = $2 WHERE draft_id = $1 AND consented_at IS NOT NULL', [draftId, caseId]);
  }

  private codeHash(consentId: string, code: string) {
    return hmac(this.config.HMAC_KEY, `consent-otp:${consentId}:${code}`);
  }

  private async find(tx: Tx, token: string, lock = false) {
    const { rows } = await tx.query(
      `SELECT * FROM customer_consent WHERE token_hash = $1 AND superseded_at IS NULL ${lock ? 'FOR UPDATE' : ''}`,
      [sha256(token)],
    );
    const c = rows[0];
    if (!c || (!c.consented_at && c.expires_at <= this.clock.now())) {
      throw new DomainError('TOKEN_INVALID', 400, 'This link has expired. Ask your loan partner for a new one.');
    }
    return c;
  }
}
