import { Inject, Injectable } from '@nestjs/common';
import { PRODUCTS } from '@vittora/product-schemas';
import { type Clock, DomainError } from '@vittora/shared-kernel';
import { v7 as uuid } from 'uuid';
import type { Config } from '../../../platform/config.js';
import { decrypt } from '../../../platform/crypto.js';
import type { Db, Tx } from '../../../platform/db.js';
import { signFileLink } from '../../../platform/storage.js';
import { CLOCK, CONFIG, DB } from '../../../platform/tokens.js';
import { writeAudit } from '../../audit/index.js';
import { CommissionsService } from '../../commissions/application/commissions.service.js';
import type { Principal, RequestMeta } from '../../identity/index.js';
import { NotificationsService } from '../../notifications/index.js';
import { assertTransition, nextStatuses } from '../domain/lifecycle.js';
import { type CaseRow, moveCase } from './move-case.js';

export interface OpsTransition {
  to: string;
  reasonCode?: string;
  note?: string;
  lenderId?: string;
  sanctionedAmount?: number;
  roiBps?: number;
  tenureMonths?: number;
  checklistComplete?: boolean;
}

export interface DisbursalInput {
  utr: string;
  amount: number;
  disbursedOn: string;
  isFinal: boolean;
}

const bad = (code: string, message: string) => new DomainError(code, 422, message);

