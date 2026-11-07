import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query, Req, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { REGISTRATION_PRODUCTS } from '@vittora/product-schemas';
import { DomainError } from '@vittora/shared-kernel';
import { z } from 'zod';
import { MAX_UPLOAD_BYTES, type UploadedFile as Upload } from '../../../platform/storage.js';
import { type AuthedRequest, OpsOnly, Public, Requires, metaOf, parse, principalOf, tenantOf } from '../../identity/index.js';
import { KYC_TYPES, type KycType, KycService } from '../application/kyc.service.js';
import { OpsKycService } from '../application/ops-kyc.service.js';
import { RegistrationService } from '../application/registration.service.js';
import { SettingsService } from '../application/settings.service.js';

const name = z.string().trim().min(2).max(120);
const phone = z.string().regex(/^[6-9][0-9]{9}$/);
const RegisterBody = z.object({
  channelName: name,
  legalName: name,
  city: z.string().trim().min(2).max(80),
  pincode: z.string().regex(/^[1-9][0-9]{5}$/),
  businessEmail: z.string().trim().email(),
  businessPhone: phone.optional(),
  products: z.array(z.enum(REGISTRATION_PRODUCTS.map((p) => p.code) as [string, ...string[]])).min(1),
  employeeBand: z.enum(['1-5', '6-10', '11-25', '26-50', '51-100', '100+']),
  adminName: name,
  adminEmail: z.string().trim().email(),
  adminPhone: phone.optional(),
});
const AcceptBody = z.object({ version: z.string() });
const ReviewBody = z.object({ decision: z.enum(['approved', 'rejected']), note: z.string().max(500).optional() });
const DecisionBody = z.object({ decision: z.enum(['approved', 'rejected']) });
const bands = ['1-5', '6-10', '11-25', '26-50', '51-100', '100+'] as const;
const CompanyBody = z.object({
  city: z.string().trim().min(2).max(80).optional(),
  pincode: z.string().regex(/^[1-9][0-9]{5}$/).optional(),
  employeeBand: z.enum(bands).optional(),
  businessEmail: z.string().trim().email().optional(),
  businessPhone: phone.nullable().optional(),
  maskCustomerContact: z.boolean().optional(),
}).strict();
const BillingBody = z.object({
  gstRegistered: z.boolean(),
  gstin: z.string().trim().toUpperCase().regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/).optional(),
  pan: z.string().trim().toUpperCase().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/),
  sacCode: z.string().regex(/^[0-9]{6}$/).optional(),
  bankAccount: z.string().trim().regex(/^[0-9]{9,18}$/),
  ifsc: z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/),
  bankName: z.string().trim().min(2).max(120),
  branch: z.string().trim().min(2).max(120),
});
const BillingDecision = z.object({ decision: z.enum(['verified', 'rejected']), note: z.string().max(500).optional() });
const uploadLimits = { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function checkId(id: string) {
  if (!UUID.test(id)) throw new DomainError('NOT_FOUND', 404, 'Not found.');
  return id;
}

@Controller()
export class PartnersController {
  constructor(
    @Inject(RegistrationService) private readonly registration: RegistrationService,
    @Inject(KycService) private readonly kyc: KycService,
    @Inject(SettingsService) private readonly settings: SettingsService,
  ) {}

  @Requires('settings.view')
  @Get('partner')
  partner(@Req() req: AuthedRequest) {
    return this.settings.get(principalOf(req), tenantOf(req));
  }

  @Requires('settings.edit')
  @Patch('partner')
  updatePartner(@Body() body: unknown, @Req() req: AuthedRequest) {
    return this.settings.update(principalOf(req), tenantOf(req), parse(CompanyBody, body), metaOf(req));
  }

  @Requires('settings.edit')
  @Patch('partner/billing')
  saveBilling(@Body() body: unknown, @Req() req: AuthedRequest) {
    return this.settings.saveBilling(principalOf(req), tenantOf(req), parse(BillingBody, body), metaOf(req));
  }

  @Public()
  @Post('partners/register')
  @HttpCode(202)
  async register(@Body() body: unknown, @Req() req: AuthedRequest) {
    await this.registration.register(parse(RegisterBody, body), metaOf(req));
    return { accepted: true };
  }

  @Requires('kyc.manage')
  @Get('partner/agreement')
  agreement() {
    return this.kyc.agreement();
  }

  @Requires('kyc.manage')
  @Post('partner/agreement')
  @HttpCode(204)
  async acceptAgreement(@Body() body: unknown, @Req() req: AuthedRequest) {
    await this.kyc.acceptAgreement(principalOf(req), tenantOf(req), parse(AcceptBody, body).version, metaOf(req));
  }

  @Requires('kyc.manage')
  @Get('kyc')
  status(@Req() req: AuthedRequest) {
    return this.kyc.status(tenantOf(req));
  }

  @Requires('kyc.manage')
  @Post('kyc/documents/:type')
  @HttpCode(204)
  @UseInterceptors(FileInterceptor('file', uploadLimits))
  async upload(@Param('type') type: string, @UploadedFile() file: Upload | undefined, @Req() req: AuthedRequest) {
    if (!KYC_TYPES.includes(type as KycType)) throw new DomainError('NOT_FOUND', 404, 'Unknown document type.');
    await this.kyc.upload(principalOf(req), tenantOf(req), type as KycType, file, metaOf(req));
  }

  @Requires('kyc.manage')
  @Get('kyc/documents/:id/url')
  documentUrl(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.kyc.documentLink(tenantOf(req), checkId(id));
  }

  @Requires('kyc.manage')
  @Post('kyc/submit')
  @HttpCode(204)
  async submit(@Req() req: AuthedRequest) {
    await this.kyc.submit(principalOf(req), tenantOf(req), metaOf(req));
  }
}

@OpsOnly()
@Controller('ops')
export class OpsPartnersController {
  constructor(
    @Inject(OpsKycService) private readonly ops: OpsKycService,
    @Inject(SettingsService) private readonly settings: SettingsService,
  ) {}

  @Requires('kyc.review')
  @Get('partners/:id/billing')
  billing(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.settings.opsBilling(principalOf(req), checkId(id), metaOf(req));
  }

  @Requires('kyc.review')
  @Post('partners/:id/billing/decision')
  @HttpCode(204)
  async decideBilling(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    const input = parse(BillingDecision, body);
    await this.settings.decideBilling(principalOf(req), checkId(id), input.decision, input.note, metaOf(req));
  }

  @Requires('partners.view')
  @Get('partners')
  async list(@Query('kycStatus') kycStatus?: string) {
    return { data: await this.ops.list(kycStatus || undefined) };
  }

  @Requires('partners.view')
  @Get('partners/:id')
  get(@Param('id') id: string) {
    return this.ops.get(checkId(id));
  }

  @Requires('kyc.review')
  @Get('kyc/documents/:id/url')
  documentUrl(@Param('id') id: string) {
    return this.ops.documentLink(checkId(id));
  }

  @Requires('kyc.review')
  @Post('kyc/documents/:id/review')
  @HttpCode(204)
  async review(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    const input = parse(ReviewBody, body);
    await this.ops.reviewDocument(principalOf(req), checkId(id), input.decision, input.note, metaOf(req));
  }

  @Requires('kyc.review')
  @Post('partners/:id/kyc-decision')
  @HttpCode(204)
  async decide(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    await this.ops.decide(principalOf(req), checkId(id), parse(DecisionBody, body).decision, metaOf(req));
  }
}
