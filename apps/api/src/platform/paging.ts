import { DomainError } from '@vittora/shared-kernel';

/**
 * Keyset paging shared by every list that can grow (STD-06, §14.6). The cursor is opaque to callers:
 * it holds the sort value and id of the last row, so pages stay stable while rows are added.
 * Queries select their sort column as text in `_sort`, which keeps Postgres' full precision.
 */
export interface Page {
  limit: number;
  after: { sort: string; id: string } | null;
}

export function readPage(q: { limit?: string; cursor?: string }, defaultLimit: number, maxLimit = 100): Page {
  const limit = q.limit === undefined ? defaultLimit : Number(q.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) {
    throw new DomainError('VALIDATION_FAILED', 422, `limit must be between 1 and ${maxLimit}.`, { limit: 'Out of range.' });
  }
  if (!q.cursor) return { limit, after: null };
  try {
    const [sort, id] = JSON.parse(Buffer.from(q.cursor, 'base64url').toString('utf8'));
    if (typeof sort === 'string' && typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id)) return { limit, after: { sort, id } };
  } catch {
    // Falls through to the error below.
  }
  throw new DomainError('VALIDATION_FAILED', 422, 'The cursor is not valid.', { cursor: 'Start again from the first page.' });
}

/** SQL for "after the cursor" on (sortColumn, id). Adds its two parameters to `params`. */
export function afterClause(page: Page, sortColumn: string, idColumn: string, params: unknown[], descending = false): string {
  if (!page.after) return 'TRUE';
  params.push(page.after.sort, page.after.id);
  const n = params.length;
  return `(${sortColumn}, ${idColumn}) ${descending ? '<' : '>'} ($${n - 1}::timestamptz, $${n}::uuid)`;
}

/** The LIMIT placeholder: one more row than the page, to know whether another page exists. */
export function limitParam(page: Page, params: unknown[]): string {
  params.push(page.limit + 1);
  return `$${params.length}`;
}

/** Trims the extra row and builds the next cursor from the last row kept. */
export function toPage<T extends { id: string; _sort: string }>(rows: T[], page: Page) {
  const more = rows.length > page.limit;
  const kept = rows.slice(0, page.limit);
  const last = kept[kept.length - 1];
  return {
    data: kept.map((row) => {
      const rest: Partial<T> = { ...row };
      delete rest._sort;
      return rest as Omit<T, '_sort'>;
    }),
    nextCursor: more && last ? Buffer.from(JSON.stringify([last._sort, last.id])).toString('base64url') : null,
  };
}
