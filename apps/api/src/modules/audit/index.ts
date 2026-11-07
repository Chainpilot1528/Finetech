import { v7 as uuid } from 'uuid';
import type { Tx } from '../../platform/db.js';

export interface AuditEvent {
  actorId?: string | null;
  partnerId?: string | null;
  action: string;
  entity?: string;
  entityId?: string;
  ip?: string | null;
  userAgent?: string | null;
  reason?: string;
  /** Ids and codes only. Never names, emails, phones or tokens (§9.5). */
  after?: Record<string, string | number | boolean | null>;
}

/** Writes in the caller's transaction, so the action and its audit row commit together. */
export async function writeAudit(tx: Tx, e: AuditEvent): Promise<void> {
  await tx.query(
    `INSERT INTO audit_log (id, actor_id, partner_id, action, entity, entity_id, ip, user_agent, reason, after)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      uuid(), e.actorId ?? null, e.partnerId ?? null, e.action, e.entity ?? null, e.entityId ?? null,
      e.ip ?? null, e.userAgent ?? null, e.reason ?? null, e.after ? JSON.stringify(e.after) : null,
    ],
  );
}