/** The ops console. It works with case facts, documents and location, never customer identity. */
@Injectable()
export class OpsCasesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
    @Inject(CommissionsService) private readonly commissions: CommissionsService,
  ) {}

  private async load(tx: Tx, id: string) {
    const { rows } = await tx.query('SELECT * FROM loan_case WHERE id = $1 FOR UPDATE', [id]);
    if (!rows[0]) throw new DomainError('NOT_FOUND', 404, 'Case not found.');
    return rows[0];
  }

  private checkVersion(c: { version: number }, version: number) {
    if (c.version !== version) throw new DomainError('VERSION_CONFLICT', 409, 'This case changed. Reload and try again.');
  }

  private changed(tx: Tx, c: CaseRow, status: string, actorId: string) {
    return this.notifications.caseChanged(tx, { partnerId: c.partner_id, caseId: c.id, caseNo: c.case_no, ownerId: c.owner_user_id, status, actorId });
  }

  queue(p: Principal, f: { status?: string; assigned?: 'me' | 'none'; page: number; limit: number }) {
    return this.db.withOps(async (tx) => {
      const where = `($1::text IS NULL OR c.status = $1) AND ($2::text IS NULL OR ($2 = 'me' AND c.assignee_ops_id = $3) OR ($2 = 'none' AND c.assignee_ops_id IS NULL))`;
      const params = [f.status ?? null, f.assigned ?? null, p.userId];
      const total = await tx.query(`SELECT count(*)::int AS n FROM loan_case c WHERE ${where}`, params);
      const { rows } = await tx.query(
        `SELECT c.id, c.case_no AS "caseNo", c.product, c.status, c.loan_amount_paise::float8 AS "loanAmountPaise",
                c.status_changed_at, c.possible_duplicate AS "possibleDuplicate", pa.channel_name AS partner, u.name AS assignee
         FROM loan_case c JOIN partner pa ON pa.id = c.partner_id LEFT JOIN app_user u ON u.id = c.assignee_ops_id
         WHERE ${where} ORDER BY c.status_changed_at, c.id LIMIT $4 OFFSET $5`,
        [...params, f.limit, (f.page - 1) * f.limit],
      );
      const now = this.clock.now().getTime();
      const totalItems = total.rows[0].n as number;
      return {
        data: rows.map(({ status_changed_at: at, ...r }) => ({ ...r, productName: PRODUCTS[r.product]?.name ?? r.product, ageHours: Math.floor((now - new Date(at).getTime()) / 3_600_000) })),
        pagination: { page: f.page, limit: f.limit, totalItems, totalPages: Math.max(Math.ceil(totalItems / f.limit), 1) },
      };
    });
  }

  detail(id: string) {
    return this.db.withOps(async (tx) => {
      const { rows } = await tx.query(
        `SELECT c.*, pa.channel_name AS partner, a.city, a.state, a.pincode, u.name AS assignee
         FROM loan_case c JOIN partner pa ON pa.id = c.partner_id JOIN applicant a ON a.id = c.applicant_id
         LEFT JOIN app_user u ON u.id = c.assignee_ops_id WHERE c.id = $1`,
        [id],
      );
      const c = rows[0];
      if (!c) throw new DomainError('NOT_FOUND', 404, 'Case not found.');
      const history = await tx.query(
        `SELECT h.id, h.from_status AS "fromStatus", h.to_status AS "toStatus", u.name AS actor, h.reason_code AS "reasonCode", h.note, h.at
         FROM case_status_history h JOIN app_user u ON u.id = h.actor_id WHERE h.case_id = $1 ORDER BY h.at, h.id`,
        [id],
      );
      const documents = await tx.query(`SELECT id, doc_type AS "docType", file_name AS "fileName", at FROM case_document WHERE case_id = $1 ORDER BY at, id`, [id]);
      const notes = await tx.query(
        `SELECT n.id, n.body_enc, u.name AS author, n.at FROM case_note n JOIN app_user u ON u.id = n.author_id WHERE n.case_id = $1 ORDER BY n.at, n.id`,
        [id],
      );
      const disbursals = await tx.query(
        `SELECT id, tranche_no AS "trancheNo", utr, amount_paise::float8 AS "amountPaise", disbursed_on::text AS "disbursedOn", is_final AS "isFinal"
         FROM disbursal WHERE case_id = $1 ORDER BY tranche_no`,
        [id],
      );
      const reversal = await tx.query(
        `SELECT id, reason_code AS "reasonCode", reference, note, status FROM case_reversal WHERE case_id = $1 ORDER BY requested_at DESC LIMIT 1`,
        [id],
      );
      const lenders = await tx.query(
        `SELECT l.id, l.name FROM lender l JOIN lender_product lp ON lp.lender_id = l.id
         WHERE lp.product_code = $1 AND l.active AND lp.active ORDER BY l.name`,
        [c.product],
      );
      return {
        id: c.id, caseNo: c.case_no, status: c.status, version: c.version, partner: c.partner, product: c.product,
        productName: PRODUCTS[c.product]?.name ?? c.product, loanType: c.loan_type, assignee: c.assignee,
        loanAmountPaise: Number(c.loan_amount_paise), tenureMonths: c.tenure_months, possibleDuplicate: c.possible_duplicate,
        lenderId: c.lender_id ?? c.preferred_lender_id, lenders: lenders.rows,
        sanctionedAmountPaise: c.sanctioned_amount_paise === null ? null : Number(c.sanctioned_amount_paise),
        location: { city: c.city, state: c.state, pincode: c.pincode },
        details: c.product_details, history: history.rows, documents: documents.rows, disbursals: disbursals.rows,
        notes: notes.rows.map((n) => ({ id: n.id, author: n.author, at: n.at, body: decrypt(this.config.ENCRYPTION_KEY, n.body_enc) })),
        reversal: reversal.rows[0] ?? null,
        allowedTransitions: nextStatuses(c.status, 'ops', c.relook_from),
      };
    });
  }

  staff() {
    return this.db.withOps(async (tx) => {
      const { rows } = await tx.query(`SELECT id, name FROM app_user WHERE role IN ('ops_agent','ops_lead') AND status = 'active' ORDER BY name`);
      return rows;
    });
  }

  async assign(p: Principal, id: string, userId: string, meta: RequestMeta) {
    await this.db.withOps(async (tx) => {
      await this.load(tx, id);
      const staff = await tx.query(`SELECT 1 FROM app_user WHERE id = $1 AND role IN ('ops_agent','ops_lead') AND status = 'active'`, [userId]);
      if (!staff.rowCount) throw bad('ASSIGNEE_INVALID', 'Choose an active ops team member.');
      await this.setAssignee(tx, p, id, userId, meta);
    });
  }

  private async setAssignee(tx: Tx, p: Principal, id: string, userId: string, meta: RequestMeta) {
    await tx.query('UPDATE loan_case SET assignee_ops_id = $2, updated_at = $3 WHERE id = $1', [id, userId, this.clock.now()]);
    const c = await tx.query('SELECT partner_id FROM loan_case WHERE id = $1', [id]);
    await writeAudit(tx, { actorId: p.userId, partnerId: c.rows[0].partner_id, action: 'case.assigned', entity: 'case', entityId: id, after: { assignee: userId }, ip: meta.ip, userAgent: meta.userAgent });
  }

  async take(p: Principal, id: string, meta: RequestMeta) {
    await this.db.withOps(async (tx) => {
      const c = await this.load(tx, id);
      if (c.assignee_ops_id && c.assignee_ops_id !== p.userId) throw new DomainError('ALREADY_ASSIGNED', 409, 'Someone else already has this case.');
      await this.setAssignee(tx, p, id, p.userId, meta);
    });
  }

  /** Round-robin that favours whoever has the fewest open cases. */
  autoAssign(p: Principal, meta: RequestMeta) {
    return this.db.withOps(async (tx) => {
      const { rows: team } = await tx.query(
        `SELECT u.id, count(c.id)::int AS load FROM app_user u
         LEFT JOIN loan_case c ON c.assignee_ops_id = u.id AND c.status NOT IN ('DISBURSED','REVERSED','REJECTED','WITHDRAWN')
         WHERE u.role = 'ops_agent' AND u.status = 'active' GROUP BY u.id`,
      );
      if (!team.length) throw new DomainError('NO_AGENTS', 409, 'There are no active ops agents.');
      const { rows: waiting } = await tx.query(
        `SELECT id FROM loan_case WHERE assignee_ops_id IS NULL AND status NOT IN ('DISBURSED','REVERSED','REJECTED','WITHDRAWN')
         ORDER BY status_changed_at FOR UPDATE SKIP LOCKED`,
      );
      for (const c of waiting) {
        team.sort((a, b) => a.load - b.load);
        await this.setAssignee(tx, p, c.id, team[0]!.id, meta);
        team[0]!.load += 1;
      }
      return { assigned: waiting.length };
    });
  }

  async transition(p: Principal, id: string, version: number, input: OpsTransition, meta: RequestMeta) {
    const now = this.clock.now();
    const mail = await this.db.withOps(async (tx) => {
      const c = await this.load(tx, id);
      this.checkVersion(c, version);
      assertTransition(c.status, input.to, 'ops', c.relook_from);
      const move: Parameters<typeof moveCase>[5] = { reasonCode: input.reasonCode, note: input.note };

      switch (input.to) {
        case 'IN_REVIEW': {
          const offered = await tx.query(
            `SELECT 1 FROM lender_product lp JOIN lender l ON l.id = lp.lender_id WHERE lp.lender_id = $1 AND lp.product_code = $2 AND lp.active AND l.active`,
            [input.lenderId ?? null, c.product],
          );
          if (!offered.rowCount) throw bad('LENDER_REQUIRED', 'Choose a lender that offers this product.');
          Object.assign(move, { set: 'lender_id = $5', values: [input.lenderId] });
          break;
        }
        case 'APPROVED':
          if (!input.sanctionedAmount || !input.roiBps || !input.tenureMonths) throw bad('SANCTION_REQUIRED', 'Enter the sanctioned amount, rate and tenure.');
          Object.assign(move, {
            set: 'sanctioned_amount_paise = $5, sanctioned_roi_bps = $6, sanctioned_tenure_months = $7',
            values: [BigInt(input.sanctionedAmount) * 100n, input.roiBps, input.tenureMonths],
          });
          break;
        case 'CUSTOMER_APPROVED': {
          const consent = await tx.query(`SELECT 1 FROM customer_consent WHERE case_id = $1 AND purpose = 'processing' AND consented_at IS NOT NULL`, [id]);
          if (!consent.rowCount) throw new DomainError('CONSENT_REQUIRED', 409, 'There is no customer consent on this case.');
          break;
        }
        case 'DISBURSAL_IN_PROGRESS':
          if (!input.checklistComplete) throw bad('CHECKLIST_REQUIRED', 'Confirm the disbursal checklist is complete.');
          break;
        case 'RELOOK':
          if (!input.note?.trim()) throw bad('NOTE_REQUIRED', 'Say what is missing.');
          move.relookFrom = c.status;
          break;
        case 'REJECTED':
        case 'WITHDRAWN': {
          if (!input.reasonCode || !input.note?.trim()) throw bad('REASON_REQUIRED', 'Give a reason and a note.');
          const paid = await tx.query('SELECT 1 FROM disbursal WHERE case_id = $1 LIMIT 1', [id]);
          if (paid.rowCount) throw new DomainError('HAS_DISBURSALS', 409, 'Money has already been paid out on this case.');
          break;
        }
      }
      await moveCase(tx, c, input.to, p.userId, now, move);
      await writeAudit(tx, { actorId: p.userId, partnerId: c.partner_id, action: 'case.transitioned', entity: 'case', entityId: id, after: { from: c.status, to: input.to }, ip: meta.ip, userAgent: meta.userAgent });
      return this.changed(tx, c, input.to, p.userId);
    });
    this.notifications.send(mail);
    return { status: input.to };
  }

  /** Each tranche creates its own invoice. The final one moves the case to DISBURSED (§4.6). */
  async recordDisbursal(p: Principal, id: string, version: number, input: DisbursalInput, meta: RequestMeta) {
    const now = this.clock.now();
    if (input.disbursedOn > now.toISOString().slice(0, 10)) throw bad('DATE_IN_FUTURE', 'The disbursal date cannot be in the future.');
    const { mail, ...result } = await this.db.withOps(async (tx) => {
      const c = await this.load(tx, id);
      this.checkVersion(c, version);
      if (c.status !== 'DISBURSAL_IN_PROGRESS') throw new DomainError('INVALID_TRANSITION', 409, 'This case is not being disbursed.');
      const sofar = await tx.query('SELECT COALESCE(sum(amount_paise), 0)::text AS paid, count(*)::int AS n FROM disbursal WHERE case_id = $1', [id]);
      const amount = BigInt(input.amount) * 100n;
      if (BigInt(sofar.rows[0].paid) + amount > BigInt(c.sanctioned_amount_paise)) {
        throw bad('OVER_SANCTIONED', 'This is more than the amount left to disburse.');
      }
      const utrTaken = await tx.query('SELECT 1 FROM disbursal WHERE utr = $1', [input.utr]);
      if (utrTaken.rowCount) throw new DomainError('UTR_DUPLICATE', 409, 'This UTR is already recorded.');
      const disbursalId = uuid();
      const tranche = (sofar.rows[0].n as number) + 1;
      await tx.query(
        `INSERT INTO disbursal (id, partner_id, case_id, tranche_no, utr, amount_paise, disbursed_on, is_final, recorded_by, at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [disbursalId, c.partner_id, id, tranche, input.utr, amount, input.disbursedOn, input.isFinal, p.userId, now],
      );
      const invoice = await this.commissions.createForDisbursal(tx, { id: disbursalId, amountPaise: amount, disbursedOn: input.disbursedOn }, c, p.userId);
      if (input.isFinal) {
        await moveCase(tx, c, 'DISBURSED', p.userId, now, { note: `Final disbursal, tranche ${tranche}`, set: 'disbursed_at = $5', values: [now] });
      } else {
        await tx.query('UPDATE loan_case SET updated_at = $2, version = version + 1 WHERE id = $1', [id, now]);
      }
      await writeAudit(tx, { actorId: p.userId, partnerId: c.partner_id, action: 'case.disbursal_recorded', entity: 'case', entityId: id, after: { tranche, final: input.isFinal }, ip: meta.ip, userAgent: meta.userAgent });
      return { id: disbursalId, trancheNo: tranche, invoiceStatus: invoice.status, mail: await this.changed(tx, c, input.isFinal ? 'DISBURSED' : c.status, p.userId) };
    });
    this.notifications.send(mail);
    return result;
  }

  async requestReversal(p: Principal, id: string, version: number, input: { reasonCode: string; reference: string; note?: string }, meta: RequestMeta) {
    await this.db.withOps(async (tx) => {
      const c = await this.load(tx, id);
      this.checkVersion(c, version);
      if (c.status !== 'DISBURSED') throw new DomainError('INVALID_TRANSITION', 409, 'Only a disbursed case can be reversed.');
      const open = await tx.query(`SELECT 1 FROM case_reversal WHERE case_id = $1 AND status = 'pending'`, [id]);
      if (open.rowCount) throw new DomainError('REVERSAL_PENDING', 409, 'A reversal is already waiting for approval.');
      await tx.query(
        `INSERT INTO case_reversal (id, partner_id, case_id, reason_code, reference, note, requested_by, requested_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [uuid(), c.partner_id, id, input.reasonCode, input.reference, input.note ?? null, p.userId, this.clock.now()],
      );
      await writeAudit(tx, { actorId: p.userId, partnerId: c.partner_id, action: 'case.reversal_requested', entity: 'case', entityId: id, after: { reasonCode: input.reasonCode }, ip: meta.ip, userAgent: meta.userAgent });
    });
  }

  async decideReversal(p: Principal, id: string, decision: 'approved' | 'rejected', meta: RequestMeta) {
    const now = this.clock.now();
    const mail = await this.db.withOps(async (tx) => {
      const c = await this.load(tx, id);
      const { rows } = await tx.query(`SELECT * FROM case_reversal WHERE case_id = $1 AND status = 'pending' FOR UPDATE`, [id]);
      const r = rows[0];
      if (!r) throw new DomainError('NOT_FOUND', 404, 'No reversal is waiting for approval.');
      if (r.requested_by === p.userId) throw new DomainError('SECOND_APPROVER_REQUIRED', 403, 'Someone else must approve this.');
      await tx.query('UPDATE case_reversal SET status = $2, decided_by = $3, decided_at = $4 WHERE id = $1', [r.id, decision, p.userId, now]);
      await writeAudit(tx, { actorId: p.userId, partnerId: c.partner_id, action: `case.reversal_${decision}`, entity: 'case', entityId: id, ip: meta.ip, userAgent: meta.userAgent });
      if (decision === 'rejected') return [];
      await moveCase(tx, c, 'REVERSED', p.userId, now, { reasonCode: r.reason_code, note: `Reference ${r.reference}` });
      await this.commissions.onCaseReversed(tx, c, p.userId, r.reason_code);
      return this.changed(tx, c, 'REVERSED', p.userId);
    });
    this.notifications.send(mail);
  }

  documentLink(p: Principal, id: string, docId: string, meta: RequestMeta) {
    return this.db.withOps(async (tx) => {
      const { rows } = await tx.query(
        `SELECT object_key AS "objectKey", mime, file_name AS "fileName", partner_id FROM case_document WHERE id = $1 AND case_id = $2`,
        [docId, id],
      );
      if (!rows[0]) throw new DomainError('NOT_FOUND', 404, 'Document not found.');
      await writeAudit(tx, { actorId: p.userId, partnerId: rows[0].partner_id, action: 'case.document_viewed', entity: 'case_document', entityId: docId, ip: meta.ip, userAgent: meta.userAgent });
      return { url: signFileLink(this.config, this.clock, rows[0]) };
    });
  }
}
