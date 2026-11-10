import { DomainError } from '@vittora/shared-kernel';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function checkId(id: string) {
  if (!UUID.test(id)) throw new DomainError('NOT_FOUND', 404, 'Not found.');
  return id;
}

export function idempotencyKey(key: string | undefined) {
  if (!key || key.length < 8 || key.length > 100) {
    throw new DomainError('IDEMPOTENCY_KEY_REQUIRED', 400, 'An Idempotency-Key header is required.');
  }
  return key;
}

/** Optimistic concurrency on transitions (§6.2): the caller says which version it was looking at. */
export function ifMatch(header: string | undefined): number {
  const version = Number(header?.replaceAll('"', ''));
  if (!header || !Number.isInteger(version)) {
    throw new DomainError('VERSION_REQUIRED', 428, 'An If-Match header with the record version is required.');
  }
  return version;
}

/** Month boundaries as local dates; SQL applies Asia/Kolkata to them (§5). */
export function monthBounds(month: string): [string, string] {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return [`${month}-01`, `${next}-01`];
}

export const IST_START = (param: string) => `(${param}::timestamp AT TIME ZONE 'Asia/Kolkata')`;
