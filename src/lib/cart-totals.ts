import { divHalfUp } from './decimal';
import { pesewasTimesQty } from './money';

// Spec 6.6 for Phase 1a: no service charge, pack fee, promotions, or cart discount yet.
// Pure: the server and the device till (offline) run this same code, so their totals always agree.

export type CartLineInput = {
  unitPricePesewas: number; quantity: string; discountPesewas: number; labelPricePesewas?: number | null; taxRateBp: number;
};
export type CartLineTotals = { grossPesewas: number; discountPesewas: number; netPesewas: number; taxPesewas: number; totalPesewas: number };
export type CartTotals = { lines: CartLineTotals[]; subtotalPesewas: number; discountPesewas: number; taxPesewas: number; totalPesewas: number };

function money(value: number, what: string): bigint {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${what} must be whole pesewas: ${value}`);
  return BigInt(value);
}

/** Whole pesewas, rounded half up once per line. taxRateBp is the line's effective rate (1500 = 15%). */
export function calculateCartTotals(lines: CartLineInput[], opts: { taxMode: 'inclusive' | 'exclusive' }): CartTotals {
  const totals = lines.map((l): CartLineTotals => {
    const gross = l.labelPricePesewas != null
      ? money(l.labelPricePesewas, 'label price')
      : BigInt(pesewasTimesQty(Number(money(l.unitPricePesewas, 'unit price')), l.quantity));
    const discount = money(l.discountPesewas, 'discount');
    if (discount > gross) throw new RangeError(`discount ${discount} is above the line amount ${gross}`);
    const rate = money(l.taxRateBp, 'tax rate');
    const net = gross - discount;
    const tax = opts.taxMode === 'inclusive' ? net - divHalfUp(net * 10000n, 10000n + rate) : divHalfUp(net * rate, 10000n);
    const total = opts.taxMode === 'inclusive' ? net : net + tax;
    return {
      grossPesewas: Number(gross), discountPesewas: Number(discount), netPesewas: Number(net), taxPesewas: Number(tax), totalPesewas: Number(total),
    };
  });
  const sum = (key: keyof CartLineTotals) => totals.reduce((s, t) => s + t[key], 0);
  return {
    lines: totals, subtotalPesewas: sum('grossPesewas'), discountPesewas: sum('discountPesewas'), taxPesewas: sum('taxPesewas'), totalPesewas: sum('totalPesewas'),
  };
}
