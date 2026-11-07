import { Inject, Injectable } from '@nestjs/common';
import { type Clock, DomainError, type PartnerRole } from '@vittora/shared-kernel';
import { v7 as uuid } from 'uuid';
import type { Config } from '../../../platform/config.js';
import { randomToken, sha256 } from '../../../platform/crypto.js';
import type { Db, TenantContext, Tx } from '../../../platform/db.js';
import { writeAudit } from '../../audit/index.js';
import { CLOCK, CONFIG, DB, MAILER, type Mailer } from '../ports/index.js';
import type { Principal, RequestMeta } from './auth.service.js';

const COLUMNS = `id, name, email, phone, role, status, mfa_enabled AS "mfaEnabled",
  last_login_at AS "lastLoginAt", created_at AS "createdAt"`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INVITE_TTL_MS = 7 * 86_400_000;
const CLOSED = ['DISBURSED', 'REVERSED', 'REJECTED', 'WITHDRAWN'];

const notFound = () => new DomainError('USER_NOT_FOUND', 404, 'User not found.');

/** Reads go through Row-Level Security, so another tenant's rows simply don't exist here. */
@Injectable()
export class UsersService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(MAILER) private readonly mailer: Mailer,
  ) {}

  list(ctx: TenantContext) {
    return this.db.withTenant(ctx, async (tx) => {
      const { rows } = await tx.query(`SELECT ${COLUMNS} FROM app_user ORDER BY created_at, id LIMIT 100`);
      return rows;
    });
  }

  async get(ctx: TenantContext, id: string) {
    if (!UUID.test(id)) throw notFound();
    const row = await this.db.withTenant(ctx, async (tx) => {
      const { rows } = await tx.query(`SELECT ${COLUMNS} FROM app_user WHERE id = $1`, [id]);
      return rows[0];
    });
    if (!row) throw notFound();
    return row;
  }

  private async lockUser(tx: Tx, id: string) {
    const { rows } = await tx.query('SELECT id, role, status FROM app_user WHERE id = $1 FOR UPDATE', [id]);
    if (!rows[0]) throw notFound();
    return rows[0] as { id: string; role: string; status: string };
  }

  /** An organisation must always keep someone who can manage it. */
  private async assertNotLastAdmin(tx: Tx, user: { id: string; role: string }) {
    if (user.role !== 'admin') return;
    const { rows } = await tx.query(`SELECT id FROM app_user WHERE role = 'admin' AND status = 'active' AND id <> $1 FOR UPDATE`, [user.id]);
    if (!rows.length) throw new DomainError('LAST_ADMIN', 409, 'Your organisation needs at least one active Admin.');
  }

  private async setupToken(tx: Tx, userId: string) {
    const now = this.clock.now();
    const token = randomToken();
    const { rows } = await tx.query('SELECT partner_user_setup_token($1,$2,$3,$4,$5) AS ok', [uuid(), userId, sha256(token), new Date(now.getTime() + INVITE_TTL_MS), now]);
    if (!rows[0].ok) throw new DomainError('USER_NOT_INVITED', 409, 'This person has already accepted their invite.');
    return `${this.config.WEB_ORIGIN}/reset-password?token=${token}`;
  }

  private sendInvite(to: string, link: string) {
    this.mailer.send({ to, subject: 'You have been invited to Vittora', text: `Set your password to join your team. The link works once and expires in 7 days.\n\n${link}` }).catch(() => undefined);
  }

  /** The Admin never sets a password. The person chooses their own through the link (§4.9). */
  async invite(p: Principal, ctx: TenantContext, input: { name: string; email: string; phone?: string; role: PartnerRole }, meta: RequestMeta) {
    const id = uuid();
    const link = await this.db.withTenant(ctx, async (tx) => {
      try {
        await tx.query(
          `INSERT INTO app_user (id, partner_id, name, email, phone, role, status, created_by) VALUES ($1,$2,$3,$4,$5,$6,'invited',$7)`,
          [id, ctx.partnerId, input.name, input.email, input.phone ?? null, input.role, p.userId],
        );
      } catch (err) {
        if ((err as { code?: string }).code === '23505') throw new DomainError('EMAIL_UNAVAILABLE', 409, 'This email can not be used. Try a different one.');
        throw err;
      }
      await writeAudit(tx, { actorId: p.userId, partnerId: ctx.partnerId, action: 'user.invited', entity: 'user', entityId: id, after: { role: input.role }, ip: meta.ip, userAgent: meta.userAgent });
      return this.setupToken(tx, id);
    });
    this.sendInvite(input.email, link);
    return this.get(ctx, id);
  }

  async resendInvite(p: Principal, ctx: TenantContext, id: string, meta: RequestMeta) {
    const { link, email } = await this.db.withTenant(ctx, async (tx) => {
      const { rows } = await tx.query('SELECT email FROM app_user WHERE id = $1', [id]);
      if (!rows[0]) throw notFound();
      const issued = await this.setupToken(tx, id);
      await writeAudit(tx, { actorId: p.userId, partnerId: ctx.partnerId, action: 'user.invite_resent', entity: 'user', entityId: id, ip: meta.ip, userAgent: meta.userAgent });
      return { link: issued, email: rows[0].email as string };
    });
    this.sendInvite(email, link);
  }

  async update(p: Principal, ctx: TenantContext, id: string, input: { name?: string; phone?: string | null; role?: PartnerRole }, meta: RequestMeta) {
    await this.db.withTenant(ctx, async (tx) => {
      const user = await this.lockUser(tx, id);
      const roleChanged = input.role !== undefined && input.role !== user.role;
      if (roleChanged && user.role === 'admin') await this.assertNotLastAdmin(tx, user);
      await tx.query(
        `UPDATE app_user SET name = COALESCE($2, name), phone = CASE WHEN $3 THEN $4 ELSE phone END, role = COALESCE($5, role) WHERE id = $1`,
        [id, input.name ?? null, input.phone !== undefined, input.phone ?? null, input.role ?? null],
      );
      // A new role can need two-step sign-in, so they start again from the sign-in page.
      if (roleChanged) await tx.query('SELECT partner_user_sign_out($1,$2)', [id, this.clock.now()]);
      await writeAudit(tx, { actorId: p.userId, partnerId: ctx.partnerId, action: 'user.updated', entity: 'user', entityId: id, after: { role: input.role ?? user.role }, ip: meta.ip, userAgent: meta.userAgent });
    });
    return this.get(ctx, id);
  }

  async deactivate(p: Principal, ctx: TenantContext, id: string, reassignTo: string | undefined, meta: RequestMeta) {
    if (id === p.userId) throw new DomainError('CANNOT_DEACTIVATE_SELF', 409, 'You can not deactivate your own account.');
    await this.db.withTenant(ctx, async (tx) => {
      const user = await this.lockUser(tx, id);
      if (user.status === 'inactive') return;
      await this.assertNotLastAdmin(tx, user);
      const open = await tx.query('SELECT count(*)::int AS n FROM loan_case WHERE owner_user_id = $1 AND NOT (status = ANY($2))', [id, CLOSED]);
      const count = open.rows[0].n as number;
      if (count > 0) {
        if (!reassignTo) throw new DomainError('REASSIGN_REQUIRED', 409, `This person has ${count} open cases. Choose who takes them over.`);
        const target = await tx.query(`SELECT 1 FROM app_user WHERE id = $1 AND id <> $2 AND status = 'active' AND role <> 'viewer'`, [reassignTo, id]);
        if (!target.rowCount) throw new DomainError('REASSIGN_INVALID', 422, 'Choose an active team member who can work on cases.');
        await tx.query('UPDATE loan_case SET owner_user_id = $2, updated_at = $4 WHERE owner_user_id = $1 AND NOT (status = ANY($3))', [id, reassignTo, CLOSED, this.clock.now()]);
      }
      await tx.query(`UPDATE app_user SET status = 'inactive' WHERE id = $1`, [id]);
      await tx.query('SELECT partner_user_sign_out($1,$2)', [id, this.clock.now()]);
      await writeAudit(tx, { actorId: p.userId, partnerId: ctx.partnerId, action: 'user.deactivated', entity: 'user', entityId: id, after: { casesMoved: count }, ip: meta.ip, userAgent: meta.userAgent });
    });
  }

  async reactivate(p: Principal, ctx: TenantContext, id: string, meta: RequestMeta) {
    await this.db.withTenant(ctx, async (tx) => {
      const user = await this.lockUser(tx, id);
      if (user.status !== 'inactive') throw new DomainError('USER_NOT_INACTIVE', 409, 'This user is not deactivated.');
      await tx.query(`UPDATE app_user SET status = 'active' WHERE id = $1`, [id]);
      await writeAudit(tx, { actorId: p.userId, partnerId: ctx.partnerId, action: 'user.reactivated', entity: 'user', entityId: id, ip: meta.ip, userAgent: meta.userAgent });
    });
  }

  async signOut(p: Principal, ctx: TenantContext, id: string, meta: RequestMeta) {
    await this.db.withTenant(ctx, async (tx) => {
      await this.lockUser(tx, id);
      await tx.query('SELECT partner_user_sign_out($1,$2)', [id, this.clock.now()]);
      await writeAudit(tx, { actorId: p.userId, partnerId: ctx.partnerId, action: 'user.signed_out_by_admin', entity: 'user', entityId: id, ip: meta.ip, userAgent: meta.userAgent });
    });
  }
}
