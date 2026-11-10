import { readPage } from '../../../platform/paging.js';
import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Req, Query } from '@nestjs/common';
import { PARTNER_ROLES } from '@vittora/shared-kernel';
import { z } from 'zod';
import { checkId } from '../../../platform/request.js';
import { UsersService } from '../application/users.service.js';
import { parse } from './auth.controller.js';
import { type AuthedRequest, Requires, metaOf, principalOf, tenantOf } from './guard.js';

// Only partner roles parse here, so an internal role can't be assigned from a tenant (§4.9).
const role = z.enum(PARTNER_ROLES);
const name = z.string().trim().min(2).max(120);
const phone = z.string().regex(/^[6-9][0-9]{9}$/);
const InviteBody = z.object({ name, email: z.string().trim().toLowerCase().email().max(254), phone: phone.optional(), role });
const UpdateBody = z.object({ name: name.optional(), phone: phone.nullable().optional(), role: role.optional() }).strict();
const DeactivateBody = z.object({ reassignTo: z.string().uuid().optional() });

@Controller('users')
export class UsersController {
  constructor(@Inject(UsersService) private readonly users: UsersService) {}

  @Requires('users.manage')
  @Get()
  list(@Req() req: AuthedRequest, @Query() q: { limit?: string; cursor?: string }) {
    return this.users.list(tenantOf(req), readPage(q, 100));
  }

  @Requires('users.manage')
  @Post('invite')
  @HttpCode(201)
  invite(@Body() body: unknown, @Req() req: AuthedRequest) {
    return this.users.invite(principalOf(req), tenantOf(req), parse(InviteBody, body), metaOf(req));
  }

  @Requires('users.manage')
  @Get(':id')
  get(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.users.get(tenantOf(req), id);
  }

  @Requires('users.manage')
  @Patch(':id')
  update(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    return this.users.update(principalOf(req), tenantOf(req), checkId(id), parse(UpdateBody, body), metaOf(req));
  }

  @Requires('users.manage')
  @Post(':id/deactivate')
  @HttpCode(204)
  async deactivate(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    await this.users.deactivate(principalOf(req), tenantOf(req), checkId(id), parse(DeactivateBody, body ?? {}).reassignTo, metaOf(req));
  }

  @Requires('users.manage')
  @Post(':id/reactivate')
  @HttpCode(204)
  async reactivate(@Param('id') id: string, @Req() req: AuthedRequest) {
    await this.users.reactivate(principalOf(req), tenantOf(req), checkId(id), metaOf(req));
  }

  @Requires('users.manage')
  @Post(':id/resend-invite')
  @HttpCode(204)
  async resend(@Param('id') id: string, @Req() req: AuthedRequest) {
    await this.users.resendInvite(principalOf(req), tenantOf(req), checkId(id), metaOf(req));
  }

  @Requires('users.manage')
  @Post(':id/sign-out')
  @HttpCode(204)
  async signOut(@Param('id') id: string, @Req() req: AuthedRequest) {
    await this.users.signOut(principalOf(req), tenantOf(req), checkId(id), metaOf(req));
  }
}
