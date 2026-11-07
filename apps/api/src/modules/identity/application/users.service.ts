import { Inject, Injectable } from '@nestjs/common';
import { DomainError } from '@vittora/shared-kernel';
import type { Db, TenantContext } from '../../../platform/db.js';
import { DB } from '../ports/index.js';

const COLUMNS = `id, name, email, phone, role, status, mfa_enabled AS "mfaEnabled",
  last_login_at AS "lastLoginAt", created_at AS "createdAt"`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Reads go through Row-Level Security, so another tenant's rows simply don't exist here. */
@Injectable()
export class UsersService {
  constructor(@Inject(DB) private readonly db: Db) {}

  list(ctx: TenantContext) {
    return this.db.withTenant(ctx, async (tx) => {
      const { rows } = await tx.query(`SELECT ${COLUMNS} FROM app_user ORDER BY created_at, id LIMIT 100`);
      return rows;
    });
  }

  async get(ctx: TenantContext, id: string) {
    const notFound = new DomainError('USER_NOT_FOUND', 404, 'User not found.');
    if (!UUID.test(id)) throw notFound;
    const row = await this.db.withTenant(ctx, async (tx) => {
      const { rows } = await tx.query(`SELECT ${COLUMNS} FROM app_user WHERE id = $1`, [id]);
      return rows[0];
    });
    if (!row) throw notFound;
    return row;
  }
}
