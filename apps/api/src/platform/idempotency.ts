import { type CallHandler, type ExecutionContext, Inject, Injectable, type NestInterceptor } from '@nestjs/common';
import { type Clock, DomainError } from '@vittora/shared-kernel';
import type { Request, Response } from 'express';
import { type Observable, from, lastValueFrom } from 'rxjs';
import type { Principal } from '../modules/identity/application/auth.service.js';
import type { Config } from './config.js';
import { decrypt, encrypt, sha256 } from './crypto.js';
import type { Db, Tx } from './db.js';
import { CLOCK, CONFIG, DB } from './tokens.js';

const KEY = /^[\w-]{8,100}$/;

/**
 * One idempotency layer for every signed-in POST (STD-08, §6.2). When a request carries an
 * Idempotency-Key, a repeat with the same key and body gets the first response back; the same key
 * with a different body is refused. Uploads (multipart) are left to their own replace-on-repeat rules.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request & { principal?: Principal }>();
    const res = context.switchToHttp().getResponse<Response>();
    const key = req.header('idempotency-key');
    const p = req.principal;
    if (req.method !== 'POST' || !key || !p || req.is('multipart/form-data')) return next.handle();
    if (!KEY.test(key)) throw new DomainError('IDEMPOTENCY_KEY_INVALID', 400, 'The Idempotency-Key header is not valid.');

    const scope = `${req.method} ${req.baseUrl}${req.path}`;
    const hash = sha256(JSON.stringify(req.body ?? null));
    const run = <T>(fn: (tx: Tx) => Promise<T>) => (p.partnerId ? this.db.withTenant({ partnerId: p.partnerId }, fn) : this.db.withOps(fn));

    const work = async () => {
      const { rows: [r] } = await run((tx) => tx.query('SELECT * FROM idempotency_begin($1,$2,$3,$4,$5)', [p.userId, scope, key, hash, this.clock.now()]));
      if (!r.is_new) {
        if (r.request_hash !== hash) {
          throw new DomainError('IDEMPOTENCY_KEY_REUSED', 422, 'This Idempotency-Key was already used for a different request.');
        }
        if (r.state === 'running') throw new DomainError('REQUEST_IN_PROGRESS', 409, 'This request is still being processed.');
        res.status(r.status_code);
        res.setHeader('idempotent-replay', 'true');
        return r.response_enc ? JSON.parse(decrypt(this.config.ENCRYPTION_KEY, r.response_enc)) : undefined;
      }
      try {
        const body = await lastValueFrom(next.handle(), { defaultValue: undefined });
        const stored = body === undefined ? null : encrypt(this.config.ENCRYPTION_KEY, JSON.stringify(body));
        await run((tx) => tx.query('SELECT idempotency_finish($1,$2,$3,$4,$5)', [p.userId, scope, key, res.statusCode, stored]));
        return body;
      } catch (err) {
        await run((tx) => tx.query('SELECT idempotency_release($1,$2,$3)', [p.userId, scope, key])).catch(() => undefined);
        throw err;
      }
    };
    return from(work());
  }
}
