import { Money } from '@vittora/shared-kernel';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { breakdown } from '../src/modules/commissions/domain/money.js';

const paise = fc.bigInt({ min: 0n, max: 10n ** 13n }).map((v) => Money.paise(v));
const bps = fc.integer({ min: 0, max: 10_000 });

describe('Money (ARCH-06)', () => {
  it('converts whole rupees only', () => {
    expect(Money.fromRupees(400000)).toBe(40000000n);
    expect(() => Money.fromRupees(10.5)).toThrow(/whole rupees/);
    expect(() => Money.fromRupees(Number.MAX_SAFE_INTEGER + 2)).toThrow();
  });

  it('formats with Indian grouping', () => {
    expect(Money.format(Money.paise(12345678))).toBe('₹1,23,456.78');
    expect(Money.format(Money.paise(5))).toBe('₹0.05');
    expect(Money.format(Money.paise(-100000))).toBe('-₹1,000.00');
  });

  it('rounds a percentage half up, never more than half a paisa away', () => {
    fc.assert(fc.property(paise, bps, (amount, rate) => {
      const exact = Number(amount) * rate / 10_000;
      const got = Number(Money.applyBps(amount, rate));
      return Math.abs(got - exact) <= 0.5 + 1e-6 * Math.max(1, exact);
    }));
  });

  it('is monotonic: a bigger amount never earns less', () => {
    fc.assert(fc.property(paise, paise, bps, (a, b, rate) => {
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      return Money.applyBps(lo, rate) <= Money.applyBps(hi, rate);
    }));
  });

  it('a commission breakdown always adds up exactly', () => {
    fc.assert(fc.property(paise, bps, fc.constantFrom(0, 1800), fc.constantFrom(0, 200, 500), (amount, rate, gst, tds) => {
      const b = breakdown(amount, rate, gst, tds);
      return b.net === b.gross + b.gst - b.tds && b.gross >= 0n && b.tds <= b.gross;
    }));
  });
});
