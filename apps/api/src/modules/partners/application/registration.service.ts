import { Inject, Injectable } from '@nestjs/common';
import { type Clock, DomainError } from '@vittora/shared-kernel';
import { v7 as uuid } from 'uuid';
import type { Config } from '../../../platform/config.js';
import { hmac } from '../../../platform/crypto.js';
import type { Db, Tx } from '../../../platform/db.js';
import { CLOCK, CONFIG, DB } from '../../../platform/tokens.js';
import { writeAudit } from '../../audit/index.js';
import { Outbox } from '../../../platform/outbox.js';
import { AuthService, type RequestMeta } from '../../identity/index.js';

export interface Registration {
  channelName: string;
  legalName: string;
  city: string;
  pincode: string;
  businessEmail: string;
  businessPhone?: string;
  products: string[];
  employeeBand: string;
  adminName: string;
  adminEmail: string;
  adminPhone?: string;
}

const PER_MINUTE = 5;

@Injectable()
export class RegistrationService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(Outbox) private readonly outbox: Outbox,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  private async nextRefCode(tx: Tx, city: string, pincode: string) {
    const { rows } = await tx.query(`SELECT nextval('partner_ref_seq') AS seq`);
    const letters = city.toUpperCase().replace(/[^A-Z]/g, '').padEnd(3, 'X').slice(0, 3);
    return `${letters}-${pincode.slice(0, 3)}-${rows[0].seq}`;
  }

  /** The answer is the same whether or not the email is taken, so it can't be used to find accounts. */
  async register(input: Registration, meta: RequestMeta): Promise<void> {
    const now = this.clock.now();
    const ipKey = hmac(this.config.HMAC_KEY, `register:${meta.ip}`);

    const queued = await this.db.withAuth(async (tx) => {
      const { rows } = await tx.query(
        'SELECT count(*)::int AS n FROM login_attempt WHERE email_hash = $1 AND at > $2',
        [ipKey, new Date(now.getTime() - 60_000)],
      );
      if (rows[0].n >= PER_MINUTE) {
        throw new DomainError('AUTH_RATE_LIMITED', 429, 'Too many attempts. Please wait a minute and try again.');
      }
      await tx.query('INSERT INTO login_attempt (email_hash, ip, success, at) VALUES ($1,$2,false,$3)', [ipKey, meta.ip, now]);

      const taken = await tx.query('SELECT 1 FROM app_user WHERE lower(email) = lower($1)', [input.adminEmail]);
      if (taken.rowCount) {
        return this.outbox.mail(tx, 'partner.register_taken', {
          to: input.adminEmail,
          subject: 'You already have a Vittora account',
          text: 'Someone tried to register with this email. If that was you, sign in or reset your password.',
        });
      }

      const partnerId = uuid();
      const adminId = uuid();
      const refCode = await this.nextRefCode(tx, input.city, input.pincode);
      await tx.query(
        `INSERT INTO partner (id, ref_code, legal_name, channel_name, city, pincode, employee_band, business_email, business_phone)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [partnerId, refCode, input.legalName, input.channelName, input.city, input.pincode, input.employeeBand,
         input.businessEmail, input.businessPhone ?? null],
      );
      for (const product of input.products) {
        await tx.query('INSERT INTO partner_product (partner_id, product_code, enabled_at) VALUES ($1,$2,$3)', [partnerId, product, now]);
      }
      await tx.query(
        `INSERT INTO app_user (id, partner_id, name, email, phone, role, status) VALUES ($1,$2,$3,$4,$5,'admin','invited')`,
        [adminId, partnerId, input.adminName, input.adminEmail, input.adminPhone ?? null],
      );
      const link = await this.auth.issueSetupLink(tx, adminId);
      await writeAudit(tx, {
        actorId: adminId, partnerId, action: 'partner.registered', entity: 'partner', entityId: partnerId,
        ip: meta.ip, userAgent: meta.userAgent,
      });
      return this.outbox.mail(tx, 'partner.welcome', {
        to: input.adminEmail,
        subject: 'Welcome to Vittora: set up your password',
        text: `Your Reference ID is ${refCode}. Keep it for support calls.\n\nSet your password within 30 minutes. If this link expires, use Forgot password.\n\n${link}`,
      });
    });
    await this.outbox.deliver([queued]);
  }
}
