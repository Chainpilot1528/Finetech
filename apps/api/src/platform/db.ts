import pg from 'pg';
import type { Config } from './config.js';

export type Tx = pg.PoolClient;

/** Proof that a caller has a tenant, taken from the session and never from request input (§14.8). */
export interface TenantContext {
  readonly partnerId: string;
}

export class Db {
  readonly authPool: pg.Pool;
  readonly appPool: pg.Pool;
  readonly opsPool: pg.Pool;

  constructor(config: Pick<Config, 'APP_DATABASE_URL' | 'AUTH_DATABASE_URL' | 'OPS_DATABASE_URL'>) {
    this.authPool = new pg.Pool({ connectionString: config.AUTH_DATABASE_URL, max: 10 });
    this.appPool = new pg.Pool({ connectionString: config.APP_DATABASE_URL, max: 20 });
    this.opsPool = new pg.Pool({ connectionString: config.OPS_DATABASE_URL, max: 5 });
  }

  /** Sign-in work only. Runs as vittora_auth, which can look up a user before a tenant is known. */
  async withAuth<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.inTransaction(this.authPool, fn);
  }

  /** Internal console only. Runs as vittora_ops, which sees across tenants but only what is granted. */
  async withOps<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.inTransaction(this.opsPool, fn);
  }

  /** Everything else. Runs as vittora_app with Row-Level Security bound to this tenant. */
  async withTenant<T>(ctx: TenantContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.inTransaction(this.appPool, async (tx) => {
      await tx.query(`SELECT set_config('app.partner_id', $1, true)`, [ctx.partnerId]);
      return fn(tx);
    });
  }

  async ping(): Promise<void> {
    await this.appPool.query('SELECT 1');
  }

  async close(): Promise<void> {
    await Promise.all([this.authPool.end(), this.appPool.end(), this.opsPool.end()]);
  }

  private async inTransaction<T>(pool: pg.Pool, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
