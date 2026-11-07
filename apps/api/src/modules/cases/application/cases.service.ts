import { randomInt } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  CONSENT_TEXT, CONSENT_TEXT_VERSION, type DraftData, PRODUCTS, documentsFor, validateAll, validateStep,
} from '@vittora/product-schemas';
import { type Clock, DomainError } from '@vittora/shared-kernel';
import { v7 as uuid } from 'uuid';
import type { Config } from '../../../platform/config.js';
import { decrypt, encrypt, hmac, randomToken, sha256 } from '../../../platform/crypto.js';
import type { Db, TenantContext, Tx } from '../../../platform/db.js';
import { type DocumentStore, type Scanner, type UploadedFile, prepareUpload } from '../../../platform/storage.js';
import { CLOCK, CONFIG, DB, DOCUMENT_STORE, SCANNER } from '../../../platform/tokens.js';
import { writeAudit } from '../../audit/index.js';
import { MAILER, type Mailer, type Principal, type RequestMeta } from '../../identity/index.js';
import { NotificationsService } from '../../notifications/index.js';

const SECTIONS = ['setup', 'applicant', 'details', 'loan', 'income', 'documents'] as const;
const CONSENT_TTL_MS = 48 * 3_600_000;
const CASE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

interface DraftRow {
  id: string;
  version: number;
  status: string;
  data_enc: string;
}

