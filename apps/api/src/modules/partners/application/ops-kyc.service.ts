import { Inject, Injectable } from '@nestjs/common';
import { type Clock, DomainError } from '@vittora/shared-kernel';
import type { Config } from '../../../platform/config.js';
import type { Db } from '../../../platform/db.js';
import { signFileLink } from '../../../platform/storage.js';
import { CLOCK, CONFIG, DB } from '../../../platform/tokens.js';
import { writeAudit } from '../../audit/index.js';
import { Outbox } from '../../../platform/outbox.js';
import { type Page, afterClause, limitParam, toPage } from '../../../platform/paging.js';
import { type Principal, type RequestMeta } from '../../identity/index.js';
import { REQUIRED_KYC } from './kyc.service.js';

const PARTNER_COLUMNS = `id, ref_code AS "refCode", legal_name AS "legalName", channel_name AS "channelName", city,
  status, kyc_status AS "kycStatus", created_at AS "createdAt"`;

@Injectable()
export class OpsKycService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(Outbox) private readonly outbox: Outbox,
  ) {}

  // Every staff read of partner data writes an audit row in the same transaction (SEC-02, §7.2, §9.5).

  list(p: Principal, meta: RequestMeta, page: Page, kycStatus?: string) {
    return this.db.withOps(async (tx) => {
      const params: unknown[] = [kycStatus ?? null];
      const after = afterClause(page, 'created_at', 'id', params);
      const limit = limitParam(page, params);
      const { rows } = await tx.query(
        `SELECT ${PARTNER_COLUMNS}, created_at::text AS _sort FROM partner WHERE ($1::text IS NULL OR kyc_status = $1) AND ${after}
         ORDER BY created_at, id LIMIT ${limit}`,
        params,
      );
      const result = toPage(rows, page);
      await writeAudit(tx, { actorId: p.userId, action: 'ops.partners_listed', entity: 'partner', after: { kycStatus: kycStatus ?? null, count: result.data.length }, ip: meta.ip, userAgent: meta.userAgent });
      return result;
    });
  }

  async get(p: Principal, id: string, meta: RequestMeta) {
    return this.db.withOps(async (tx) => {
      const partner = await tx.query(`SELECT ${PARTNER_COLUMNS} FROM partner WHERE id = $1`, [id]);
      if (!partner.rowCount) throw new DomainError('NOT_FOUND', 404, 'Partner not found.');
      await writeAudit(tx, { actorId: p.userId, partnerId: id, action: 'ops.partner_viewed', entity: 'partner', entityId: id, ip: meta.ip, userAgent: meta.userAgent });
      const docs = await tx.query(
        `SELECT id, type, file_name AS "fileName", status, reviewer_note AS "reviewerNote"
         FROM kyc_document WHERE partner_id = $1 ORDER BY type`,
        [id],
      );
      return { ...partner.rows[0], documents: docs.rows, required: REQUIRED_KYC };
    });
  }

  async documentLink(p: Principal, id: string, meta: RequestMeta) {
    const doc = await this.db.withOps(async (tx) => {
      const { rows } = await tx.query(
        `SELECT object_key AS "objectKey", mime, file_name AS "fileName", partner_id FROM kyc_document WHERE id = $1`,
        [id],
      );
      if (rows[0]) await writeAudit(tx, { actorId: p.userId, partnerId: rows[0].partner_id, action: 'ops.kyc_document_viewed', entity: 'kyc_document', entityId: id, ip: meta.ip, userAgent: meta.userAgent });
      return rows[0];
    });
    if (!doc) throw new DomainError('NOT_FOUND', 404, 'Document not found.');
    return { url: signFileLink(this.config, this.clock, { objectKey: doc.objectKey, mime: doc.mime, fileName: doc.fileName }) };
  }

  async reviewDocument(p: Principal, id: string, decision: 'approved' | 'rejected', note: string | undefined, meta: RequestMeta) {
    if (decision === 'rejected' && !note?.trim()) throw new DomainError('NOTE_REQUIRED', 422, 'Say why this document was rejected.');
    const now = this.clock.now();
    await this.db.withOps(async (tx) => {
      const { rows } = await tx.query(
        `SELECT d.partner_id, p.kyc_status FROM kyc_document d JOIN partner p ON p.id = d.partner_id WHERE d.id = $1 FOR UPDATE OF d`,
        [id],
      );
      if (!rows[0]) throw new DomainError('NOT_FOUND', 404, 'Document not found.');
      if (rows[0].kyc_status !== 'submitted') throw new DomainError('KYC_NOT_SUBMITTED', 409, 'This partner is not awaiting review.');
      await tx.query(
        'UPDATE kyc_document SET status = $2, reviewer_note = $3, reviewed_at = $4, reviewed_by = $5 WHERE id = $1',
        [id, decision, note?.trim() || null, now, p.userId],
      );
      await writeAudit(tx, { actorId: p.userId, partnerId: rows[0].partner_id, action: 'kyc.document_reviewed', entity: 'kyc_document', entityId: id, after: { decision }, ip: meta.ip, userAgent: meta.userAgent });
    });
  }

  async decide(p: Principal, partnerId: string, decision: 'approved' | 'rejected', meta: RequestMeta) {
    const admins = await this.db.withOps(async (tx) => {
      const partner = await tx.query('SELECT kyc_status FROM partner WHERE id = $1 FOR UPDATE', [partnerId]);
      if (!partner.rowCount) throw new DomainError('NOT_FOUND', 404, 'Partner not found.');
      if (partner.rows[0].kyc_status !== 'submitted') throw new DomainError('KYC_NOT_SUBMITTED', 409, 'This partner is not awaiting review.');
      const { rows: docs } = await tx.query('SELECT type, status FROM kyc_document WHERE partner_id = $1', [partnerId]);
      const pending = docs.some((d) => d.status === 'pending');
      const rejected = docs.some((d) => d.status === 'rejected');
      if (pending) throw new DomainError('KYC_REVIEW_INCOMPLETE', 409, 'Review every document first.');
      if (decision === 'approved' && (rejected || !REQUIRED_KYC.every((t) => docs.some((d) => d.type === t)))) {
        throw new DomainError('KYC_REVIEW_INCOMPLETE', 409, 'Every required document must be approved.');
      }
      if (decision === 'rejected' && !rejected) {
        throw new DomainError('KYC_REVIEW_INCOMPLETE', 409, 'Reject at least one document, so the partner knows what to fix.');
      }
      await tx.query(
        `UPDATE partner SET kyc_status = $2, status = CASE WHEN $2 = 'approved' THEN 'active' ELSE status END WHERE id = $1`,
        [partnerId, decision],
      );
      await writeAudit(tx, { actorId: p.userId, partnerId, action: `kyc.${decision}`, entity: 'partner', entityId: partnerId, ip: meta.ip, userAgent: meta.userAgent });
      const { rows } = await tx.query(`SELECT email FROM app_user WHERE partner_id = $1 AND role = 'admin' AND status = 'active'`, [partnerId]);
      const ids: string[] = [];
      for (const r of rows) {
        ids.push(await this.outbox.mail(tx, `kyc.${decision}`, {
          to: r.email as string,
          subject: decision === 'approved' ? 'Your Vittora KYC is approved' : 'Your Vittora KYC needs changes',
          text: decision === 'approved'
            ? 'You can now create loan cases.'
            : 'Sign in to see which documents need replacing, then submit again.',
        }));
      }
      return ids;
    });
    await this.outbox.deliver(admins);
  }
}
