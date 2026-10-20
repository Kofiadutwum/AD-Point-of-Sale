import { expect, it } from 'vitest';
import { type CartLineInput, calculateCartTotals } from '@/lib/cart-totals';

const line = (o: Partial<CartLineInput> = {}): CartLineInput => ({ unitPricePesewas: 500, quantity: '1.000', discountPesewas: 0, taxRateBp: 0, ...o });

it('rounds price × quantity half up once per line', () => {
  expect(calculateCartTotals([line({ unitPricePesewas: 1999, quantity: '0.250' })], { taxMode: 'exclusive' }).lines[0].grossPesewas).toBe(500);
});

it('uses the scale label price instead of price × quantity', () => {
  expect(calculateCartTotals([line({ quantity: '0.333', labelPricePesewas: 170 })], { taxMode: 'exclusive' }).totalPesewas).toBe(170);
});

it('adds tax on top in exclusive mode', () => {
  expect(calculateCartTotals([line({ unitPricePesewas: 2000, discountPesewas: 500, taxRateBp: 1500 })], { taxMode: 'exclusive' })).toEqual({
    lines: [{ grossPesewas: 2000, discountPesewas: 500, netPesewas: 1500, taxPesewas: 225, totalPesewas: 1725 }],
    subtotalPesewas: 2000, discountPesewas: 500, taxPesewas: 225, totalPesewas: 1725,
  });
});

it('takes tax out of the price in inclusive mode', () => {
  expect(calculateCartTotals([line({ unitPricePesewas: 1150, taxRateBp: 1500 })], { taxMode: 'inclusive' }).lines[0])
    .toMatchObject({ taxPesewas: 150, totalPesewas: 1150 });
  expect(calculateCartTotals([line({ unitPricePesewas: 1000, taxRateBp: 1500 })], { taxMode: 'inclusive' }).lines[0].taxPesewas).toBe(130);
});

it('sums lines and handles an empty cart', () => {
  const t = calculateCartTotals([line({ unitPricePesewas: 2500, quantity: '2.000', taxRateBp: 1500 }), line({ unitPricePesewas: 300 })], { taxMode: 'exclusive' });
  expect(t).toMatchObject({ subtotalPesewas: 5300, discountPesewas: 0, taxPesewas: 750, totalPesewas: 6050 });
  expect(calculateCartTotals([], { taxMode: 'inclusive' })).toEqual({ lines: [], subtotalPesewas: 0, discountPesewas: 0, taxPesewas: 0, totalPesewas: 0 });
});

it('refuses a discount above the line amount and non-integer money', () => {
  expect(() => calculateCartTotals([line({ discountPesewas: 501 })], { taxMode: 'exclusive' })).toThrow(RangeError);
  expect(() => calculateCartTotals([line({ unitPricePesewas: 1.5 })], { taxMode: 'exclusive' })).toThrow(RangeError);
  expect(() => calculateCartTotals([line({ discountPesewas: -1 })], { taxMode: 'exclusive' })).toThrow(RangeError);
});
