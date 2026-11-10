import { Inject, Injectable } from '@nestjs/common';
import { type Clock, DomainError, Money } from '@vittora/shared-kernel';
import { v7 as uuid } from 'uuid';
import type { Db, Tx } from '../../../platform/db.js';
import { CLOCK, DB } from '../../../platform/tokens.js';
import { writeAudit } from '../../audit/index.js';
import type { Principal, RequestMeta } from '../../identity/index.js';
import { CommissionsService } from './commissions.service.js';

export interface RateCardInput {
  lenderId: string;
  product: string;
  loanType?: string;
  slabMin: number;
  slabMax?: number;
  pctBps: number;
  clawbackMonths: number;
  validFrom: string;
  validTo?: string;
}

const secondApprover = () => new DomainError('SECOND_APPROVER_REQUIRED', 403, 'Someone else must approve this.');

@Injectable()
export class OpsFinanceService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CommissionsService) private readonly commissions: CommissionsService,
  ) {}

  private async event(tx: Tx, partnerId: string, invoiceId: string, from: string, to: string, actorId: string, note?: string) {
    await tx.query(
      `INSERT INTO invoice_event (id, partner_id, invoice_id, from_status, to_status, actor_id, note, at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [uuid(), partnerId, invoiceId, from, to, actorId, note ?? null, this.clock.now()],
    );
  }

  private async lock(tx: Tx, id: string, version: number, status: string[]) {
    const { rows } = await tx.query('SELECT * FROM invoice WHERE id = $1 FOR UPDATE', [id]);
    const inv = rows[0];
    if (!inv) throw new DomainError('NOT_FOUND', 404, 'Invoice not found.');
    if (inv.version !== version) throw new DomainError('VERSION_CONFLICT', 409, 'This invoice changed. Reload and try again.');
    if (!status.includes(inv.status)) throw new DomainError('INVALID_TRANSITION', 409, `This invoice is ${inv.status}.`);
    return inv;
  }

  invoices(status: string | undefined) {
    return this.db.withOps(async (tx) => {
      const { rows } = await tx.query(
        `SELECT i.id, i.invoice_no AS "invoiceNo", i.status, c.case_no AS "caseNo", pa.channel_name AS partner, i.version,
                i.gross_paise::float8 AS "grossPaise", i.net_paise::float8 AS "netPaise", i.payout_ref AS "payoutRef",
                i.payout_requested_by AS "payoutRequestedBy", i.billing_snapshot AS billing
         FROM invoice i JOIN loan_case c ON c.id = i.case_id JOIN partner pa ON pa.id = i.partner_id
         WHERE $1::text IS NULL OR i.status = $1 ORDER BY i.updated_at DESC, i.id DESC LIMIT 100`,
        [status ?? null],
      );
      return rows;
    });
  }

  async approve(p: Principal, id: string, version: number, meta: RequestMeta) {
    await this.db.withOps(async (tx) => {
      const inv = await this.lock(tx, id, version, ['RAISED']);
      const now = this.clock.now();
      await tx.query(`UPDATE invoice SET status = 'APPROVED', approved_at = $2, updated_at = $2, version = version + 1 WHERE id = $1`, [id, now]);
      await this.event(tx, inv.partner_id, id, 'RAISED', 'APPROVED', p.userId);
      await writeAudit(tx, { actorId: p.userId, partnerId: inv.partner_id, action: 'invoice.approved', entity: 'invoice', entityId: id, ip: meta.ip, userAgent: meta.userAgent });
    });
  }

  /** Step one of two: the payment reference goes on the invoice, but it isn't PAID yet. */
  async requestPaid(p: Principal, id: string, version: number, payoutRef: string, meta: RequestMeta) {
    await this.db.withOps(async (tx) => {
      const inv = await this.lock(tx, id, version, ['APPROVED']);
      if (inv.payout_requested_by) throw new DomainError('PAYOUT_PENDING', 409, 'This payout is already waiting for confirmation.');
      await tx.query(
        `UPDATE invoice SET payout_ref = $2, payout_requested_by = $3, updated_at = $4, version = version + 1 WHERE id = $1`,
        [id, payoutRef, p.userId, this.clock.now()],
      );
      await writeAudit(tx, { actorId: p.userId, partnerId: inv.partner_id, action: 'invoice.payout_requested', entity: 'invoice', entityId: id, ip: meta.ip, userAgent: meta.userAgent });
    });
  }

  /** Step two: a different person confirms. Approved clawbacks are recovered from this payout, oldest first. */
  async confirmPaid(p: Principal, id: string, version: number, meta: RequestMeta) {
    return this.db.withOps(async (tx) => {
      const inv = await this.lock(tx, id, version, ['APPROVED']);
      if (!inv.payout_requested_by) throw new DomainError('PAYOUT_NOT_REQUESTED', 409, 'Record the payment reference first.');
      if (inv.payout_requested_by === p.userId) throw secondApprover();
      const now = this.clock.now();
      let left = BigInt(inv.net_paise);
      const { rows: owed } = await tx.query(
        `SELECT id, amount_paise, recovered_paise FROM clawback WHERE partner_id = $1 AND status = 'approved' ORDER BY at, id FOR UPDATE`,
        [inv.partner_id],
      );
      for (const cb of owed) {
        if (left === 0n) break;
        const due = BigInt(cb.amount_paise) - BigInt(cb.recovered_paise);
        const take = due < left ? due : left;
        await tx.query(
          `INSERT INTO clawback_recovery (id, partner_id, clawback_id, invoice_id, amount_paise, at) VALUES ($1,$2,$3,$4,$5,$6)`,
          [uuid(), inv.partner_id, cb.id, id, take, now],
        );
        await tx.query(
          `UPDATE clawback SET recovered_paise = recovered_paise + $2, status = CASE WHEN recovered_paise + $2 = amount_paise THEN 'recovered' ELSE status END WHERE id = $1`,
          [cb.id, take],
        );
        left -= take;
      }
      const recovered = BigInt(inv.net_paise) - left;
      await tx.query(
        `UPDATE invoice SET status = 'PAID', paid_at = $2, payout_confirmed_by = $3, recovered_paise = $4, updated_at = $2, version = version + 1 WHERE id = $1`,
        [id, now, p.userId, recovered],
      );
      await this.event(tx, inv.partner_id, id, 'APPROVED', 'PAID', p.userId, recovered > 0n ? 'Clawback recovered from this payout' : undefined);
      await writeAudit(tx, { actorId: p.userId, partnerId: inv.partner_id, action: 'invoice.paid', entity: 'invoice', entityId: id, ip: meta.ip, userAgent: meta.userAgent });
      return { payoutPaise: Number(left), recoveredPaise: Number(recovered) };
    });
  }

  async resolveDispute(p: Principal, id: string, version: number, outcome: 'reinstate' | 'void', note: string, meta: RequestMeta) {
    await this.db.withOps(async (tx) => {
      const inv = await this.lock(tx, id, version, ['DISPUTED']);
      const to = outcome === 'void' ? 'VOID' : 'RAISED';
      await tx.query(
        `UPDATE invoice SET status = $2, payout_ref = NULL, payout_requested_by = NULL, updated_at = $3, version = version + 1 WHERE id = $1`,
        [id, to, this.clock.now()],
      );
      await this.event(tx, inv.partner_id, id, 'DISPUTED', to, p.userId, note);
      await writeAudit(tx, { actorId: p.userId, partnerId: inv.partner_id, action: 'invoice.dispute_resolved', entity: 'invoice', entityId: id, after: { outcome }, ip: meta.ip, userAgent: meta.userAgent });
    });
  }

  rateCards() {
    return this.db.withOps(async (tx) => {
      const { rows } = await tx.query(
        `SELECT r.id, l.name AS lender, r.product, r.loan_type AS "loanType", r.slab_min_paise::float8 AS "slabMinPaise",
                r.slab_max_paise::float8 AS "slabMaxPaise", r.pct_bps AS "pctBps", r.clawback_months AS "clawbackMonths",
                r.valid_from::text AS "validFrom", r.valid_to::text AS "validTo", r.status, r.created_by AS "createdBy"
         FROM rate_card r JOIN lender l ON l.id = r.lender_id ORDER BY r.created_at DESC, r.id DESC LIMIT 100`,
      );
      const lenders = await tx.query('SELECT id, name FROM lender WHERE active ORDER BY name');
      return { data: rows, lenders: lenders.rows };
    });
  }

  createRateCard(p: Principal, input: RateCardInput, meta: RequestMeta) {
    return this.db.withOps(async (tx) => {
      const id = uuid();
      const lender = await tx.query('SELECT 1 FROM lender WHERE id = $1', [input.lenderId]);
      const product = await tx.query('SELECT 1 FROM product WHERE code = $1', [input.product]);
      if (!lender.rowCount || !product.rowCount) throw new DomainError('VALIDATION_FAILED', 422, 'Choose a lender and product.');
      if (input.slabMax !== undefined && input.slabMax < input.slabMin) throw new DomainError('VALIDATION_FAILED', 422, 'The slab maximum is below the minimum.');
      await tx.query(
        `INSERT INTO rate_card (id, lender_id, product, loan_type, slab_min_paise, slab_max_paise, pct_bps, clawback_months, valid_from, valid_to, created_by, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [id, input.lenderId, input.product, input.loanType ?? null, Money.fromRupees(input.slabMin),
         input.slabMax === undefined ? null : Money.fromRupees(input.slabMax), input.pctBps, input.clawbackMonths, input.validFrom, input.validTo ?? null, p.userId, this.clock.now()],
      );
      await writeAudit(tx, { actorId: p.userId, action: 'rate_card.created', entity: 'rate_card', entityId: id, after: { pctBps: input.pctBps }, ip: meta.ip, userAgent: meta.userAgent });
      return { id, status: 'pending' };
    });
  }

  decideRateCard(p: Principal, id: string, decision: 'active' | 'rejected', meta: RequestMeta) {
    return this.db.withOps(async (tx) => {
      const { rows } = await tx.query('SELECT status, created_by FROM rate_card WHERE id = $1 FOR UPDATE', [id]);
      if (!rows[0]) throw new DomainError('NOT_FOUND', 404, 'Rate card not found.');
      if (rows[0].status !== 'pending') throw new DomainError('INVALID_TRANSITION', 409, 'This rate card was already decided.');
      if (rows[0].created_by === p.userId) throw secondApprover();
      await tx.query('UPDATE rate_card SET status = $2, approved_by = $3, decided_at = $4 WHERE id = $1', [id, decision, p.userId, this.clock.now()]);
      await writeAudit(tx, { actorId: p.userId, action: 'rate_card.decided', entity: 'rate_card', entityId: id, after: { decision }, ip: meta.ip, userAgent: meta.userAgent });
      return { priced: decision === 'active' ? await this.commissions.priceWaiting(tx, p.userId) : 0 };
    });
  }

  clawbacks() {
    return this.db.withOps(async (tx) => {
      const { rows } = await tx.query(
        `SELECT b.id, pa.channel_name AS partner, i.invoice_no AS "invoiceNo", b.amount_paise::float8 AS "amountPaise",
                b.recovered_paise::float8 AS "recoveredPaise", b.reason, b.status, b.raised_by AS "raisedBy"
         FROM clawback b JOIN invoice i ON i.id = b.invoice_id JOIN partner pa ON pa.id = b.partner_id ORDER BY b.at DESC, b.id DESC LIMIT 100`,
      );
      return rows;
    });
  }

  async decideClawback(p: Principal, id: string, decision: 'approved' | 'rejected', meta: RequestMeta) {
    await this.db.withOps(async (tx) => {
      const { rows } = await tx.query('SELECT status, raised_by, partner_id, invoice_id FROM clawback WHERE id = $1 FOR UPDATE', [id]);
      const cb = rows[0];
      if (!cb) throw new DomainError('NOT_FOUND', 404, 'Clawback not found.');
      if (cb.status !== 'pending') throw new DomainError('INVALID_TRANSITION', 409, 'This clawback was already decided.');
      if (cb.raised_by === p.userId) throw secondApprover();
      await tx.query('UPDATE clawback SET status = $2, approved_by = $3, decided_at = $4 WHERE id = $1', [id, decision, p.userId, this.clock.now()]);
      await this.event(tx, cb.partner_id, cb.invoice_id, 'PAID', 'PAID', p.userId, `Clawback ${decision}`);
      await writeAudit(tx, { actorId: p.userId, partnerId: cb.partner_id, action: 'clawback.decided', entity: 'clawback', entityId: id, after: { decision }, ip: meta.ip, userAgent: meta.userAgent });
    });
  }
}
