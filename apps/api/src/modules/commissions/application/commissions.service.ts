import { Inject, Injectable } from '@nestjs/common';
import { type Clock, DomainError } from '@vittora/shared-kernel';
import { v7 as uuid } from 'uuid';
import type { Config } from '../../../platform/config.js';
import { decrypt } from '../../../platform/crypto.js';
import type { Db, TenantContext, Tx } from '../../../platform/db.js';
import { CLOCK, CONFIG, DB } from '../../../platform/tokens.js';
import { writeAudit } from '../../audit/index.js';
import { maskName } from '../../cases/domain/masking.js';
import type { Principal, RequestMeta } from '../../identity/index.js';
import { breakdown, financialYear, invoiceNumber } from '../domain/money.js';

const INVOICE_COLUMNS = `i.id, i.invoice_no AS "invoiceNo", i.status, i.case_id AS "caseId", c.case_no AS "caseNo",
  i.disbursal_paise::float8 AS "disbursalPaise", i.gross_paise::float8 AS "grossPaise", i.gst_paise::float8 AS "gstPaise",
  i.tds_paise::float8 AS "tdsPaise", i.net_paise::float8 AS "netPaise", i.recovered_paise::float8 AS "recoveredPaise",
  i.version, i.created_at AS "createdAt", i.raised_at AS "raisedAt", i.paid_at AS "paidAt", i.payout_ref AS "payoutRef"`;

const GROUPS: Record<string, string[]> = {
  to_raise: ['DRAFT', 'PENDING_RATE_CARD'],
  in_review: ['RAISED', 'DISPUTED'],
  pending_payout: ['APPROVED'],
  paid: ['PAID'],
};

export interface CaseForInvoice {
  id: string;
  partner_id: string;
  product: string;
  loan_type: string;
  lender_id: string | null;
  preferred_lender_id: string;
  sanctioned_amount_paise: string;
}

