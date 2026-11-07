import { type CanActivate, type ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DomainError } from '@vittora/shared-kernel';
import type { Request } from 'express';
import type { Config } from '../../../platform/config.js';
import { hmac, safeEqual } from '../../../platform/crypto.js';
import type { TenantContext } from '../../../platform/db.js';
import { AuthService, type Principal, type RequestMeta } from '../application/auth.service.js';
import { type Capability, can } from '../domain/permissions.js';
import { CONFIG } from '../ports/index.js';

const PUBLIC = 'vittora:public';
const MFA_INCOMPLETE_OK = 'vittora:mfa-incomplete-ok';
const CAPABILITY = 'vittora:capability';
const OPS_ONLY = 'vittora:ops-only';

/** Anonymous access. Every other route is denied unless signed in. */
export const Public = () => SetMetadata(PUBLIC, true);
/** Reachable before two-step sign-in is finished. */
export const MfaIncompleteOk = () => SetMetadata(MFA_INCOMPLETE_OK, true);
export const Requires = (capability: Capability) => SetMetadata(CAPABILITY, capability);
/** Internal staff only. Partner users get 403 whatever their role. */
export const OpsOnly = () => SetMetadata(OPS_ONLY, true);

export type AuthedRequest = Request & { principal?: Principal };

export const cookieNames = (config: Config) =>
  config.NODE_ENV === 'production'
    ? { session: '__Host-vittora_session', csrf: '__Host-vittora_csrf' }
    : { session: 'vittora_session', csrf: 'vittora_csrf' };

export const metaOf = (req: Request): RequestMeta => ({
  ip: req.ip ?? null,
  userAgent: req.get('user-agent')?.slice(0, 300) ?? null,
});

export function principalOf(req: AuthedRequest): Principal {
  if (!req.principal) throw new DomainError('AUTH_REQUIRED', 401, 'Please sign in.');
  return req.principal;
}

/** Tenant scope comes from the session only (§14.8). */
export function tenantOf(req: AuthedRequest): TenantContext {
  const { partnerId } = principalOf(req);
  if (!partnerId) throw new DomainError('FORBIDDEN', 403, 'You do not have access to this.');
  return { partnerId };
}

export const signCsrf = (key: string, nonce: string) => `${nonce}.${hmac(key, `csrf:${nonce}`)}`;

@Injectable()
export class AppGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  private flag<T>(key: string, ctx: ExecutionContext): T | undefined {
    return this.reflector.getAllAndOverride<T>(key, [ctx.getHandler(), ctx.getClass()]);
  }

  private checkCsrf(req: Request) {
    const forbidden = new DomainError('CSRF_FAILED', 403, 'Please refresh the page and try again.');
    const origin = req.get('origin');
    if (origin && origin !== this.config.WEB_ORIGIN) throw forbidden;
    const cookie: string | undefined = req.cookies?.[cookieNames(this.config).csrf];
    const header = req.get('x-csrf-token');
    if (!cookie || !header || !safeEqual(cookie, header)) throw forbidden;
    const nonce = cookie.split('.')[0] ?? '';
    if (!safeEqual(cookie, signCsrf(this.config.HMAC_KEY, nonce))) throw forbidden;
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) this.checkCsrf(req);
    if (this.flag<boolean>(PUBLIC, ctx)) return true;

    const principal = await this.auth.authenticate(req.cookies?.[cookieNames(this.config).session]);
    if (!principal) throw new DomainError('AUTH_REQUIRED', 401, 'Please sign in.');
    req.principal = principal;

    if (principal.mfaState !== 'ok' && !this.flag<boolean>(MFA_INCOMPLETE_OK, ctx)) {
      throw new DomainError('MFA_REQUIRED', 403, 'Finish two-step sign-in first.');
    }
    if (this.flag<boolean>(OPS_ONLY, ctx) && principal.partnerId !== null) {
      throw new DomainError('FORBIDDEN', 403, 'You do not have access to this.');
    }
    const capability = this.flag<Capability>(CAPABILITY, ctx);
    if (capability && !can(principal.role, capability, principal.features)) {
      throw new DomainError('FORBIDDEN', 403, 'You do not have access to this.');
    }
    return true;
  }
}
