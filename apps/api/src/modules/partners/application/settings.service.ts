import { productName } from '@vittora/product-schemas';
import { Inject, Injectable } from '@nestjs/common';
import { type Clock, DomainError } from '@vittora/shared-kernel';
import type { Config } from '../../../platform/config.js';
import { decrypt, encrypt } from '../../../platform/crypto.js';
import type { Db, TenantContext } from '../../../platform/db.js';
import { CLOCK, CONFIG, DB } from '../../../platform/tokens.js';
import { writeAudit } from '../../audit/index.js';
import type { Principal, RequestMeta } from '../../identity/index.js';

export interface CompanyInput {
  city?: string;
  pincode?: string;
  employeeBand?: string;
  businessEmail?: string;
  businessPhone?: string | null;
  maskCustomerContact?: boolean;
}

export interface BillingInput {
  gstRegistered: boolean;
  gstin?: string;
  pan: string;
  sacCode?: string;
  bankAccount: string;
  ifsc: string;
  bankName: string;
  branch: string;
}

@Injectable()
export class SettingsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  /** Full PAN and bank numbers never come back here, only the last 4 digits. */
  get(p: Principal, ctx: TenantContext) {
    return this.db.withTenant(ctx, async (tx) => {
      const partner = (await tx.query(
        `SELECT ref_code AS "refCode", channel_name AS "channelName", legal_name AS "legalName", city, pincode, employee_band AS "employeeBand",
                business_email AS "businessEmail", business_phone AS "businessPhone", status, kyc_status AS "kycStatus",
                mask_customer_contact AS "maskCustomerContact", created_at AS "registeredAt" FROM partner`,
      )).rows[0];
      const products = await tx.query(`SELECT pp.product_code AS code FROM partner_product pp ORDER BY pp.product_code`);
      const admins = await tx.query(`SELECT name, email, phone FROM app_user WHERE role = 'admin' AND status = 'active' ORDER BY created_at LIMIT 5`);
      const me = await tx.query(`SELECT last_login_at AS "lastLoginAt" FROM app_user WHERE id = $1`, [p.userId]);
      const billing = await tx.query(
        `SELECT gst_registered AS "gstRegistered", gstin, sac_code AS "sacCode", pan_last4 AS "panLast4", bank_acct_last4 AS "bankLast4",
                ifsc, bank_name AS "bankName", branch, verification_status AS "verificationStatus", reviewer_note AS "reviewerNote"
         FROM partner_billing`,
      );
      return { ...partner, products: products.rows.map((r) => ({ code: r.code as string, name: productName(r.code) })).sort((a, b) => a.name.localeCompare(b.name)), admins: admins.rows, lastLoginAt: me.rows[0]?.lastLoginAt ?? null, billing: billing.rows[0] ?? null };
    });
  }

  async update(p: Principal, ctx: TenantContext, input: CompanyInput, meta: RequestMeta) {
    await this.db.withTenant(ctx, async (tx) => {
      await tx.query(
        `UPDATE partner SET city = COALESCE($1, city), pincode = COALESCE($2, pincode), employee_band = COALESCE($3, employee_band),
           business_email = COALESCE($4, business_email), business_phone = CASE WHEN $5 THEN $6 ELSE business_phone END,
           mask_customer_contact = COALESCE($7, mask_customer_contact)`,
        [input.city ?? null, input.pincode ?? null, input.employeeBand ?? null, input.businessEmail ?? null,
         input.businessPhone !== undefined, input.businessPhone ?? null, input.maskCustomerContact ?? null],
      );
      await writeAudit(tx, { actorId: p.userId, partnerId: ctx.partnerId, action: 'partner.updated', entity: 'partner', entityId: ctx.partnerId, after: { maskCustomerContact: input.maskCustomerContact ?? null }, ip: meta.ip, userAgent: meta.userAgent });
    });
    return this.get(p, ctx);
  }

  /** A trigger puts every partner edit back to pending, so saved details always get re-checked (§4.10). */
  async saveBilling(p: Principal, ctx: TenantContext, input: BillingInput, meta: RequestMeta) {
    if (input.gstRegistered && !input.gstin) throw new DomainError('VALIDATION_FAILED', 422, 'Enter your GSTIN.', { gstin: 'Enter your GSTIN.' });
    const key = this.config.ENCRYPTION_KEY;
    await this.db.withTenant(ctx, async (tx) => {
      await tx.query(
        `INSERT INTO partner_billing (partner_id, gst_registered, gstin, pan_enc, pan_last4, sac_code, bank_acct_enc, bank_acct_last4, ifsc, bank_name, branch, updated_at)
         VALUES ($1,$2,$3,$4,$5,COALESCE($6,'998399'),$7,$8,$9,$10,$11,$12)
         ON CONFLICT (partner_id) DO UPDATE SET gst_registered = EXCLUDED.gst_registered, gstin = EXCLUDED.gstin, pan_enc = EXCLUDED.pan_enc,
           pan_last4 = EXCLUDED.pan_last4, sac_code = EXCLUDED.sac_code, bank_acct_enc = EXCLUDED.bank_acct_enc, bank_acct_last4 = EXCLUDED.bank_acct_last4,
           ifsc = EXCLUDED.ifsc, bank_name = EXCLUDED.bank_name, branch = EXCLUDED.branch, updated_at = EXCLUDED.updated_at`,
        [ctx.partnerId, input.gstRegistered, input.gstRegistered ? input.gstin : null, encrypt(key, input.pan), input.pan.slice(-4), input.sacCode ?? null,
         encrypt(key, input.bankAccount), input.bankAccount.slice(-4), input.ifsc, input.bankName, input.branch, this.clock.now()],
      );
      await writeAudit(tx, { actorId: p.userId, partnerId: ctx.partnerId, action: 'billing.saved', entity: 'partner', entityId: ctx.partnerId, ip: meta.ip, userAgent: meta.userAgent });
    });
    return this.get(p, ctx);
  }

  /** Staff need the real numbers to check them against the bank proof, so each view is audited. */
  opsBilling(p: Principal, partnerId: string, meta: RequestMeta) {
    return this.db.withOps(async (tx) => {
      const { rows } = await tx.query('SELECT * FROM partner_billing WHERE partner_id = $1', [partnerId]);
      const b = rows[0];
      if (!b) throw new DomainError('NOT_FOUND', 404, 'No billing details yet.');
      await writeAudit(tx, { actorId: p.userId, partnerId, action: 'billing.viewed', entity: 'partner', entityId: partnerId, ip: meta.ip, userAgent: meta.userAgent });
      const key = this.config.ENCRYPTION_KEY;
      return {
        gstRegistered: b.gst_registered, gstin: b.gstin, sacCode: b.sac_code, pan: decrypt(key, b.pan_enc), bankAccount: decrypt(key, b.bank_acct_enc),
        ifsc: b.ifsc, bankName: b.bank_name, branch: b.branch, verificationStatus: b.verification_status, reviewerNote: b.reviewer_note,
      };
    });
  }

  async decideBilling(p: Principal, partnerId: string, decision: 'verified' | 'rejected', note: string | undefined, meta: RequestMeta) {
    if (decision === 'rejected' && !note?.trim()) throw new DomainError('NOTE_REQUIRED', 422, 'Say what needs fixing.');
    await this.db.withOps(async (tx) => {
      const done = await tx.query(
        `UPDATE partner_billing SET verification_status = $2, reviewer_note = $3, verified_at = CASE WHEN $2 = 'verified' THEN $4::timestamptz END,
           verified_by = CASE WHEN $2 = 'verified' THEN $5::uuid END WHERE partner_id = $1 AND verification_status = 'pending'`,
        [partnerId, decision, note?.trim() || null, this.clock.now(), p.userId],
      );
      if (!done.rowCount) throw new DomainError('NOT_FOUND', 404, 'Nothing is waiting for review.');
      await writeAudit(tx, { actorId: p.userId, partnerId, action: 'billing.decided', entity: 'partner', entityId: partnerId, after: { decision }, ip: meta.ip, userAgent: meta.userAgent });
    });
  }
}
