import { Controller, Get, Inject, Param, Req } from '@nestjs/common';
import { UsersService } from '../application/users.service.js';
import { type AuthedRequest, Requires, tenantOf } from './guard.js';

@Controller('users')
export class UsersController {
  constructor(@Inject(UsersService) private readonly users: UsersService) {}

  @Requires('users.manage')
  @Get()
  async list(@Req() req: AuthedRequest) {
    return { data: await this.users.list(tenantOf(req)) };
  }

  @Requires('users.manage')
  @Get(':id')
  get(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.users.get(tenantOf(req), id);
  }
}
