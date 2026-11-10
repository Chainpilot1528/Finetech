import { Inject, Injectable } from '@nestjs/common';
import { PRODUCTS } from '@vittora/product-schemas';
import { type Clock, DomainError } from '@vittora/shared-kernel';
import { v7 as uuid } from 'uuid';
import type { Config } from '../../../platform/config.js';
import { decrypt, encrypt, hmac } from '../../../platform/crypto.js';
import type { Db, TenantContext, Tx } from '../../../platform/db.js';
import { IST_START, monthBounds } from '../../../platform/request.js';
import { type DocumentStore, type Scanner, type UploadedFile, prepareUpload, signFileLink } from '../../../platform/storage.js';
import { CLOCK, CONFIG, DB, DOCUMENT_STORE, SCANNER } from '../../../platform/tokens.js';
import { writeAudit } from '../../audit/index.js';
import { type Principal, type RequestMeta, can } from '../../identity/index.js';
import { NotificationsService } from '../../notifications/index.js';
import { BUCKETS, OPEN_STATUSES, STAGES, assertTransition, nextStatuses } from '../domain/lifecycle.js';
import { csvCell, maskEmail, maskName, maskPhone } from '../domain/masking.js';
import { revealDetails } from './case-data.js';
import { type CaseRow, moveCase } from './move-case.js';

const EXPORT_LIMIT = 5000;

export interface CaseFilters {
  status?: string[];
  bucket?: string;
  caseType?: string;
  product?: string[];
  registrationMonth?: string;
  disbursedMonth?: string;
  q?: string;
  sort?: 'created' | 'updated' | 'amount';
  page: number;
  limit: number;
}

interface ListRow {
  id: string; case_no: string; case_type: string; product: string; loan_type: string; status: string; amount: number;
  created_at: Date; updated_at: Date; status_changed_at: Date; full_name_enc: string; phone_enc: string; lender: string; logged_by: string;
}

const ORDER = { created: 'c.created_at DESC', updated: 'c.updated_at DESC', amount: 'c.loan_amount_paise DESC' };

const LIST_COLUMNS = `c.id, c.case_no, c.case_type, c.product, c.loan_type, c.status, c.loan_amount_paise::float8 AS amount,
  c.created_at, c.updated_at, c.status_changed_at, a.full_name_enc, a.phone_enc, l.name AS lender, u.name AS logged_by`;
const LIST_FROM = `FROM loan_case c JOIN applicant a ON a.id = c.applicant_id
  JOIN lender l ON l.id = COALESCE(c.lender_id, c.preferred_lender_id) JOIN app_user u ON u.id = c.owner_user_id`;

