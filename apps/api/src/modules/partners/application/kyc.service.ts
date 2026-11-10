import { Inject, Injectable } from '@nestjs/common';
import { AGREEMENT_TEXT, AGREEMENT_VERSION, type KycType, REQUIRED_KYC, kycDocumentsReady } from '@vittora/product-schemas';
import { type Clock, DomainError } from '@vittora/shared-kernel';
import { v7 as uuid } from 'uuid';
import type { Config } from '../../../platform/config.js';
import { sha256 } from '../../../platform/crypto.js';
import type { Db, TenantContext, Tx } from '../../../platform/db.js';
import { Outbox } from '../../../platform/outbox.js';
import { type DocumentStore, type Scanner, type UploadedFile, prepareUpload, signFileLink } from '../../../platform/storage.js';
import { CLOCK, CONFIG, DB, DOCUMENT_STORE, SCANNER } from '../../../platform/tokens.js';
import { writeAudit } from '../../audit/index.js';
import type { Principal, RequestMeta } from '../../identity/index.js';

export { KYC_TYPES, type KycType, REQUIRED_KYC } from '@vittora/product-schemas';

const DOC_COLUMNS = `id, type, file_name AS "fileName", status, reviewer_note AS "reviewerNote", submitted_at AS "submittedAt"`;

@Injectable()
export class KycService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(DOCUMENT_STORE) private readonly store: DocumentStore,
    @Inject(SCANNER) private readonly scanner: Scanner,
    @Inject(Outbox) private readonly outbox: Outbox,
  ) {}

  private async agreementAccepted(tx: Tx) {
    const { rowCount } = await tx.query('SELECT 1 FROM partner_agreement WHERE version = $1', [AGREEMENT_VERSION]);
    return !!rowCount;
  }

  async status(ctx: TenantContext) {
    return this.db.withTenant(ctx, async (tx) => {
      const partner = await tx.query('SELECT kyc_status AS status FROM partner');
      const docs = await tx.query(`SELECT ${DOC_COLUMNS} FROM kyc_document ORDER BY type`);
      return {
        status: partner.rows[0].status as string,
        agreementAccepted: await this.agreementAccepted(tx),
        documents: docs.rows,
        required: REQUIRED_KYC,
      };
    });
  }

  agreement() {
    return { version: AGREEMENT_VERSION, text: AGREEMENT_TEXT };
  }

  async acceptAgreement(p: Principal, ctx: TenantContext, version: string, meta: RequestMeta) {
    if (version !== AGREEMENT_VERSION) throw new DomainError('AGREEMENT_OUTDATED', 409, 'Please read the latest agreement.');
    await this.db.withTenant(ctx, async (tx) => {
      if (await this.agreementAccepted(tx)) return;
      await tx.query(
        `INSERT INTO partner_agreement (id, partner_id, version, document_hash, accepted_by, accepted_at, ip)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [uuid(), ctx.partnerId, version, sha256(AGREEMENT_TEXT), p.userId, this.clock.now(), meta.ip],
      );
      await writeAudit(tx, { actorId: p.userId, partnerId: ctx.partnerId, action: 'partner.agreement_accepted', after: { version }, ip: meta.ip, userAgent: meta.userAgent });
    });
  }

  async upload(p: Principal, ctx: TenantContext, type: KycType, file: UploadedFile | undefined, meta: RequestMeta) {
    const clean = await prepareUpload(file, this.scanner, `kyc/${ctx.partnerId}`);
    // The file is written before the transaction and removed if it rolls back (BUG-02).
    await this.store.put(clean.objectKey, clean.data);
    const queued = await this.db.withTenant(ctx, async (tx) => {
      const { rows } = await tx.query('SELECT kyc_status FROM partner');
      if (['submitted', 'approved'].includes(rows[0].kyc_status)) {
        throw new DomainError('KYC_LOCKED', 409, 'Your KYC is under review or already approved.');
      }
      const old = await tx.query('SELECT object_key, status FROM kyc_document WHERE type = $1', [type]);
      if (old.rows[0]?.status === 'approved') {
        throw new DomainError('KYC_DOCUMENT_APPROVED', 409, 'This document is already approved.');
      }
      await tx.query('DELETE FROM kyc_document WHERE type = $1', [type]);
      await tx.query(
        `INSERT INTO kyc_document (id, partner_id, type, object_key, file_name, mime, sha256, submitted_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [uuid(), ctx.partnerId, type, clean.objectKey, clean.fileName, clean.mime, clean.sha256, this.clock.now()],
      );
      await writeAudit(tx, { actorId: p.userId, partnerId: ctx.partnerId, action: 'kyc.document_uploaded', entity: 'kyc_document', after: { type }, ip: meta.ip, userAgent: meta.userAgent });
      const replaced = old.rows[0]?.object_key as string | undefined;
      return replaced ? [await this.outbox.deleteObject(tx, 'kyc.document_replaced', replaced)] : [];
    }).catch(async (err) => {
      await this.store.remove(clean.objectKey);
      throw err;
    });
    await this.outbox.deliver(queued);
  }

  async submit(p: Principal, ctx: TenantContext, meta: RequestMeta) {
    await this.db.withTenant(ctx, async (tx) => {
      if (!(await this.agreementAccepted(tx))) {
        throw new DomainError('AGREEMENT_REQUIRED', 409, 'Please accept the partner agreement first.');
      }
      const { rows } = await tx.query('SELECT type, status FROM kyc_document');
      if (!kycDocumentsReady(rows)) {
        throw new DomainError('KYC_INCOMPLETE', 422, 'Upload every required document first.');
      }
      const moved = await tx.query('SELECT partner_submit_kyc() AS ok');
      if (!moved.rows[0].ok) throw new DomainError('KYC_LOCKED', 409, 'Your KYC is under review or already approved.');
      await writeAudit(tx, { actorId: p.userId, partnerId: ctx.partnerId, action: 'kyc.submitted', ip: meta.ip, userAgent: meta.userAgent });
    });
  }

  /** Row-Level Security decides whether this id exists for the caller. */
  async documentLink(ctx: TenantContext, id: string) {
    const doc = await this.db.withTenant(ctx, async (tx) => {
      const { rows } = await tx.query(
        `SELECT object_key AS "objectKey", mime, file_name AS "fileName" FROM kyc_document WHERE id = $1`,
        [id],
      );
      return rows[0];
    });
    if (!doc) throw new DomainError('NOT_FOUND', 404, 'Document not found.');
    return { url: signFileLink(this.config, this.clock, doc) };
  }
}