@Injectable()
export class CommissionsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  private async taxBps(tx: Tx, code: 'gst' | 'tds', on: string): Promise<number> {
    const { rows } = await tx.query('SELECT bps FROM tax_rate WHERE code = $1 AND valid_from <= $2 ORDER BY valid_from DESC LIMIT 1', [code, on]);
    if (!rows[0]) throw new DomainError('TAX_RATE_MISSING', 500, 'No tax rate is set for this date.');
    return rows[0].bps;
  }

  /** The slab is chosen on the sanctioned amount, so every tranche of one loan uses the same rate (§4.7). */
  private async findRate(tx: Tx, c: CaseForInvoice, on: string) {
    const { rows } = await tx.query(
      `SELECT id, pct_bps, clawback_months FROM rate_card
       WHERE status = 'active' AND lender_id = $1 AND product = $2 AND (loan_type IS NULL OR loan_type = $3)
         AND slab_min_paise <= $4 AND (slab_max_paise IS NULL OR slab_max_paise >= $4)
         AND valid_from <= $5 AND (valid_to IS NULL OR valid_to >= $5)
       ORDER BY (loan_type IS NOT NULL) DESC, valid_from DESC, decided_at DESC LIMIT 1`,
      [c.lender_id ?? c.preferred_lender_id, c.product, c.loan_type, c.sanctioned_amount_paise, on],
    );
    return rows[0] as { id: string; pct_bps: number; clawback_months: number } | undefined;
  }

  private async priced(tx: Tx, c: CaseForInvoice, amount: bigint, on: string) {
    const rate = await this.findRate(tx, c, on);
    if (!rate) return null;
    const gstBps = await this.taxBps(tx, 'gst', on);
    const tdsBps = await this.taxBps(tx, 'tds', on);
    const billing = await tx.query('SELECT gst_registered FROM partner_billing WHERE partner_id = $1', [c.partner_id]);
    const money = breakdown(amount, rate.pct_bps, billing.rows[0]?.gst_registered ? gstBps : 0, tdsBps);
    return { money, snapshot: { rateCardId: rate.id, pctBps: rate.pct_bps, clawbackMonths: rate.clawback_months, gstBps, tdsBps } };
  }

  private async event(tx: Tx, partnerId: string, invoiceId: string, from: string | null, to: string, actorId: string | null, note?: string) {
    await tx.query(
      `INSERT INTO invoice_event (id, partner_id, invoice_id, from_status, to_status, actor_id, note, at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [uuid(), partnerId, invoiceId, from, to, actorId, note ?? null, this.clock.now()],
    );
  }

  /** Runs in the disbursal's transaction: one invoice per disbursal, priced now if a rate exists. */
  async createForDisbursal(tx: Tx, d: { id: string; amountPaise: bigint; disbursedOn: string }, c: CaseForInvoice, actorId: string) {
    const now = this.clock.now();
    const price = await this.priced(tx, c, d.amountPaise, d.disbursedOn);
    const status = price ? 'DRAFT' : 'PENDING_RATE_CARD';
    const id = uuid();
    await tx.query(
      `INSERT INTO invoice (id, partner_id, case_id, disbursal_id, status, disbursal_paise, gross_paise, gst_paise, tds_paise, net_paise,
         rate_card_snapshot, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)`,
      [id, c.partner_id, c.id, d.id, status, d.amountPaise, price?.money.gross ?? 0n, price?.money.gst ?? 0n, price?.money.tds ?? 0n,
       price?.money.net ?? 0n, price ? JSON.stringify(price.snapshot) : null, now],
    );
    await this.event(tx, c.partner_id, id, null, status, actorId);
    return { id, status };
  }

  /** A newly approved rate card prices whatever was waiting for it. */
  async priceWaiting(tx: Tx, actorId: string) {
    const { rows } = await tx.query(
      `SELECT i.id, i.disbursal_paise, d.disbursed_on::text AS on_date, c.id AS case_id, c.partner_id, c.product, c.loan_type, c.lender_id,
              c.preferred_lender_id, c.sanctioned_amount_paise
       FROM invoice i JOIN disbursal d ON d.id = i.disbursal_id JOIN loan_case c ON c.id = i.case_id
       WHERE i.status = 'PENDING_RATE_CARD' FOR UPDATE OF i`,
    );
    let priced = 0;
    for (const r of rows) {
      const price = await this.priced(tx, { ...r, id: r.case_id }, BigInt(r.disbursal_paise), r.on_date);
      if (!price) continue;
      await tx.query(
        `UPDATE invoice SET status = 'DRAFT', gross_paise = $2, gst_paise = $3, tds_paise = $4, net_paise = $5, rate_card_snapshot = $6,
           updated_at = $7, version = version + 1 WHERE id = $1`,
        [r.id, price.money.gross, price.money.gst, price.money.tds, price.money.net, JSON.stringify(price.snapshot), this.clock.now()],
      );
      await this.event(tx, r.partner_id, r.id, 'PENDING_RATE_CARD', 'DRAFT', actorId);
      priced += 1;
    }
    return priced;
  }

  /** Unpaid invoices are voided. Paid commission becomes a clawback that still needs approving (§4.7). */
  async onCaseReversed(tx: Tx, c: { id: string; partner_id: string }, actorId: string, reason: string) {
    const now = this.clock.now();
    const { rows } = await tx.query(`SELECT id, status, net_paise FROM invoice WHERE case_id = $1 AND status <> 'VOID' FOR UPDATE`, [c.id]);
    for (const inv of rows) {
      if (inv.status === 'PAID') {
        await tx.query(
          `INSERT INTO clawback (id, partner_id, invoice_id, amount_paise, reason, raised_by, at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [uuid(), c.partner_id, inv.id, inv.net_paise, reason, actorId, now],
        );
        await this.event(tx, c.partner_id, inv.id, 'PAID', 'PAID', actorId, 'Clawback raised, waiting for approval');
      } else {
        await tx.query(`UPDATE invoice SET status = 'VOID', updated_at = $2, version = version + 1 WHERE id = $1`, [inv.id, now]);
        await this.event(tx, c.partner_id, inv.id, inv.status, 'VOID', actorId, 'Case reversed');
      }
    }
  }

  list(ctx: TenantContext, group: string | undefined) {
    return this.db.withTenant(ctx, async (tx) => {
      const statuses = group ? GROUPS[group] ?? [] : null;
      const { rows } = await tx.query(
        `SELECT ${INVOICE_COLUMNS}, a.full_name_enc FROM invoice i JOIN loan_case c ON c.id = i.case_id JOIN applicant a ON a.id = c.applicant_id
         WHERE $1::text[] IS NULL OR i.status = ANY($1) ORDER BY i.created_at DESC, i.id DESC LIMIT 100`,
        [statuses],
      );
      const totals = await tx.query(
        `SELECT COALESCE(sum(net_paise) FILTER (WHERE status = 'DRAFT'), 0)::float8 AS "pendingPaise",
                COALESCE(sum(net_paise) FILTER (WHERE status IN ('RAISED','APPROVED','DISPUTED')), 0)::float8 AS "underReviewPaise",
                COALESCE(sum(net_paise - recovered_paise) FILTER (WHERE status = 'PAID'), 0)::float8 AS "paidPaise" FROM invoice`,
      );
      return {
        data: rows.map(({ full_name_enc: name, ...r }) => ({ ...r, applicant: maskName(decrypt(this.config.ENCRYPTION_KEY, name)) })),
        summary: totals.rows[0],
      };
    });
  }

  get(ctx: TenantContext, id: string) {
    return this.db.withTenant(ctx, async (tx) => {
      const { rows } = await tx.query(
        `SELECT ${INVOICE_COLUMNS}, i.rate_card_snapshot AS rate, i.billing_snapshot AS billing, a.full_name_enc
         FROM invoice i JOIN loan_case c ON c.id = i.case_id JOIN applicant a ON a.id = c.applicant_id WHERE i.id = $1`,
        [id],
      );
      if (!rows[0]) throw new DomainError('NOT_FOUND', 404, 'Invoice not found.');
      const { full_name_enc: name, ...invoice } = rows[0];
      const events = await tx.query(
        `SELECT e.id, e.from_status AS "fromStatus", e.to_status AS "toStatus", COALESCE(u.name, 'Vittora team') AS actor, e.note, e.at
         FROM invoice_event e LEFT JOIN app_user u ON u.id = e.actor_id WHERE e.invoice_id = $1 ORDER BY e.at, e.id`,
        [id],
      );
      const billing = await tx.query(
        `SELECT verification_status AS status FROM partner_billing`,
      );
      const partner = await tx.query('SELECT kyc_status, legal_name AS "legalName" FROM partner');
      return {
        ...invoice,
        applicant: maskName(decrypt(this.config.ENCRYPTION_KEY, name)),
        events: events.rows,
        legalName: partner.rows[0].legalName as string,
        canRaise: partner.rows[0].kyc_status === 'approved' && billing.rows[0]?.status === 'verified',
      };
    });
  }

  private async lock(tx: Tx, id: string, version: number) {
    const { rows } = await tx.query('SELECT * FROM invoice WHERE id = $1 FOR UPDATE', [id]);
    if (!rows[0]) throw new DomainError('NOT_FOUND', 404, 'Invoice not found.');
    if (rows[0].version !== version) throw new DomainError('VERSION_CONFLICT', 409, 'This invoice changed. Reload and try again.');
    return rows[0];
  }

  /** Numbers are taken here and only here, in this transaction, so a failed raise leaves no gap. */
  async raise(p: Principal, ctx: TenantContext, id: string, version: number, meta: RequestMeta) {
    const now = this.clock.now();
    return this.db.withTenant(ctx, async (tx) => {
      const inv = await this.lock(tx, id, version);
      if (inv.status !== 'DRAFT') throw new DomainError('INVALID_TRANSITION', 409, 'Only a draft invoice can be raised.');
      const partner = await tx.query('SELECT kyc_status, legal_name FROM partner');
      const { rows } = await tx.query('SELECT * FROM partner_billing');
      const billing = rows[0];
      if (partner.rows[0].kyc_status !== 'approved' || billing?.verification_status !== 'verified') {
        throw new DomainError('BILLING_NOT_VERIFIED', 403, 'Your KYC and your bank and GST details must be verified before you can raise an invoice.');
      }
      // GST registration can change after the draft was priced, so settle it now, at the rate on the draft.
      const rate = inv.rate_card_snapshot;
      const money = breakdown(BigInt(inv.disbursal_paise), rate.pctBps, billing.gst_registered ? rate.gstBps : 0, rate.tdsBps);
      const fy = financialYear(now);
      const counter = await tx.query(
        `INSERT INTO invoice_counter (partner_id, fy, last_no) VALUES ($1,$2,1)
         ON CONFLICT (partner_id, fy) DO UPDATE SET last_no = invoice_counter.last_no + 1 RETURNING last_no`,
        [ctx.partnerId, fy],
      );
      const invoiceNo = invoiceNumber(fy, counter.rows[0].last_no);
      const snapshot = {
        legalName: partner.rows[0].legal_name, gstRegistered: billing.gst_registered, gstin: billing.gstin, sacCode: billing.sac_code,
        panLast4: billing.pan_last4, bankLast4: billing.bank_acct_last4, ifsc: billing.ifsc, bankName: billing.bank_name, branch: billing.branch,
      };
      await tx.query(
        `UPDATE invoice SET status = 'RAISED', invoice_no = $2, gst_paise = $3, net_paise = $4, billing_snapshot = $5, raised_at = $6,
           updated_at = $6, version = version + 1 WHERE id = $1`,
        [id, invoiceNo, money.gst, money.net, JSON.stringify(snapshot), now],
      );
      await this.event(tx, ctx.partnerId, id, 'DRAFT', 'RAISED', p.userId);
      await writeAudit(tx, { actorId: p.userId, partnerId: ctx.partnerId, action: 'invoice.raised', entity: 'invoice', entityId: id, after: { invoiceNo }, ip: meta.ip, userAgent: meta.userAgent });
      return { invoiceNo, status: 'RAISED' };
    });
  }

  async dispute(p: Principal, ctx: TenantContext, id: string, version: number, note: string, meta: RequestMeta) {
    await this.db.withTenant(ctx, async (tx) => {
      const inv = await this.lock(tx, id, version);
      if (!['RAISED', 'APPROVED'].includes(inv.status)) throw new DomainError('INVALID_TRANSITION', 409, 'Only a raised or approved invoice can be disputed.');
      const now = this.clock.now();
      await tx.query(`UPDATE invoice SET status = 'DISPUTED', updated_at = $2, version = version + 1 WHERE id = $1`, [id, now]);
      await this.event(tx, ctx.partnerId, id, inv.status, 'DISPUTED', p.userId, note);
      await writeAudit(tx, { actorId: p.userId, partnerId: ctx.partnerId, action: 'invoice.disputed', entity: 'invoice', entityId: id, ip: meta.ip, userAgent: meta.userAgent });
    });
  }
}