@Injectable()
export class TrackingService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(DOCUMENT_STORE) private readonly store: DocumentStore,
    @Inject(SCANNER) private readonly scanner: Scanner,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
  ) {}

  private open(value: string) {
    return decrypt(this.config.ENCRYPTION_KEY, value);
  }
  private blind(kind: string, value: string) {
    return hmac(this.config.HMAC_KEY, `${kind}:${value}`);
  }

  /** Executives see their own cases; everyone else sees the organisation (§7.1). Null means no limit. */
  private ownerScope(p: Principal): string | null {
    return can(p.role, 'case.view_all', p.features) ? null : p.userId;
  }

  private async load(tx: Tx, p: Principal, id: string, lock = false) {
    const { rows } = await tx.query(
      `SELECT * FROM loan_case WHERE id = $1 AND ($2::uuid IS NULL OR owner_user_id = $2) ${lock ? 'FOR UPDATE' : ''}`,
      [id, this.ownerScope(p)],
    );
    if (!rows[0]) throw new DomainError('NOT_FOUND', 404, 'Case not found.');
    return rows[0];
  }

  private row(r: ListRow) {
    const ageHours = Math.floor((this.clock.now().getTime() - r.status_changed_at.getTime()) / 3_600_000);
    return {
      id: r.id, caseNo: r.case_no, caseType: r.case_type, product: r.product, productName: PRODUCTS[r.product]?.name ?? r.product,
      loanType: r.loan_type, status: r.status, loanAmountPaise: r.amount, lender: r.lender, loggedBy: r.logged_by,
      applicant: maskName(this.open(r.full_name_enc)), phone: maskPhone(this.open(r.phone_enc)),
      createdAt: r.created_at, updatedAt: r.updated_at, ageHours,
    };
  }

  private where(p: Principal, f: Omit<CaseFilters, 'page' | 'limit' | 'sort'>) {
    const clauses: string[] = [];
    const params: unknown[] = [];
    const add = (sql: (n: string) => string, value: unknown) => {
      params.push(value);
      clauses.push(sql(`$${params.length}`));
    };
    const owner = this.ownerScope(p);
    if (owner) add((n) => `c.owner_user_id = ${n}`, owner);
    if (f.status) add((n) => `c.status = ANY(${n})`, f.status);
    if (f.bucket) add((n) => `c.status = ANY(${n})`, BUCKETS[f.bucket] ?? []);
    if (f.caseType) add((n) => `c.case_type = ${n}`, f.caseType);
    if (f.product?.length) add((n) => `c.product = ANY(${n})`, f.product);
    if (f.registrationMonth) {
      const [from, to] = monthBounds(f.registrationMonth);
      add((n) => `c.created_at >= ${IST_START(n)}`, from);
      add((n) => `c.created_at < ${IST_START(n)}`, to);
    }
    if (f.disbursedMonth) {
      const [from, to] = monthBounds(f.disbursedMonth);
      params.push(from, to);
      const [a, b] = [params.length - 1, params.length];
      clauses.push(`EXISTS (SELECT 1 FROM disbursal d WHERE d.case_id = c.id AND d.disbursed_on >= $${a}::date AND d.disbursed_on < $${b}::date)`);
    }
    if (f.q) {
      const q = f.q.trim();
      const compact = q.toUpperCase().replace(/\s+/g, '');
      params.push(`%${q.replace(/[\\%_]/g, '\\$&')}%`, q, this.blind('phone', q), [this.blind('collateral', q), this.blind('collateral', compact)]);
      const n = params.length;
      clauses.push(`(c.case_no ILIKE $${n - 3} OR a.phone_last4 = $${n - 2} OR a.phone_hash = $${n - 1} OR c.collateral_key_hash = ANY($${n}))`);
    }
    return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
  }

  list(p: Principal, ctx: TenantContext, f: CaseFilters) {
    return this.db.withTenant(ctx, async (tx) => {
      const { sql, params } = this.where(p, f);
      const total = await tx.query(`SELECT count(*)::int AS n FROM loan_case c JOIN applicant a ON a.id = c.applicant_id ${sql}`, params);
      const { rows } = await tx.query(
        `SELECT ${LIST_COLUMNS} ${LIST_FROM} ${sql} ORDER BY ${ORDER[f.sort ?? 'created']}, c.id DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, f.limit, (f.page - 1) * f.limit],
      );
      const totalItems = total.rows[0].n as number;
      return {
        data: rows.map((r) => this.row(r)),
        pagination: { page: f.page, limit: f.limit, totalItems, totalPages: Math.max(Math.ceil(totalItems / f.limit), 1) },
      };
    });
  }

  /** Always masked, whoever asks. A file leaves the system, so it never carries raw contact details. */
  export(p: Principal, ctx: TenantContext, f: Omit<CaseFilters, 'page' | 'limit'>, meta: RequestMeta) {
    return this.db.withTenant(ctx, async (tx) => {
      const { sql, params } = this.where(p, f);
      const { rows } = await tx.query(
        `SELECT ${LIST_COLUMNS} ${LIST_FROM} ${sql} ORDER BY ${ORDER[f.sort ?? 'created']}, c.id DESC LIMIT ${EXPORT_LIMIT + 1}`,
        params,
      );
      if (rows.length > EXPORT_LIMIT) {
        throw new DomainError('EXPORT_TOO_LARGE', 422, `Narrow your filters to ${EXPORT_LIMIT} cases or fewer.`);
      }
      await writeAudit(tx, { actorId: p.userId, partnerId: ctx.partnerId, action: 'case.exported', after: { rows: rows.length }, ip: meta.ip, userAgent: meta.userAgent });
      const head = ['Case ID', 'Applicant', 'Product', 'Loan type', 'Lender', 'Loan amount (Rs)', 'Status', 'Logged by', 'Last updated'];
      const lines = rows.map((r) => {
        const v = this.row(r);
        return [v.caseNo, v.applicant, v.productName, v.loanType, v.lender, v.loanAmountPaise / 100, v.status, v.loggedBy, v.updatedAt.toISOString()].map(csvCell).join(',');
      });
      return [head.map(csvCell).join(','), ...lines].join('\r\n');
    });
  }

  private async contact(tx: Tx, p: Principal, applicant: { phone_enc: string; email_enc: string | null }) {
    const partner = await tx.query('SELECT mask_customer_contact AS mask FROM partner');
    const phone = this.open(applicant.phone_enc);
    const email = applicant.email_enc ? this.open(applicant.email_enc) : null;
    const plain = !partner.rows[0].mask && can(p.role, 'pii.reveal', p.features);
    return {
      phone: plain ? phone : maskPhone(phone),
      email: email && (plain ? email : maskEmail(email)),
      masked: !plain,
    };
  }

  detail(p: Principal, ctx: TenantContext, id: string) {
    return this.db.withTenant(ctx, async (tx) => {
      const c = await this.load(tx, p, id);
      const applicant = (await tx.query('SELECT * FROM applicant WHERE id = $1', [c.applicant_id])).rows[0];
      const lender = await tx.query('SELECT name FROM lender WHERE id = $1', [c.lender_id ?? c.preferred_lender_id]);
      const owner = await tx.query('SELECT name FROM app_user WHERE id = $1', [c.owner_user_id]);
      // Staff rows aren't visible to a tenant, so their actions show as the Vittora team.
      const history = await tx.query(
        `SELECT h.id, h.from_status AS "fromStatus", h.to_status AS "toStatus", COALESCE(u.name, 'Vittora team') AS actor,
                h.reason_code AS "reasonCode", h.note, h.at
         FROM case_status_history h LEFT JOIN app_user u ON u.id = h.actor_id WHERE h.case_id = $1 ORDER BY h.at, h.id`,
        [id],
      );
      const notes = await tx.query(
        `SELECT n.id, n.body_enc, u.name AS author, n.at FROM case_note n JOIN app_user u ON u.id = n.author_id
         WHERE n.case_id = $1 ORDER BY n.at, n.id`,
        [id],
      );
      const documents = await tx.query(
        `SELECT id, doc_type AS "docType", file_name AS "fileName", at FROM case_document WHERE case_id = $1 ORDER BY at, id`,
        [id],
      );
      const disbursals = await tx.query(
        `SELECT id, tranche_no AS "trancheNo", utr, amount_paise::float8 AS "amountPaise", disbursed_on::text AS "disbursedOn",
                is_final AS "isFinal" FROM disbursal WHERE case_id = $1 ORDER BY tranche_no`,
        [id],
      );
      const canAct = can(p.role, 'case.fieldwork', p.features);
      return {
        id: c.id, caseNo: c.case_no, caseType: c.case_type, status: c.status, version: c.version, product: c.product,
        productName: PRODUCTS[c.product]?.name ?? c.product, loanType: c.loan_type, lender: lender.rows[0].name as string,
        loanAmountPaise: Number(c.loan_amount_paise), tenureMonths: c.tenure_months, purpose: c.purpose,
        sanctionedAmountPaise: c.sanctioned_amount_paise === null ? null : Number(c.sanctioned_amount_paise),
        sanctionedRoiBps: c.sanctioned_roi_bps, sanctionedTenureMonths: c.sanctioned_tenure_months,
        loggedBy: owner.rows[0].name as string, createdAt: c.created_at, updatedAt: c.updated_at, details: revealDetails(this.config.ENCRYPTION_KEY, c),
        applicant: { name: maskName(this.open(applicant.full_name_enc)), city: applicant.city, state: applicant.state, ...(await this.contact(tx, p, applicant)) },
        history: history.rows,
        notes: notes.rows.map((n) => ({ id: n.id, author: n.author, at: n.at, body: this.open(n.body_enc) })),
        documents: documents.rows,
        disbursals: disbursals.rows,
        allowedTransitions: canAct ? nextStatuses(c.status, 'partner', c.relook_from) : [],
        canUpload: canAct && OPEN_STATUSES.includes(c.status),
      };
    });
  }

  async transition(p: Principal, ctx: TenantContext, id: string, version: number, input: { to: string; reasonCode?: string; note: string }, meta: RequestMeta) {
    const now = this.clock.now();
    const mail = await this.db.withTenant(ctx, async (tx) => {
      const c: CaseRow = await this.load(tx, p, id, true);
      if (c.version !== version) throw new DomainError('VERSION_CONFLICT', 409, 'This case changed. Reload and try again.');
      assertTransition(c.status, input.to, 'partner', c.relook_from);
      if (input.to === 'WITHDRAWN') {
        if (!input.reasonCode) throw new DomainError('REASON_REQUIRED', 422, 'Choose a reason.');
        const paid = await tx.query('SELECT 1 FROM disbursal WHERE case_id = $1 LIMIT 1', [id]);
        if (paid.rowCount) throw new DomainError('HAS_DISBURSALS', 409, 'Money has already been paid out on this case.');
      }
      await moveCase(tx, c, input.to, p.userId, now, { reasonCode: input.reasonCode, note: input.note });
      await writeAudit(tx, { actorId: p.userId, partnerId: ctx.partnerId, action: 'case.transitioned', entity: 'case', entityId: id, after: { from: c.status, to: input.to }, ip: meta.ip, userAgent: meta.userAgent });
      return this.notifications.caseChanged(tx, { partnerId: ctx.partnerId, caseId: id, caseNo: c.case_no, ownerId: c.owner_user_id, status: input.to, actorId: p.userId });
    });
    await this.notifications.send(mail);
    return { status: input.to };
  }

  addNote(p: Principal, ctx: TenantContext, id: string, key: string, body: string, meta: RequestMeta) {
    return this.db.withTenant(ctx, async (tx) => {
      await this.load(tx, p, id);
      const noteId = uuid();
      const inserted = await tx.query(
        `INSERT INTO case_note (id, partner_id, case_id, author_id, idempotency_key, body_enc, at) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (case_id, author_id, idempotency_key) DO NOTHING`,
        [noteId, ctx.partnerId, id, p.userId, key, encrypt(this.config.ENCRYPTION_KEY, body), this.clock.now()],
      );
      if (inserted.rowCount) {
        await writeAudit(tx, { actorId: p.userId, partnerId: ctx.partnerId, action: 'case.note_added', entity: 'case', entityId: id, ip: meta.ip, userAgent: meta.userAgent });
      }
      return { saved: true };
    });
  }

  async upload(p: Principal, ctx: TenantContext, id: string, file: UploadedFile | undefined, meta: RequestMeta) {
    const clean = await prepareUpload(file, this.scanner, `cases/${ctx.partnerId}/${id}`);
    // The file is written before the transaction and removed if it rolls back (BUG-02).
    await this.store.put(clean.objectKey, clean.data);
    await this.db.withTenant(ctx, async (tx) => {
      const c = await this.load(tx, p, id, true);
      if (!OPEN_STATUSES.includes(c.status)) throw new DomainError('CASE_CLOSED', 409, 'This case no longer accepts documents.');
      const docId = uuid();
      await tx.query(
        `INSERT INTO case_document (id, partner_id, draft_id, case_id, doc_type, object_key, file_name, mime, sha256, uploaded_by, at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [docId, ctx.partnerId, c.source_draft_id, id, `additional-${docId.slice(-8)}`, clean.objectKey, clean.fileName, clean.mime, clean.sha256, p.userId, this.clock.now()],
      );
      await writeAudit(tx, { actorId: p.userId, partnerId: ctx.partnerId, action: 'case.document_uploaded', entity: 'case', entityId: id, ip: meta.ip, userAgent: meta.userAgent });
    }).catch(async (err) => {
      await this.store.remove(clean.objectKey);
      throw err;
    });
  }

  documentLink(p: Principal, ctx: TenantContext, id: string, docId: string, meta: RequestMeta) {
    return this.db.withTenant(ctx, async (tx) => {
      await this.load(tx, p, id);
      const { rows } = await tx.query(
        `SELECT object_key AS "objectKey", mime, file_name AS "fileName" FROM case_document WHERE id = $1 AND case_id = $2`,
        [docId, id],
      );
      if (!rows[0]) throw new DomainError('NOT_FOUND', 404, 'Document not found.');
      await writeAudit(tx, { actorId: p.userId, partnerId: ctx.partnerId, action: 'case.document_viewed', entity: 'case_document', entityId: docId, ip: meta.ip, userAgent: meta.userAgent });
      return { url: signFileLink(this.config, this.clock, rows[0]) };
    });
  }

  /** The typed reason stays in the reveal log. The audit row keeps ids and codes only (§9.5). */
  reveal(p: Principal, ctx: TenantContext, id: string, field: 'phone' | 'email', reason: string, meta: RequestMeta) {
    return this.db.withTenant(ctx, async (tx) => {
      const c = await this.load(tx, p, id);
      const a = (await tx.query('SELECT id, phone_enc, email_enc FROM applicant WHERE id = $1', [c.applicant_id])).rows[0];
      const stored = field === 'phone' ? a.phone_enc : a.email_enc;
      if (!stored) throw new DomainError('NOT_FOUND', 404, 'This customer has no email on file.');
      await tx.query(
        `INSERT INTO pii_reveal_log (id, partner_id, actor_id, applicant_id, field, reason, at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [uuid(), ctx.partnerId, p.userId, a.id, field, reason, this.clock.now()],
      );
      await writeAudit(tx, { actorId: p.userId, partnerId: ctx.partnerId, action: 'pii.revealed', entity: 'case', entityId: id, after: { field }, ip: meta.ip, userAgent: meta.userAgent });
      return { value: this.open(stored) };
    });
  }

  /** Every number is computed here from cases and status history, under the caller's role scope (§5). */
  dashboard(p: Principal, ctx: TenantContext, month: string, view: 'pipeline' | 'revenue', product: string | undefined) {
    return this.db.withTenant(ctx, async (tx) => {
      const owner = this.ownerScope(p);
      const [from, to] = monthBounds(month);
      const scope = `($1::uuid IS NULL OR c.owner_user_id = $1) AND ($2::text IS NULL OR c.product = $2)`;
      const base = [owner, product ?? null];
      const statusCounts = await tx.query(
        `SELECT c.status, count(*)::int AS n FROM loan_case c
         WHERE ${scope} AND c.created_at >= ${IST_START('$3')} AND c.created_at < ${IST_START('$4')} GROUP BY c.status`,
        [...base, from, to],
      );
      const count = (statuses: string[]) => statusCounts.rows.filter((r) => statuses.includes(r.status)).reduce((s, r) => s + r.n, 0);
      const needs = await tx.query(`SELECT count(*)::int AS n FROM loan_case c WHERE ${scope} AND c.status = ANY($3)`, [...base, BUCKETS.needs_action]);
      const since = new Date(this.clock.now().getTime() - 30 * 86_400_000);
      const decided = await tx.query(
        `SELECT count(DISTINCT h.case_id) FILTER (WHERE h.to_status = 'APPROVED')::int AS approved,
                count(DISTINCT h.case_id) FILTER (WHERE h.to_status = 'REJECTED')::int AS rejected
         FROM case_status_history h JOIN loan_case c ON c.id = h.case_id
         WHERE ${scope} AND h.at >= $3 AND h.to_status IN ('APPROVED','REJECTED')`,
        [...base, since],
      );
      const revenue = await tx.query(
        `SELECT c.product, count(DISTINCT c.id)::int AS cases, COALESCE(sum(d.amount_paise), 0)::float8 AS "amountPaise"
         FROM disbursal d JOIN loan_case c ON c.id = d.case_id
         WHERE ${scope} AND d.disbursed_on >= $3::date AND d.disbursed_on < $4::date GROUP BY c.product`,
        [...base, from, to],
      );
      const recent = await tx.query(
        `SELECT ${LIST_COLUMNS} ${LIST_FROM} WHERE ${scope} ORDER BY c.created_at DESC, c.id DESC LIMIT 5`,
        base,
      );
      const total = await tx.query(`SELECT count(*)::int AS n FROM loan_case c WHERE ${scope}`, base);
      const commission = can(p.role, 'invoices.manage', p.features)
        ? (await tx.query(
            `SELECT COALESCE(sum(net_paise) FILTER (WHERE status IN ('DRAFT')), 0)::float8 AS pending,
                    COALESCE(sum(net_paise) FILTER (WHERE status IN ('RAISED','APPROVED','DISPUTED')), 0)::float8 AS "inReview",
                    COALESCE(sum(net_paise) FILTER (WHERE status = 'PAID'), 0)::float8 AS paid FROM invoice`,
          )).rows[0]
        : null;
      const { approved, rejected } = decided.rows[0];
      return {
        month, view,
        registered: statusCounts.rows.reduce((s, r) => s + r.n, 0),
        stages: STAGES.map((s) => ({ key: s.key, count: count(s.statuses) })),
        needsAction: needs.rows[0].n as number,
        approval: { approved, decided: approved + rejected, ratePct: approved + rejected ? Math.round((approved / (approved + rejected)) * 100) : null },
        revenue: {
          cases: revenue.rows.reduce((s, r) => s + r.cases, 0),
          amountPaise: revenue.rows.reduce((s, r) => s + r.amountPaise, 0),
          byProduct: revenue.rows.map((r) => ({ ...r, productName: PRODUCTS[r.product]?.name ?? r.product })),
        },
        commission,
        recent: recent.rows.map((r) => this.row(r)),
        totalCases: total.rows[0].n as number,
      };
    });
  }
}
