import { divHalfUp } from './decimal';
import { pesewasTimesQty } from './money';

// Spec 6.6. Whole pesewas only; every rounding is half up, once per line. Shared with the device (Plan 4), so no server imports.

export type CartLineInput = {
  unitPricePesewas: number; quantity: string; discountPesewas: number;
  labelPricePesewas?: number | null; // a price-carrying scale label sets the line amount itself
  taxRateBp: number; // effectiveRateBp of the line's tax rule; 0 = no tax
};
export type CartLineTotals = { grossPesewas: number; discountPesewas: number; netPesewas: number; taxPesewas: number; totalPesewas: number };
export type CartTotals = { lines: CartLineTotals[]; subtotalPesewas: number; discountPesewas: number; taxPesewas: number; totalPesewas: number };

const round = (n: bigint, d: bigint) => Number(divHalfUp(n, d));

/** Throws RangeError when a discount exceeds the amount it applies to; callers validate first. */
export function calculateCartTotals(lines: CartLineInput[], opts: { taxMode: 'inclusive' | 'exclusive'; cartDiscountPesewas?: number }): CartTotals {
  const gross = lines.map((l) => l.labelPricePesewas ?? pesewasTimesQty(l.unitPricePesewas, l.quantity));
  const subtotal = gross.reduce((a, b) => a + b, 0);
  const cartDiscount = opts.cartDiscountPesewas ?? 0;
  if (cartDiscount < 0 || cartDiscount > subtotal) throw new RangeError('cart discount above the subtotal');

  // spread the cart discount in proportion to gross; leftover pesewas go to the largest line (the first on a tie)
  const share = gross.map((g) => (subtotal === 0 ? 0 : Number((BigInt(cartDiscount) * BigInt(g)) / BigInt(subtotal))));
  const leftover = cartDiscount - share.reduce((a, b) => a + b, 0);
  if (leftover > 0) share[gross.indexOf(Math.max(...gross))] += leftover;

  const out = lines.map((l, i): CartLineTotals => {
    const discount = l.discountPesewas + share[i];
    if (l.discountPesewas < 0 || discount > gross[i]) throw new RangeError(`discount above the amount on line ${i}`);
    const net = gross[i] - discount;
    const rate = BigInt(l.taxRateBp);
    const tax = opts.taxMode === 'inclusive'
      ? net - round(BigInt(net) * 10000n, 10000n + rate)
      : round(BigInt(net) * rate, 10000n);
    return { grossPesewas: gross[i], discountPesewas: discount, netPesewas: net, taxPesewas: tax, totalPesewas: opts.taxMode === 'inclusive' ? net : net + tax };
  });
  const sum = (k: keyof CartLineTotals) => out.reduce((a, l) => a + l[k], 0);
  return { lines: out, subtotalPesewas: subtotal, discountPesewas: sum('discountPesewas'), taxPesewas: sum('taxPesewas'), totalPesewas: sum('totalPesewas') };
}
