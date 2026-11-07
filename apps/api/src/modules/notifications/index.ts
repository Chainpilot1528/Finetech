import { Body, Controller, Get, HttpCode, Inject, Injectable, Patch, Post, Req } from '@nestjs/common';
import { type Clock } from '@vittora/shared-kernel';
import { v7 as uuid } from 'uuid';
import { z } from 'zod';
import type { Db, TenantContext, Tx } from '../../platform/db.js';
import { CLOCK, DB } from '../../platform/tokens.js';
import { type AuthedRequest, MAILER, type MailMessage, type Mailer, type Principal, Requires, parse, principalOf, tenantOf } from '../identity/index.js';

export const EVENTS = ['approval', 'rejection', 'pending_documentation', 'new_case', 'any_status'] as const;
export type NotificationEvent = (typeof EVENTS)[number];
type Prefs = Record<NotificationEvent, { email: boolean; inApp: boolean }>;

const DEFAULTS: Prefs = {
  approval: { email: true, inApp: true },
  rejection: { email: true, inApp: true },
  pending_documentation: { email: true, inApp: true },
  new_case: { email: true, inApp: true },
  any_status: { email: false, inApp: true },
};
const LABELS: Record<string, string> = {
  REGISTERED: 'Registered', IN_REVIEW: 'In Review', APPROVED: 'Approved', CUSTOMER_APPROVED: 'Customer Approved',
  DISBURSAL_IN_PROGRESS: 'Disbursal in Progress', DISBURSED: 'Disbursed', REVERSED: 'Reversed', RELOOK: 'Needs your action',
  REJECTED: 'Rejected', WITHDRAWN: 'Withdrawn',
};

const merge = (saved: Partial<Prefs> | undefined): Prefs =>
  Object.fromEntries(EVENTS.map((e) => [e, { ...DEFAULTS[e], ...saved?.[e] }])) as Prefs;

function eventsFor(status: string): NotificationEvent[] {
  const specific: Record<string, NotificationEvent> = {
    APPROVED: 'approval', REJECTED: 'rejection', RELOOK: 'pending_documentation', REGISTERED: 'new_case',
  };
  const event = specific[status];
  return event ? [event, 'any_status'] : ['any_status'];
}

export interface CaseChange {
  partnerId: string;
  caseId: string;
  caseNo: string;
  ownerId: string;
  status: string;
  actorId: string;
}

@Injectable()
export class NotificationsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(MAILER) private readonly mailer: Mailer,
  ) {}

  /**
   * Writes in-app rows in the caller's transaction, so a notification exists only if the change does.
   * Returns the emails to send once that transaction has committed. Payloads hold ids and codes only.
   */
  async caseChanged(tx: Tx, c: CaseChange): Promise<MailMessage[]> {
    const { rows } = await tx.query(
      `SELECT u.id, u.email, n.prefs FROM app_user u LEFT JOIN notification_pref n ON n.user_id = u.id
       WHERE u.partner_id = $1 AND u.status = 'active' AND u.id <> $3 AND (u.id = $2 OR u.role IN ('admin','manager'))`,
      [c.partnerId, c.ownerId, c.actorId],
    );
    const events = eventsFor(c.status);
    const label = LABELS[c.status] ?? c.status;
    const now = this.clock.now();
    const mail: MailMessage[] = [];
    for (const user of rows) {
      const prefs = merge(user.prefs);
      if (events.some((e) => prefs[e].inApp)) {
        await tx.query(
          `INSERT INTO notification (id, partner_id, user_id, type, payload, created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
          [uuid(), c.partnerId, user.id, events[0], JSON.stringify({ caseId: c.caseId, caseNo: c.caseNo, status: c.status }), now],
        );
      }
      if (events.some((e) => prefs[e].email)) {
        mail.push({ to: user.email, subject: `Case ${c.caseNo}: ${label}`, text: `Case ${c.caseNo} is now ${label}. Sign in to Vittora to see the details.` });
      }
    }
    return mail;
  }

  send(mail: MailMessage[]) {
    for (const m of mail) this.mailer.send(m).catch(() => undefined);
  }

  list(p: Principal, ctx: TenantContext) {
    return this.db.withTenant(ctx, async (tx) => {
      const { rows } = await tx.query(
        `SELECT id, type, payload, read_at AS "readAt", created_at AS "createdAt" FROM notification
         WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 50`,
        [p.userId],
      );
      const unread = await tx.query('SELECT count(*)::int AS n FROM notification WHERE user_id = $1 AND read_at IS NULL', [p.userId]);
      return { data: rows, unreadCount: unread.rows[0].n as number };
    });
  }

  async markRead(p: Principal, ctx: TenantContext, ids: string[] | undefined) {
    await this.db.withTenant(ctx, (tx) =>
      tx.query(
        `UPDATE notification SET read_at = $2 WHERE user_id = $1 AND read_at IS NULL AND ($3::uuid[] IS NULL OR id = ANY($3))`,
        [p.userId, this.clock.now(), ids ?? null],
      ),
    );
  }

  prefs(p: Principal, ctx: TenantContext) {
    return this.db.withTenant(ctx, async (tx) => {
      const { rows } = await tx.query('SELECT prefs FROM notification_pref WHERE user_id = $1', [p.userId]);
      return { prefs: merge(rows[0]?.prefs) };
    });
  }

  savePrefs(p: Principal, ctx: TenantContext, prefs: Partial<Prefs>) {
    return this.db.withTenant(ctx, async (tx) => {
      const merged = merge(prefs);
      await tx.query(
        `INSERT INTO notification_pref (user_id, partner_id, prefs, updated_at) VALUES ($1,$2,$3,$4)
         ON CONFLICT (user_id) DO UPDATE SET prefs = EXCLUDED.prefs, updated_at = EXCLUDED.updated_at`,
        [p.userId, ctx.partnerId, JSON.stringify(merged), this.clock.now()],
      );
      return { prefs: merged };
    });
  }
}

const channel = z.object({ email: z.boolean(), inApp: z.boolean() });
const PrefsBody = z.object({ prefs: z.object(Object.fromEntries(EVENTS.map((e) => [e, channel.optional()]))).strict() });
const ReadBody = z.object({ ids: z.array(z.string().uuid()).max(100).optional() });

@Controller()
export class NotificationsController {
  constructor(@Inject(NotificationsService) private readonly notifications: NotificationsService) {}

  @Requires('notifications.view')
  @Get('notifications')
  list(@Req() req: AuthedRequest) {
    return this.notifications.list(principalOf(req), tenantOf(req));
  }

  @Requires('notifications.view')
  @Post('notifications/read')
  @HttpCode(204)
  async read(@Body() body: unknown, @Req() req: AuthedRequest) {
    await this.notifications.markRead(principalOf(req), tenantOf(req), parse(ReadBody, body ?? {}).ids);
  }

  @Requires('notifications.view')
  @Get('partner/notification-prefs')
  prefs(@Req() req: AuthedRequest) {
    return this.notifications.prefs(principalOf(req), tenantOf(req));
  }

  @Requires('notifications.view')
  @Patch('partner/notification-prefs')
  save(@Body() body: unknown, @Req() req: AuthedRequest) {
    return this.notifications.savePrefs(principalOf(req), tenantOf(req), parse(PrefsBody, body).prefs as Partial<Prefs>);
  }
}
