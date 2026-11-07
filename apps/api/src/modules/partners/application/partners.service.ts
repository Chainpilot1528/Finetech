import { Inject, Injectable } from '@nestjs/common';
import type { Db, TenantContext } from '../../../platform/db.js';
import { DB } from '../../../platform/tokens.js';

export interface PartnerView {
  id: string;
  refCode: string;
  channelName: string;
  legalName: string;
  status: string;
  kycStatus: string;
}

@Injectable()
export class PartnersService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async get(ctx: TenantContext): Promise<PartnerView | null> {
    return this.db.withTenant(ctx, async (tx) => {
      const { rows } = await tx.query(
        `SELECT id, ref_code AS "refCode", channel_name AS "channelName", legal_name AS "legalName",
                status, kyc_status AS "kycStatus" FROM partner`,
      );
      return rows[0] ?? null;
    });
  }
}
