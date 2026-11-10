import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Patch, Post, Query, Req, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { DraftData } from '@vittora/product-schemas';
import { DomainError } from '@vittora/shared-kernel';
import { z } from 'zod';
import { readPage } from '../../../platform/paging.js';
import { MAX_UPLOAD_BYTES, type UploadedFile as Upload } from '../../../platform/storage.js';
import { type AuthedRequest, Public, Requires, metaOf, parse, principalOf, tenantOf } from '../../identity/index.js';
import { CasesService } from '../application/cases.service.js';
import { ConsentService } from '../application/consent.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function checkId(id: string) {
  if (!UUID.test(id)) throw new DomainError('NOT_FOUND', 404, 'Not found.');
  return id;
}
function idempotencyKey(key: string | undefined) {
  if (!key || key.length < 8 || key.length > 100) {
    throw new DomainError('IDEMPOTENCY_KEY_REQUIRED', 400, 'An Idempotency-Key header is required.');
  }
  return key;
}

const section = z.record(z.unknown()).optional();
const PatchBody = z.object({
  version: z.number().int(),
  data: z.object({ setup: section, applicant: section, details: section, loan: section, income: section, documents: section }),
});
const SubmitBody = z.object({ confirmDuplicate: z.boolean().optional() });
const ConsentBody = z.object({ code: z.string().regex(/^[0-9]{6}$/, 'Enter the 6-digit code.').optional() });

@Controller()
export class CasesController {
  constructor(
    @Inject(CasesService) private readonly cases: CasesService,
    @Inject(ConsentService) private readonly consent: ConsentService,
  ) {}

  @Requires('case.create')
  @Get('catalogue/products')
  async products(@Req() req: AuthedRequest) {
    return { data: await this.cases.catalogue(tenantOf(req)) };
  }

  @Requires('case.create')
  @Get('lenders')
  async lenders(@Query('product') product: string, @Query('loanType') loanType: string | undefined, @Req() req: AuthedRequest) {
    return { data: await this.cases.lenders(tenantOf(req), product ?? '', loanType || undefined) };
  }

  @Requires('case.create')
  @Post('cases/drafts')
  createDraft(@Headers('idempotency-key') key: string | undefined, @Req() req: AuthedRequest) {
    return this.cases.createDraft(principalOf(req), tenantOf(req), idempotencyKey(key), metaOf(req));
  }

  @Requires('case.create')
  @Get('cases/drafts')
  listDrafts(@Req() req: AuthedRequest, @Query() q: { limit?: string; cursor?: string }) {
    return this.cases.listDrafts(principalOf(req), tenantOf(req), readPage(q, 20));
  }

  @Requires('case.create')
  @Get('cases/drafts/:id')
  getDraft(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.cases.getDraft(principalOf(req), tenantOf(req), checkId(id));
  }

  @Requires('case.create')
  @Patch('cases/drafts/:id')
  patchDraft(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    const input = parse(PatchBody, body);
    return this.cases.patchDraft(principalOf(req), tenantOf(req), checkId(id), input.version, input.data as DraftData, metaOf(req));
  }

  @Requires('case.create')
  @Post('cases/drafts/:id/documents/:docType')
  @HttpCode(204)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } }))
  async upload(
    @Param('id') id: string, @Param('docType') docType: string, @UploadedFile() file: Upload | undefined,
    @Req() req: AuthedRequest,
  ) {
    await this.cases.uploadDocument(principalOf(req), tenantOf(req), checkId(id), docType, file, metaOf(req));
  }

  @Requires('case.create')
  @Post('cases/drafts/:id/consent-requests')
  @HttpCode(202)
  requestConsent(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.cases.requestConsent(principalOf(req), tenantOf(req), checkId(id), metaOf(req));
  }

  @Requires('case.create')
  @Post('cases/drafts/:id/submit')
  @HttpCode(201)
  submit(
    @Param('id') id: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined,
    @Req() req: AuthedRequest,
  ) {
    idempotencyKey(key);
    const { confirmDuplicate } = parse(SubmitBody, body ?? {});
    return this.cases.submit(principalOf(req), tenantOf(req), checkId(id), !!confirmDuplicate, metaOf(req));
  }

  @Public()
  @Get('public/consent/:token')
  consentPage(@Param('token') token: string) {
    return this.consent.page(token);
  }

  @Public()
  @Post('public/consent/:token/code')
  @HttpCode(202)
  async sendConsentCode(@Param('token') token: string, @Req() req: AuthedRequest) {
    await this.consent.sendCode(token, metaOf(req));
  }

  @Public()
  @Post('public/consent/:token')
  @HttpCode(204)
  async giveConsent(@Param('token') token: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    await this.consent.give(token, parse(ConsentBody, body ?? {}).code, metaOf(req));
  }
}
