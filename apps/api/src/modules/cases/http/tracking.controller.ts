import { Body, Controller, Get, Header, Headers, HttpCode, Inject, Param, Post, Query, Req, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { z } from 'zod';
import { checkId, idempotencyKey, ifMatch } from '../../../platform/request.js';
import { MAX_UPLOAD_BYTES, type UploadedFile as Upload } from '../../../platform/storage.js';
import { type AuthedRequest, OpsOnly, Requires, metaOf, parse, principalOf, tenantOf } from '../../identity/index.js';
import { OpsCasesService } from '../application/ops-cases.service.js';
import { TrackingService } from '../application/tracking.service.js';

const month = z.string().regex(/^20[0-9]{2}-(0[1-9]|1[0-2])$/);
const paging = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
};
const filters = {
  status: z.string().regex(/^[A-Z_,]+$/).optional().transform((v) => v?.split(',')),
  bucket: z.enum(['needs_action', 'active', 'disbursed', 'rejected']).optional(),
  caseType: z.enum(['open_market', 'in_house']).optional(),
  product: z.union([z.string(), z.array(z.string())]).optional().transform((v) => (v === undefined ? undefined : [v].flat().flatMap((s) => s.split(',')))),
  registrationMonth: month.optional(),
  disbursedMonth: month.optional(),
  q: z.string().trim().min(1).max(40).optional(),
  sort: z.enum(['created', 'updated', 'amount']).optional(),
};
const ListQuery = z.object({ ...filters, ...paging });
const ExportBody = z.object(filters);
const DashboardQuery = z.object({ month, view: z.enum(['pipeline', 'revenue']).default('pipeline'), product: z.string().optional() });
const note = z.string().trim().min(1).max(1000);
const TransitionBody = z.object({ to: z.string(), reasonCode: z.string().max(40).optional(), note });
const NoteBody = z.object({ body: note });
const RevealBody = z.object({ field: z.enum(['phone', 'email']), reason: z.string().trim().min(5).max(300) });

const OpsQuery = z.object({ status: z.string().regex(/^[A-Z_]+$/).optional(), assigned: z.enum(['me', 'none']).optional(), ...paging });
const rupees = z.number().int().positive().max(1_000_000_000);
const OpsTransitionBody = z.object({
  to: z.string(), reasonCode: z.string().max(40).optional(), note: z.string().trim().max(1000).optional(),
  lenderId: z.string().uuid().optional(), sanctionedAmount: rupees.optional(),
  roiBps: z.number().int().positive().max(6000).optional(), tenureMonths: z.number().int().positive().max(480).optional(),
  checklistComplete: z.boolean().optional(),
});
const DisbursalBody = z.object({
  utr: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{12,22}$/), amount: rupees,
  disbursedOn: z.string().regex(/^20[0-9]{2}-[0-9]{2}-[0-9]{2}$/), isFinal: z.boolean(),
});
const ReversalBody = z.object({ reasonCode: z.string().min(2).max(40), reference: z.string().trim().min(3).max(60), note: z.string().trim().max(500).optional() });
const DecisionBody = z.object({ decision: z.enum(['approved', 'rejected']) });
const AssignBody = z.object({ userId: z.string().uuid() });

@Controller()
export class TrackingController {
  constructor(@Inject(TrackingService) private readonly tracking: TrackingService) {}

  @Requires('dashboard.view')
  @Get('dashboard/summary')
  dashboard(@Query() query: unknown, @Req() req: AuthedRequest) {
    const q = parse(DashboardQuery, query);
    return this.tracking.dashboard(principalOf(req), tenantOf(req), q.month, q.view, q.product);
  }

  @Requires('case.view')
  @Get('cases')
  list(@Query() query: unknown, @Req() req: AuthedRequest) {
    return this.tracking.list(principalOf(req), tenantOf(req), parse(ListQuery, query));
  }

  @Requires('case.export')
  @Post('cases/export')
  @HttpCode(200)
  @Header('content-type', 'text/csv; charset=utf-8')
  @Header('content-disposition', 'attachment; filename="vittora-cases.csv"')
  export(@Body() body: unknown, @Req() req: AuthedRequest) {
    return this.tracking.export(principalOf(req), tenantOf(req), parse(ExportBody, body ?? {}), metaOf(req));
  }

  @Requires('case.view')
  @Get('cases/:id')
  detail(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.tracking.detail(principalOf(req), tenantOf(req), checkId(id));
  }

