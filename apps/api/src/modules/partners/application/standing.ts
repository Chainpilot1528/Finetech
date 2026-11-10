import { DomainError } from '@vittora/shared-kernel';
import type { Tx } from '../../../platform/db.js';

export interface Standing {
  /** KYC approved: the partner may create cases. */
  mayTrade: boolean;
  /** KYC approved and bank and GST details verified: the partner may raise invoices (§4.7). */
  mayInvoice: boolean;
}

/**
 * The Partner module's answer to "may this partner trade?" (ARCH-05). Other modules ask here instead
 * of reading the partner tables. Runs in the caller's tenant transaction, so RLS scopes it.
 */
export async function standingOf(tx: Tx): Promise<Standing> {
  const { rows } = await tx.query(
    `SELECT p.kyc_status, b.verification_status FROM partner p LEFT JOIN partner_billing b ON b.partner_id = p.id`,
  );
  const kycApproved = rows[0]?.kyc_status === 'approved';
  return { mayTrade: kycApproved, mayInvoice: kycApproved && rows[0]?.verification_status === 'verified' };
}

export async function requireMayTrade(tx: Tx): Promise<void> {
  if (!(await standingOf(tx)).mayTrade) {
    throw new DomainError('KYC_NOT_APPROVED', 403, 'Your KYC must be approved before you can create cases.');
  }
}
