import { v7 as uuid } from 'uuid';
import type { Tx } from '../../../platform/db.js';

export interface CaseRow {
  id: string;
  case_no: string;
  partner_id: string;
  owner_user_id: string;
  status: string;
  relook_from: string | null;
  version: number;
}

/**
 * The one place a case's status changes, for partners and ops alike: every move bumps the
 * version and writes an append-only history row in the same transaction (§4.6).
 * `set` is a fixed SQL fragment from the caller, never built from request input.
 */
export async function moveCase(
  tx: Tx, c: CaseRow, to: string, actorId: string, now: Date,
  input: { reasonCode?: string; note?: string; relookFrom?: string | null; set?: string; values?: unknown[] } = {},
) {
  const extra = input.set ? `, ${input.set}` : '';
  await tx.query(
    `UPDATE loan_case SET status = $2, relook_from = $3, status_changed_at = $4, updated_at = $4, version = version + 1${extra} WHERE id = $1`,
    [c.id, to, input.relookFrom ?? null, now, ...(input.values ?? [])],
  );
  await tx.query(
    `INSERT INTO case_status_history (id, partner_id, case_id, from_status, to_status, actor_id, reason_code, note, at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [uuid(), c.partner_id, c.id, c.status, to, actorId, input.reasonCode ?? null, input.note ?? null, now],
  );
}