@Injectable()
export class CasesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(DOCUMENT_STORE) private readonly store: DocumentStore,
    @Inject(SCANNER) private readonly scanner: Scanner,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
  ) {}

  private blind(kind: string, value: string) {
    return hmac(this.config.HMAC_KEY, `${kind}:${value}`);
  }
  private seal(data: DraftData) {
    return encrypt(this.config.ENCRYPTION_KEY, JSON.stringify(data));
  }
  private open(row: DraftRow): DraftData {
    return JSON.parse(decrypt(this.config.ENCRYPTION_KEY, row.data_enc));
  }

  private async requireApprovedKyc(tx: Tx) {
    const { rows } = await tx.query('SELECT kyc_status FROM partner');
    if (rows[0]?.kyc_status !== 'approved') {
      throw new DomainError('KYC_NOT_APPROVED', 403, 'Your KYC must be approved before you can create cases.');
    }
  }

  /** Drafts belong to the person who started them, so Executives never see each other's. */
  private async loadDraft(tx: Tx, p: Principal, id: string, lock = false): Promise<DraftRow> {
    const { rows } = await tx.query(
      `SELECT id, version, status, data_enc FROM case_draft WHERE id = $1 AND created_by = $2 ${lock ? 'FOR UPDATE' : ''}`,
      [id, p.userId],
    );
    if (!rows[0]) throw new DomainError('NOT_FOUND', 404, 'Draft not found.');
    return rows[0];
  }

  private async enabledProducts(tx: Tx): Promise<string[]> {
    const { rows } = await tx.query(
      `SELECT pp.product_code AS code FROM partner_product pp JOIN product p ON p.code = pp.product_code WHERE p.active`,
    );
    return rows.map((r) => r.code);
  }

  async catalogue(ctx: TenantContext) {
    return this.db.withTenant(ctx, async (tx) => {
      const codes = await this.enabledProducts(tx);
      return codes.filter((c) => PRODUCTS[c]).map((c) => ({ code: c, name: PRODUCTS[c]!.name }));
    });
  }

  async lenders(ctx: TenantContext, product: string) {
    return this.db.withTenant(ctx, async (tx) => {
      const { rows } = await tx.query(
        `SELECT l.id, l.name, l.type FROM lender l JOIN lender_product lp ON lp.lender_id = l.id
         WHERE lp.product_code = $1 AND l.active AND lp.active ORDER BY l.name`,
        [product],
      );
      return rows;
    });
  }

  private async view(tx: Tx, row: DraftRow) {
    const data = this.open(row);
    const docs = await tx.query(`SELECT doc_type AS "docType", file_name AS "fileName" FROM case_document WHERE draft_id = $1`, [row.id]);
    const product = PRODUCTS[data.setup?.product ?? ''];
    return {
      id: row.id,
      version: row.version,
      status: row.status,
      data,
      documents: docs.rows,
      requiredDocuments: product ? documentsFor(product, data.setup?.loanType, data.income?.employmentType) : [],
      consent: await this.consentState(tx, row.id, data),
    };
  }

  private async consentState(tx: Tx, draftId: string, data: DraftData): Promise<'none' | 'sent' | 'given'> {
    const { rows } = await tx.query(
      `SELECT recipient_hash, pan_hash, expires_at, consented_at FROM customer_consent
       WHERE draft_id = $1 AND purpose = 'processing' AND superseded_at IS NULL ORDER BY created_at DESC LIMIT 1`,
      [draftId],
    );
    const c = rows[0];
    if (!c) return 'none';
    // Consent covers the person it was given by. Changing their PAN or phone needs a fresh consent.
    const same = c.recipient_hash === this.blind('phone', data.applicant?.phone ?? '') && c.pan_hash === this.blind('pan', data.applicant?.pan ?? '');
    if (!same) return 'none';
    if (c.consented_at) return 'given';
    return c.expires_at > this.clock.now() ? 'sent' : 'none';
  }

  async createDraft(p: Principal, ctx: TenantContext, key: string, meta: RequestMeta) {
    const now = this.clock.now();
    return this.db.withTenant(ctx, async (tx) => {
      await this.requireApprovedKyc(tx);
      const id = uuid();
      const inserted = await tx.query(
        `INSERT INTO case_draft (id, partner_id, created_by, idempotency_key, data_enc, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$6) ON CONFLICT (partner_id, created_by, idempotency_key) DO NOTHING`,
        [id, ctx.partnerId, p.userId, key, this.seal({}), now],
      );
      if (inserted.rowCount) {
        await writeAudit(tx, { actorId: p.userId, partnerId: ctx.partnerId, action: 'case.draft_created', entity: 'case_draft', entityId: id, ip: meta.ip, userAgent: meta.userAgent });
      }
      const { rows } = await tx.query(
        `SELECT id, version, status, data_enc FROM case_draft WHERE created_by = $1 AND idempotency_key = $2`,
        [p.userId, key],
      );
      return this.view(tx, rows[0]);
    });
  }

  listDrafts(p: Principal, ctx: TenantContext) {
    return this.db.withTenant(ctx, async (tx) => {
      const { rows } = await tx.query(
        `SELECT id, product, updated_at AS "updatedAt" FROM case_draft
         WHERE created_by = $1 AND status = 'open' ORDER BY updated_at DESC LIMIT 20`,
        [p.userId],
      );
      return rows;
    });
  }

  getDraft(p: Principal, ctx: TenantContext, id: string) {
    return this.db.withTenant(ctx, async (tx) => this.view(tx, await this.loadDraft(tx, p, id)));
  }

  async patchDraft(p: Principal, ctx: TenantContext, id: string, version: number, changes: DraftData) {
    // A draft must never hold a full Aadhaar number, even half-typed or encrypted.
    const last4 = changes.applicant?.aadhaarLast4;
    if (last4 !== undefined && !/^[0-9]{0,4}$/.test(last4)) {
      throw new DomainError('VALIDATION_FAILED', 422, 'Enter only the last 4 digits of Aadhaar.', { aadhaarLast4: 'Enter only the last 4 digits.' });
    }
    return this.db.withTenant(ctx, async (tx) => {
      const row = await this.loadDraft(tx, p, id, true);
      if (row.status !== 'open') throw new DomainError('DRAFT_SUBMITTED', 409, 'This draft was already submitted.');
      if (row.version !== version) throw new DomainError('VERSION_CONFLICT', 409, 'This draft changed elsewhere. Reload and try again.');
      const data = this.open(row);
      const before = data.setup?.product;
      for (const section of SECTIONS) {
        if (changes[section] !== undefined) Object.assign(data, { [section]: { ...data[section], ...changes[section] } });
      }
      if (data.applicant?.pan) data.applicant.pan = data.applicant.pan.toUpperCase();
      if (before && data.setup?.product !== before) {
        // Details and product documents belong to the old product (§4.4).
        delete data.details;
        const product = PRODUCTS[data.setup?.product ?? ''];
        const keep = product ? documentsFor(product, data.setup?.loanType, data.income?.employmentType).map((d) => d.code) : [];
        const removed = await tx.query('DELETE FROM case_document WHERE draft_id = $1 AND NOT (doc_type = ANY($2)) RETURNING object_key', [id, keep]);
        for (const r of removed.rows) await this.store.remove(r.object_key);
      }
      const updated = await tx.query(
        `UPDATE case_draft SET data_enc = $2, product = $3, version = version + 1, updated_at = $4 WHERE id = $1
         RETURNING id, version, status, data_enc`,
        [id, this.seal(data), data.setup?.product ?? null, this.clock.now()],
      );
      return this.view(tx, updated.rows[0]);
    });
  }

  async uploadDocument(p: Principal, ctx: TenantContext, id: string, docType: string, file: UploadedFile | undefined, meta: RequestMeta) {
    const clean = await prepareUpload(file, this.scanner, `cases/${ctx.partnerId}/${id}`);
    const replaced = await this.db.withTenant(ctx, async (tx) => {
      const row = await this.loadDraft(tx, p, id, true);
      if (row.status !== 'open') throw new DomainError('DRAFT_SUBMITTED', 409, 'This draft was already submitted.');
      const data = this.open(row);
      const product = PRODUCTS[data.setup?.product ?? ''];
      const allowed = product ? documentsFor(product, data.setup?.loanType, data.income?.employmentType) : [];
      if (!allowed.some((d) => d.code === docType)) {
        throw new DomainError('DOCUMENT_NOT_NEEDED', 422, 'This document is not part of this case.');
      }
      const old = await tx.query('DELETE FROM case_document WHERE draft_id = $1 AND doc_type = $2 RETURNING object_key', [id, docType]);
      await tx.query(
        `INSERT INTO case_document (id, partner_id, draft_id, doc_type, object_key, file_name, mime, sha256, uploaded_by, at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [uuid(), ctx.partnerId, id, docType, clean.objectKey, clean.fileName, clean.mime, clean.sha256, p.userId, this.clock.now()],
      );
      await this.store.put(clean.objectKey, clean.data);
      await writeAudit(tx, { actorId: p.userId, partnerId: ctx.partnerId, action: 'case.document_uploaded', entity: 'case_draft', entityId: id, after: { docType }, ip: meta.ip, userAgent: meta.userAgent });
      return old.rows[0]?.object_key as string | undefined;
    });
    if (replaced) await this.store.remove(replaced);
  }

  async requestConsent(p: Principal, ctx: TenantContext, id: string, meta: RequestMeta) {
    const now = this.clock.now();
    const token = randomToken();
    const message = await this.db.withTenant(ctx, async (tx) => {
      const row = await this.loadDraft(tx, p, id, true);
      if (row.status !== 'open') throw new DomainError('DRAFT_SUBMITTED', 409, 'This draft was already submitted.');
      const data = this.open(row);
      const today = this.clock.now();
      const errors = { ...validateStep('setup', data, today), ...validateStep('applicant', data, today) };
      if (Object.keys(errors).length) throw new DomainError('VALIDATION_FAILED', 422, 'Finish the customer details first.', errors);
      const lender = await tx.query('SELECT name FROM lender WHERE id = $1', [data.setup!.lenderId]);
      if (!lender.rowCount) throw new DomainError('LENDER_NOT_AVAILABLE', 422, 'Choose a lender from the list.');
      await tx.query(
        `UPDATE customer_consent SET superseded_at = $2 WHERE draft_id = $1 AND superseded_at IS NULL AND consented_at IS NULL`,
        [id, now],
      );
      await tx.query(
        `INSERT INTO customer_consent (id, partner_id, draft_id, purpose, text_version, channel, lender_name,
           recipient_hash, pan_hash, token_hash, expires_at, created_at)
         VALUES ($1,$2,$3,'processing',$4,'link',$5,$6,$7,$8,$9,$10)`,
        [uuid(), ctx.partnerId, id, CONSENT_TEXT_VERSION, lender.rows[0].name,
         this.blind('phone', data.applicant!.phone!), this.blind('pan', data.applicant!.pan!), sha256(token),
         new Date(now.getTime() + CONSENT_TTL_MS), now],
      );
      await writeAudit(tx, { actorId: p.userId, partnerId: ctx.partnerId, action: 'consent.requested', entity: 'case_draft', entityId: id, ip: meta.ip, userAgent: meta.userAgent });
      const { applicant } = data;
      return {
        to: applicant!.email || `sms:+91${applicant!.phone}`,
        subject: 'Please confirm your loan application',
        text: `Your loan partner needs your consent to process your application. Open this link within 48 hours:\n\n${this.config.WEB_ORIGIN}/consent/${token}`,
      };
    });
    this.mailer.send(message).catch(() => undefined);
    return { sent: true };
  }

  /** Public. Shows no customer details, so a forwarded link reveals nothing about them. */
  async consentPage(token: string) {
    return this.db.withAuth(async (tx) => {
      const c = await this.findConsent(tx, token);
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

  private async findConsent(tx: Tx, token: string) {
    const { rows } = await tx.query(
      'SELECT * FROM customer_consent WHERE token_hash = $1 AND superseded_at IS NULL',
      [sha256(token)],
    );
    const c = rows[0];
    if (!c || (!c.consented_at && c.expires_at <= this.clock.now())) {
      throw new DomainError('TOKEN_INVALID', 400, 'This link has expired. Ask your loan partner for a new one.');
    }
    return c;
  }

  async giveConsent(token: string, meta: RequestMeta) {
    await this.db.withAuth(async (tx) => {
      const c = await this.findConsent(tx, token);
      if (c.consented_at) return;
      await tx.query(
        'UPDATE customer_consent SET consented_at = $2, customer_ip = $3, user_agent = $4 WHERE id = $1',
        [c.id, this.clock.now(), meta.ip, meta.userAgent],
      );
      await writeAudit(tx, { partnerId: c.partner_id, action: 'consent.given', entity: 'case_draft', entityId: c.draft_id, ip: meta.ip, userAgent: meta.userAgent });
    });
  }

  private newCaseNo(now: Date) {
    const stamp = now.toISOString().slice(2, 10).replaceAll('-', '');
    const tail = Array.from({ length: 6 }, () => CASE_ALPHABET[randomInt(CASE_ALPHABET.length)]).join('');
    return `CASE-${stamp}-${tail}`;
  }

  async submit(p: Principal, ctx: TenantContext, id: string, confirmDuplicate: boolean, meta: RequestMeta) {
    const now = this.clock.now();
    const { mail, ...created } = await this.db.withTenant(ctx, async (tx) => {
      const row = await this.loadDraft(tx, p, id, true);
      if (row.status === 'submitted') {
        // Replays return the original result, so a double click can't make two cases.
        const { rows } = await tx.query(`SELECT id, case_no AS "caseNo", status FROM loan_case WHERE source_draft_id = $1`, [id]);
        return { ...rows[0], mail: [] };
      }
      await this.requireApprovedKyc(tx);
      const data = this.open(row);
      const errors = validateAll(data, now);
      if (Object.keys(errors).length) throw new DomainError('VALIDATION_FAILED', 422, 'Some details are missing.', errors);

      const { setup, applicant, details, loan, income } = data as Required<DraftData>;
      const product = PRODUCTS[setup.product!]!;
      if (!(await this.enabledProducts(tx)).includes(product.code)) {
        throw new DomainError('PRODUCT_NOT_ENABLED', 403, 'This product is not enabled for your account.');
      }
      const offered = await tx.query(
        `SELECT 1 FROM lender_product lp JOIN lender l ON l.id = lp.lender_id
         WHERE lp.lender_id = $1 AND lp.product_code = $2 AND lp.active AND l.active`,
        [setup.lenderId, product.code],
      );
      if (!offered.rowCount) throw new DomainError('LENDER_NOT_AVAILABLE', 422, 'This lender does not offer this product.');

      const docs = await tx.query('SELECT doc_type FROM case_document WHERE draft_id = $1', [id]);
      const uploaded = new Set(docs.rows.map((d) => d.doc_type));
      const missing = documentsFor(product, setup.loanType, income.employmentType).filter((d) => d.required && !uploaded.has(d.code));
      if (missing.length) {
        throw new DomainError('DOCUMENTS_MISSING', 422, 'Upload every required document.', Object.fromEntries(missing.map((d) => [d.code, 'This document is required.'])));
      }
      if ((await this.consentState(tx, id, data)) !== 'given') {
        throw new DomainError('CONSENT_REQUIRED', 409, 'The customer has not given consent yet.');
      }

      const panHash = this.blind('pan', applicant.pan!);
      const collateral = product.collateralField ? String(details?.[product.collateralField] ?? '') : '';
      const collateralHash = collateral ? this.blind('collateral', collateral) : null;
      const same = await tx.query(
        `SELECT 1 FROM loan_case c JOIN applicant a ON a.id = c.applicant_id
         WHERE a.pan_hash = $1 AND c.product = $2 AND ($3::text IS NULL OR c.collateral_key_hash = $3)
           AND c.status NOT IN ('REJECTED','WITHDRAWN','REVERSED','DISBURSED')`,
        [panHash, product.code, collateralHash],
      );
      if (same.rowCount && !confirmDuplicate) {
        throw new DomainError('DUPLICATE_CASE', 409, 'You already have an open case for this customer and product.');
      }
      const elsewhere = await tx.query('SELECT case_duplicate_elsewhere($1,$2,$3,$4) AS found', [panHash, product.code, collateralHash, ctx.partnerId]);

      const key = this.config.ENCRYPTION_KEY;
      const applicantId = uuid();
      await tx.query(
        `INSERT INTO applicant (id, partner_id, full_name_enc, phone_enc, phone_hash, email_enc, pan_enc, pan_hash,
           aadhaar_last4, dob_enc, address_enc, pincode, city, state, phone_last4)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [applicantId, ctx.partnerId, encrypt(key, applicant.fullName!), encrypt(key, applicant.phone!),
         this.blind('phone', applicant.phone!), applicant.email ? encrypt(key, applicant.email) : null,
         encrypt(key, applicant.pan!), panHash, applicant.aadhaarLast4, encrypt(key, applicant.dob!),
         encrypt(key, applicant.address!), applicant.pincode, applicant.city, applicant.state, applicant.phone!.slice(-4)],
      );
      const caseId = uuid();
      const caseNo = this.newCaseNo(now);
      await tx.query(
        `INSERT INTO loan_case (id, case_no, partner_id, created_by_user_id, source_draft_id, case_type, product,
           details_schema_version, loan_type, preferred_lender_id, applicant_id, loan_amount_paise, tenure_months, purpose,
           employment_type, monthly_income_paise, existing_emi_paise, company_name, work_experience_years, bureau_score,
           product_details, collateral_key_hash, possible_duplicate, created_at, updated_at, owner_user_id, status_changed_at)
         VALUES ($1,$2,$3,$4,$5,'open_market',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$23,$4,$23)`,
        [caseId, caseNo, ctx.partnerId, p.userId, id, product.code, product.version, setup.loanType, setup.lenderId,
         applicantId, BigInt(loan.amount!) * 100n, loan.tenureMonths, loan.purpose ?? null, income.employmentType,
         BigInt(income.monthlyIncome!) * 100n, BigInt(income.existingEmi ?? 0) * 100n, income.companyName ?? null,
         income.workExperienceYears ?? null, income.cibilScore ?? null, JSON.stringify(details ?? {}), collateralHash,
         elsewhere.rows[0].found, now],
      );
      await tx.query(
        `INSERT INTO case_status_history (id, partner_id, case_id, to_status, actor_id, at) VALUES ($1,$2,$3,'REGISTERED',$4,$5)`,
        [uuid(), ctx.partnerId, caseId, p.userId, now],
      );
      await tx.query('UPDATE case_document SET case_id = $2 WHERE draft_id = $1', [id, caseId]);
      await tx.query('UPDATE customer_consent SET case_id = $2 WHERE draft_id = $1 AND consented_at IS NOT NULL', [id, caseId]);
      // The encrypted fields above now hold the data, so the draft copy goes.
      await tx.query(`UPDATE case_draft SET status = 'submitted', data_enc = $2, updated_at = $3 WHERE id = $1`, [id, this.seal({}), now]);
      await writeAudit(tx, { actorId: p.userId, partnerId: ctx.partnerId, action: 'case.registered', entity: 'case', entityId: caseId, after: { product: product.code }, ip: meta.ip, userAgent: meta.userAgent });
      const mail = await this.notifications.caseChanged(tx, { partnerId: ctx.partnerId, caseId, caseNo, ownerId: p.userId, status: 'REGISTERED', actorId: p.userId });
      return { id: caseId, caseNo, status: 'REGISTERED', mail };
    });
    this.notifications.send(mail);
    return created;
  }
}
