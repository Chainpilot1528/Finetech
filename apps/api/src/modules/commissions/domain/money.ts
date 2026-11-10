import { Money } from '@vittora/shared-kernel';

/** All money is integer paise. Percentages are basis points. No floats touch an amount (§4.7). */
export function applyBps(paise: bigint, bps: number): bigint {
  // Round half up, in the shared Money type (ARCH-06).
  return Money.applyBps(Money.paise(paise), bps);
}

export interface Breakdown {
  gross: bigint;
  gst: bigint;
  tds: bigint;
  net: bigint;
}

/** GST is added when the partner is registered. TDS is withheld on the commission, not on the GST. */
export function breakdown(disbursal: bigint, rateBps: number, gstBps: number, tdsBps: number): Breakdown {
  const gross = applyBps(disbursal, rateBps);
  const gst = applyBps(gross, gstBps);
  const tds = applyBps(gross, tdsBps);
  return { gross, gst, tds, net: gross + gst - tds };
}

/** Indian financial year, April to March, in IST. 15 March 2027 is in 2026-27. */
export function financialYear(at: Date): string {
  const ist = new Date(at.getTime() + 330 * 60_000);
  const start = ist.getUTCMonth() >= 3 ? ist.getUTCFullYear() : ist.getUTCFullYear() - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

export const invoiceNumber = (fy: string, n: number) => `INV/${fy}/${String(n).padStart(6, '0')}`;
