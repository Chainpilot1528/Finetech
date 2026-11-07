import { type ArgumentsHost, Catch, Controller, Get, type ExceptionFilter, HttpException, Inject } from '@nestjs/common';
import { DomainError } from '@vittora/shared-kernel';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { DB, DevMailbox, MAILER, Public } from '../modules/identity/index.js';
import type { Db } from './db.js';

/** Every error leaves as RFC 7807 problem+json with a stable code. Stack traces never do (§14.6). */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  catch(err: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const problem =
      err instanceof DomainError
        ? { status: err.status, code: err.code, title: err.message }
        : err instanceof HttpException
          ? { status: err.getStatus(), code: err.getStatus() === 404 ? 'NOT_FOUND' : 'BAD_REQUEST', title: 'Request failed.' }
          : { status: 500, code: 'INTERNAL_ERROR', title: 'Something went wrong on our side.' };
    if (problem.status >= 500) {
      console.error(JSON.stringify({ level: 'error', event: 'unhandled', name: (err as Error)?.name, message: (err as Error)?.message }));
    }
    res.status(problem.status).type('application/problem+json').send(problem);
  }
}

/** One JSON line per request with a correlation id. Paths and ids only, never PII (§14.12). */
export function requestLog(req: Request, res: Response, next: NextFunction) {
  const requestId = req.get('x-request-id') ?? randomUUID();
  const started = process.hrtime.bigint();
  res.setHeader('x-request-id', requestId);
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'info', request_id: requestId, method: req.method, path: req.path, status: res.statusCode, ms: Math.round(ms) }));
  });
  next();
}

@Controller()
export class HealthController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Public()
  @Get('healthz')
  health() {
    return { status: 'ok' };
  }

  @Public()
  @Get('readyz')
  async ready() {
    await this.db.ping();
    return { status: 'ready' };
  }
}

/** Only mounted when DEV_MAILBOX is on, which config refuses in production. */
@Controller('dev')
export class DevMailController {
  constructor(@Inject(MAILER) private readonly mailer: DevMailbox) {}

  @Public()
  @Get('mail')
  list() {
    return { data: this.mailer.messages };
  }
}
