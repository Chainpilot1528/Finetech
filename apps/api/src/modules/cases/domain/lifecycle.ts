import { DomainError } from '@vittora/shared-kernel';

export type Actor = 'ops' | 'partner';

/** Cases that can still move. DISBURSED only leaves through a reversal, so it is not in this list. */
export const OPEN_STATUSES = ['REGISTERED', 'IN_REVIEW', 'APPROVED', 'CUSTOMER_APPROVED', 'DISBURSAL_IN_PROGRESS', 'RELOOK'];
export const TERMINAL_STATUSES = ['REVERSED', 'REJECTED', 'WITHDRAWN'];

const FORWARD: Record<string, string> = {
  REGISTERED: 'IN_REVIEW',
  IN_REVIEW: 'APPROVED',
  APPROVED: 'CUSTOMER_APPROVED',
  CUSTOMER_APPROVED: 'DISBURSAL_IN_PROGRESS',
};

/**
 * Where a case may go next (§4.6). DISBURSED and REVERSED aren't here because only recording
 * a final disbursal, or an approved reversal, can reach them.
 */
export function nextStatuses(from: string, actor: Actor, relookFrom: string | null): string[] {
  if (!OPEN_STATUSES.includes(from)) return [];
  if (actor === 'partner') {
    return from === 'RELOOK' && relookFrom ? [relookFrom, 'WITHDRAWN'] : ['WITHDRAWN'];
  }
  const forward = FORWARD[from];
  return [...(forward ? [forward] : []), ...(from === 'RELOOK' ? [] : ['RELOOK']), 'REJECTED', 'WITHDRAWN'];
}

export function assertTransition(from: string, to: string, actor: Actor, relookFrom: string | null) {
  if (!nextStatuses(from, actor, relookFrom).includes(to)) {
    throw new DomainError('INVALID_TRANSITION', 409, `A case can't move from ${from} to ${to}.`);
  }
}

/** Which bucket of the All Cases filter a status belongs to. */
export const BUCKETS: Record<string, string[]> = {
  needs_action: ['RELOOK'],
  active: ['REGISTERED', 'IN_REVIEW', 'APPROVED', 'CUSTOMER_APPROVED', 'DISBURSAL_IN_PROGRESS'],
  disbursed: ['DISBURSED'],
  rejected: ['REJECTED', 'WITHDRAWN', 'REVERSED'],
};

/** The five dashboard stages, each linking to the statuses it counts (§4.3). */
export const STAGES: { key: string; statuses: string[] }[] = [
  { key: 'registered', statuses: ['REGISTERED', 'RELOOK'] },
  { key: 'in_review', statuses: ['IN_REVIEW'] },
  { key: 'approved', statuses: ['APPROVED', 'CUSTOMER_APPROVED'] },
  { key: 'disbursing', statuses: ['DISBURSAL_IN_PROGRESS'] },
  { key: 'disbursed', statuses: ['DISBURSED'] },
];
