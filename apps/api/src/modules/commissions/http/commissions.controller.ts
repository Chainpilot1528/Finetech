import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { checkId, ifMatch } from '../../../platform/request.js';
import { type AuthedRequest, OpsOnly, Requires, metaOf, parse, principalOf, tenantOf } from '../../identity/index.js';
import { CommissionsService } from '../application/commissions.service.js';
import { OpsFinanceService } from '../application/ops-finance.service.js';

const note = z.string().trim().min(3).max(500);
const date = z.string().regex(/^20[0-9]{2}-[0-9]{2}-[0-9]{2}$/);
const rupees = z.number().int().min(0).max(100_000_000_000);
const ListQuery = z.object({ group: z.enum(['to_raise', 'in_review', 'pending_payout', 'paid']).optional() });
const DisputeBody = z.object({ note });
const PayoutBody = z.object({ payoutRef: z.string().trim().min(3).max(60) });
const ResolveBody = z.object({ outcome: z.enum(['reinstate', 'void']), note });
const RateCardBody = z.object({
  lenderId: z.string().uuid(), product: z.string(), loanType: z.string().optional(), slabMin: rupees, slabMax: rupees.optional(),
  pctBps: z.number().int().positive().max(10_000), clawbackMonths: z.number().int().min(0).max(60), validFrom: date, validTo: date.optional(),
});
const RateDecision = z.object({ decision: z.enum(['active', 'rejected']) });
const ClawbackDecision = z.object({ decision: z.enum(['approved', 'rejected']) });

@Controller('invoices')
export class InvoicesController {
  constructor(@Inject(CommissionsService) private readonly invoices: CommissionsService) {}

  @Requires('invoices.manage')
  @Get()
  list(@Query() query: unknown, @Req() req: AuthedRequest) {
    return this.invoices.list(tenantOf(req), parse(ListQuery, query).group);
  }

  @Requires('invoices.manage')
  @Get(':id')
  get(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.invoices.get(tenantOf(req), checkId(id));
  }

  @Requires('invoices.manage')
  @Post(':id/raise')
  @HttpCode(200)
  raise(@Param('id') id: string, @Headers('if-match') match: string | undefined, @Req() req: AuthedRequest) {
    return this.invoices.raise(principalOf(req), tenantOf(req), checkId(id), ifMatch(match), metaOf(req));
  }

  @Requires('invoices.manage')
  @Post(':id/dispute')
  @HttpCode(204)
  async dispute(@Param('id') id: string, @Body() body: unknown, @Headers('if-match') match: string | undefined, @Req() req: AuthedRequest) {
    await this.invoices.dispute(principalOf(req), tenantOf(req), checkId(id), ifMatch(match), parse(DisputeBody, body).note, metaOf(req));
  }
}

@OpsOnly()
@Controller('ops')
export class OpsFinanceController {
  constructor(@Inject(OpsFinanceService) private readonly finance: OpsFinanceService) {}

  @Requires('finance.manage')
  @Get('invoices')
  async invoices(@Query('status') status?: string) {
    return { data: await this.finance.invoices(status || undefined) };
  }

  @Requires('finance.manage')
  @Post('invoices/:id/approve')
  @HttpCode(204)
  async approve(@Param('id') id: string, @Headers('if-match') match: string | undefined, @Req() req: AuthedRequest) {
    await this.finance.approve(principalOf(req), checkId(id), ifMatch(match), metaOf(req));
  }

  @Requires('finance.manage')
  @Post('invoices/:id/mark-paid')
  @HttpCode(204)
  async markPaid(@Param('id') id: string, @Body() body: unknown, @Headers('if-match') match: string | undefined, @Req() req: AuthedRequest) {
    await this.finance.requestPaid(principalOf(req), checkId(id), ifMatch(match), parse(PayoutBody, body).payoutRef, metaOf(req));
  }

  @Requires('finance.manage')
  @Post('invoices/:id/confirm-paid')
  @HttpCode(200)
  confirmPaid(@Param('id') id: string, @Headers('if-match') match: string | undefined, @Req() req: AuthedRequest) {
    return this.finance.confirmPaid(principalOf(req), checkId(id), ifMatch(match), metaOf(req));
  }

  @Requires('finance.manage')
  @Post('invoices/:id/resolve-dispute')
  @HttpCode(204)
  async resolve(@Param('id') id: string, @Body() body: unknown, @Headers('if-match') match: string | undefined, @Req() req: AuthedRequest) {
    const input = parse(ResolveBody, body);
    await this.finance.resolveDispute(principalOf(req), checkId(id), ifMatch(match), input.outcome, input.note, metaOf(req));
  }

  @Requires('finance.manage')
  @Get('rate-cards')
  rateCards() {
    return this.finance.rateCards();
  }

  @Requires('finance.manage')
  @Post('rate-cards')
  @HttpCode(201)
  createRateCard(@Body() body: unknown, @Req() req: AuthedRequest) {
    return this.finance.createRateCard(principalOf(req), parse(RateCardBody, body), metaOf(req));
  }

  @Requires('finance.manage')
  @Post('rate-cards/:id/decision')
  @HttpCode(200)
  decideRateCard(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    return this.finance.decideRateCard(principalOf(req), checkId(id), parse(RateDecision, body).decision, metaOf(req));
  }

  @Requires('finance.manage')
  @Get('clawbacks')
  async clawbacks() {
    return { data: await this.finance.clawbacks() };
  }

  @Requires('finance.manage')
  @Post('clawbacks/:id/decision')
  @HttpCode(204)
  async decideClawback(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    await this.finance.decideClawback(principalOf(req), checkId(id), parse(ClawbackDecision, body).decision, metaOf(req));
  }
}
