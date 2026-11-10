import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { DomainError } from '@vittora/shared-kernel';
import type { CookieOptions, Response } from 'express';
import { z } from 'zod';
import type { Config } from '../../../platform/config.js';
import { randomToken, safeEqual } from '../../../platform/crypto.js';
import { AuthService } from '../application/auth.service.js';
import { capabilitiesFor } from '../domain/permissions.js';
import { SESSION_ABSOLUTE_MS } from '../domain/rules.js';
import { CONFIG, PARTNER_READER, type PartnerReader } from '../ports/index.js';
import {
  type AuthedRequest, MfaIncompleteOk, Public, cookieNames, metaOf, principalOf, signCsrf,
} from './guard.js';

export function parse<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body);
  if (!result.success) throw new DomainError('VALIDATION_FAILED', 422, 'Please check the form and try again.');
  return result.data;
}

const email = z.string().trim().email().max(254);
const LoginBody = z.object({ email, password: z.string().min(1).max(200) });
const ForgotBody = z.object({ email });
const ResetBody = z.object({ token: z.string().min(10).max(200), password: z.string().min(1).max(200) });
const ChangeBody = z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().min(1).max(200) });
const CodeBody = z.object({ code: z.string().regex(/^[0-9]{6}$/) });

@Controller()
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(PARTNER_READER) private readonly partners: PartnerReader,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  private cookieOptions(httpOnly: boolean): CookieOptions {
    return { httpOnly, secure: this.config.NODE_ENV === 'production', sameSite: 'lax', path: '/' };
  }

  @Public()
  @Get('auth/csrf')
  csrf(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    // Keep a valid token: replacing it would break every other tab, which still holds the old one.
    const current: string | undefined = req.cookies?.[cookieNames(this.config).csrf];
    const nonce = current?.split('.')[0] ?? '';
    const valid = !!current && safeEqual(current, signCsrf(this.config.HMAC_KEY, nonce));
    const token = valid ? current : signCsrf(this.config.HMAC_KEY, randomToken(16));
    res.cookie(cookieNames(this.config).csrf, token, this.cookieOptions(false));
    return { csrfToken: token };
  }

  @Public()
  @Post('auth/login')
  @HttpCode(200)
  async login(@Body() body: unknown, @Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    const input = parse(LoginBody, body);
    const { token, mfaState } = await this.auth.login(input.email, input.password, metaOf(req));
    res.cookie(cookieNames(this.config).session, token, {
      ...this.cookieOptions(true),
      maxAge: SESSION_ABSOLUTE_MS,
    });
    return { mfaState };
  }

  /** The internal console's own sign-in. Sets the same cookie, but only staff accounts pass. */
  @Public()
  @Post('ops/auth/login')
  @HttpCode(200)
  async opsLogin(@Body() body: unknown, @Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    const input = parse(LoginBody, body);
    const { token, mfaState } = await this.auth.login(input.email, input.password, metaOf(req), 'ops');
    res.cookie(cookieNames(this.config).session, token, { ...this.cookieOptions(true), maxAge: SESSION_ABSOLUTE_MS });
    return { mfaState };
  }

  @MfaIncompleteOk()
  @Post('auth/logout')
  @HttpCode(204)
  async logout(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(principalOf(req), metaOf(req));
    res.clearCookie(cookieNames(this.config).session, this.cookieOptions(true));
  }

  @Post('auth/sessions/revoke-all')
  @HttpCode(204)
  async revokeAll(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    await this.auth.signOutEverywhere(principalOf(req), metaOf(req));
    res.clearCookie(cookieNames(this.config).session, this.cookieOptions(true));
  }

  @Public()
  @Post('auth/password/forgot')
  @HttpCode(202)
  async forgot(@Body() body: unknown, @Req() req: AuthedRequest) {
    await this.auth.forgotPassword(parse(ForgotBody, body).email, metaOf(req));
    return { accepted: true };
  }

  @Public()
  @Post('auth/password/reset')
  @HttpCode(204)
  async reset(@Body() body: unknown, @Req() req: AuthedRequest) {
    const input = parse(ResetBody, body);
    await this.auth.resetPassword(input.token, input.password, metaOf(req));
  }

  @Post('auth/password/change')
  @HttpCode(204)
  async change(@Body() body: unknown, @Req() req: AuthedRequest) {
    const input = parse(ChangeBody, body);
    await this.auth.changePassword(principalOf(req), input.currentPassword, input.newPassword, metaOf(req));
  }

  @MfaIncompleteOk()
  @Post('auth/mfa/setup')
  @HttpCode(200)
  setup(@Req() req: AuthedRequest) {
    return this.auth.startMfaSetup(principalOf(req));
  }

  @MfaIncompleteOk()
  @Post('auth/mfa/enable')
  @HttpCode(204)
  async enable(@Body() body: unknown, @Req() req: AuthedRequest) {
    await this.auth.enableMfa(principalOf(req), parse(CodeBody, body).code, metaOf(req));
  }

  @MfaIncompleteOk()
  @Post('auth/mfa/verify')
  @HttpCode(204)
  async verify(@Body() body: unknown, @Req() req: AuthedRequest) {
    await this.auth.verifyMfa(principalOf(req), parse(CodeBody, body).code, metaOf(req));
  }

  @MfaIncompleteOk()
  @Post('auth/mfa/email-otp')
  @HttpCode(202)
  async emailOtp(@Req() req: AuthedRequest) {
    await this.auth.sendEmailOtp(principalOf(req));
    return { accepted: true };
  }

  @MfaIncompleteOk()
  @Get('me')
  async me(@Req() req: AuthedRequest) {
    const p = principalOf(req);
    const partner = p.mfaState === 'ok' && p.partnerId ? await this.partners.get({ partnerId: p.partnerId }) : null;
    return {
      userId: p.userId,
      role: p.role,
      mfaState: p.mfaState,
      mfaEnabled: p.mfaEnabled,
      partner,
      features: p.features,
      permissions: p.mfaState === 'ok' ? capabilitiesFor(p.role, p.features) : [],
    };
  }
}