  @Requires('case.fieldwork')
  @Post('cases/:id/transitions')
  @HttpCode(200)
  transition(@Param('id') id: string, @Body() body: unknown, @Headers('if-match') match: string | undefined, @Req() req: AuthedRequest) {
    return this.tracking.transition(principalOf(req), tenantOf(req), checkId(id), ifMatch(match), parse(TransitionBody, body), metaOf(req));
  }

  @Requires('case.note')
  @Post('cases/:id/notes')
  @HttpCode(201)
  note(@Param('id') id: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @Req() req: AuthedRequest) {
    return this.tracking.addNote(principalOf(req), tenantOf(req), checkId(id), idempotencyKey(key), parse(NoteBody, body).body, metaOf(req));
  }

  @Requires('case.fieldwork')
  @Post('cases/:id/documents')
  @HttpCode(204)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } }))
  async upload(@Param('id') id: string, @UploadedFile() file: Upload | undefined, @Req() req: AuthedRequest) {
    await this.tracking.upload(principalOf(req), tenantOf(req), checkId(id), file, metaOf(req));
  }

  @Requires('case.view')
  @Get('cases/:id/documents/:docId/url')
  documentUrl(@Param('id') id: string, @Param('docId') docId: string, @Req() req: AuthedRequest) {
    return this.tracking.documentLink(principalOf(req), tenantOf(req), checkId(id), checkId(docId), metaOf(req));
  }

  @Requires('pii.reveal')
  @Post('cases/:id/pii-reveal')
  @HttpCode(200)
  reveal(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    const input = parse(RevealBody, body);
    return this.tracking.reveal(principalOf(req), tenantOf(req), checkId(id), input.field, input.reason, metaOf(req));
  }
}

@OpsOnly()
@Controller('ops')
export class OpsCasesController {
  constructor(@Inject(OpsCasesService) private readonly ops: OpsCasesService) {}

  @Requires('ops.cases')
  @Get('cases')
  queue(@Query() query: unknown, @Req() req: AuthedRequest) {
    return this.ops.queue(principalOf(req), parse(OpsQuery, query));
  }

  @Requires('ops.assign')
  @Get('staff')
  async staff() {
    return { data: await this.ops.staff() };
  }

  @Requires('ops.assign')
  @Post('cases/auto-assign')
  @HttpCode(200)
  autoAssign(@Req() req: AuthedRequest) {
    return this.ops.autoAssign(principalOf(req), metaOf(req));
  }

  @Requires('ops.cases')
  @Get('cases/:id')
  detail(@Param('id') id: string) {
    return this.ops.detail(checkId(id));
  }

  @Requires('ops.assign')
  @Post('cases/:id/assign')
  @HttpCode(204)
  async assign(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    await this.ops.assign(principalOf(req), checkId(id), parse(AssignBody, body).userId, metaOf(req));
  }

  @Requires('ops.cases')
  @Post('cases/:id/take')
  @HttpCode(204)
  async take(@Param('id') id: string, @Req() req: AuthedRequest) {
    await this.ops.take(principalOf(req), checkId(id), metaOf(req));
  }

  @Requires('ops.cases')
  @Post('cases/:id/transitions')
  @HttpCode(200)
  transition(@Param('id') id: string, @Body() body: unknown, @Headers('if-match') match: string | undefined, @Req() req: AuthedRequest) {
    return this.ops.transition(principalOf(req), checkId(id), ifMatch(match), parse(OpsTransitionBody, body), metaOf(req));
  }

  @Requires('ops.cases')
  @Post('cases/:id/disbursals')
  @HttpCode(201)
  disbursal(@Param('id') id: string, @Body() body: unknown, @Headers('if-match') match: string | undefined, @Req() req: AuthedRequest) {
    return this.ops.recordDisbursal(principalOf(req), checkId(id), ifMatch(match), parse(DisbursalBody, body), metaOf(req));
  }

  @Requires('ops.cases')
  @Post('cases/:id/reversal')
  @HttpCode(204)
  async reversal(@Param('id') id: string, @Body() body: unknown, @Headers('if-match') match: string | undefined, @Req() req: AuthedRequest) {
    await this.ops.requestReversal(principalOf(req), checkId(id), ifMatch(match), parse(ReversalBody, body), metaOf(req));
  }

  @Requires('finance.manage')
  @Post('cases/:id/reversal/decision')
  @HttpCode(204)
  async decide(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    await this.ops.decideReversal(principalOf(req), checkId(id), parse(DecisionBody, body).decision, metaOf(req));
  }

  @Requires('ops.cases')
  @Get('cases/:id/documents/:docId/url')
  documentUrl(@Param('id') id: string, @Param('docId') docId: string, @Req() req: AuthedRequest) {
    return this.ops.documentLink(principalOf(req), checkId(id), checkId(docId), metaOf(req));
  }
}
