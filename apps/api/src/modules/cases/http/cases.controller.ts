import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Patch, Post, Query, Req, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { DraftData } from '@vittora/product-schemas';
import { DomainError } from '@vittora/shared-kernel';
import { z } from 'zod';
import { MAX_UPLOAD_BYTES, type UploadedFile as Upload } from '../../../platform/storage.js';
import { type AuthedRequest, Public, Requires, metaOf, parse, principalOf, tenantOf } from '../../identity/index.js';
import { CasesService } from '../application/cases.service.js';

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

@Controller()
export class CasesController {
  constructor(@Inject(CasesService) private readonly cases: CasesService) {}

  @Requires('case.create')
  @Get('catalogue/products')
  async products(@Req() req: AuthedRequest) {
    return { data: await this.cases.catalogue(tenantOf(req)) };
  }

  @Requires('case.create')
  @Get('lenders')
  async lenders(@Query('product') product: string, @Req() req: AuthedRequest) {
    return { data: await this.cases.lenders(tenantOf(req), product ?? '') };
  }

  @Requires('case.create')
  @Post('cases/drafts')
  createDraft(@Headers('idempotency-key') key: string | undefined, @Req() req: AuthedRequest) {
    return this.cases.createDraft(principalOf(req), tenantOf(req), idempotencyKey(key), metaOf(req));
  }

  @Requires('case.create')
  @Get('cases/drafts')
  async listDrafts(@Req() req: AuthedRequest) {
    return { data: await this.cases.listDrafts(principalOf(req), tenantOf(req)) };
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
    return this.cases.patchDraft(principalOf(req), tenantOf(req), checkId(id), input.version, input.data as DraftData);
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
    return this.cases.consentPage(token);
  }

  @Public()
  @Post('public/consent/:token')
  @HttpCode(204)
  async giveConsent(@Param('token') token: string, @Req() req: AuthedRequest) {
    await this.cases.giveConsent(token, metaOf(req));
  }
}
