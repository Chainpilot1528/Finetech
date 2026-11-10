import { DomainError } from './errors.js';

/**
 * Money is integer paise, always (§4.7, ARCH-06). A branded bigint, so a plain number or a rupee
 * amount can't be passed where paise are expected, and no float ever touches an amount.
 */
export type Paise = bigint & { readonly __unit: 'paise' };

export const Money = {
  /** Whole rupees from a form or API body. Refuses fractions and amounts beyond safe integers. */
  fromRupees(rupees: number | bigint): Paise {
    if (typeof rupees === 'number' && (!Number.isSafeInteger(rupees))) {
      throw new DomainError('VALIDATION_FAILED', 422, 'Amounts must be whole rupees.');
    }
    return (BigInt(rupees) * 100n) as Paise;
  },

  /** A value already in paise, such as a database column. */
  paise(value: bigint | string | number): Paise {
    if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new RangeError('paise must be an integer');
    return BigInt(value) as Paise;
  },

  zero: 0n as Paise,

  add(...values: Paise[]): Paise {
    return values.reduce<bigint>((a, b) => a + b, 0n) as Paise;
  },

  sub(a: Paise, b: Paise): Paise {
    return (a - b) as Paise;
  },

  /** A percentage in basis points, rounded half up to the nearest paisa. */
  applyBps(amount: Paise, bps: number): Paise {
    if (!Number.isInteger(bps) || bps < 0) throw new RangeError('basis points must be a non-negative integer');
    return ((amount * BigInt(bps) + 5_000n) / 10_000n) as Paise;
  },

  /** ₹1,23,456.78 with Indian digit grouping. For screens and documents, never for maths. */
  format(amount: Paise): string {
    const negative = amount < 0n;
    const abs = negative ? -amount : amount;
    const rupees = (abs / 100n).toString();
    const paise = (abs % 100n).toString().padStart(2, '0');
    const last3 = rupees.slice(-3);
    const rest = rupees.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
    return `${negative ? '-' : ''}₹${rest ? `${rest},${last3}` : last3}.${paise}`;
  },
};
