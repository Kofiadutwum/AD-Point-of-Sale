import { expect, it } from 'vitest';
import { calculateCartTotals, type CartLineInput } from '@/lib/cart-totals';

const line = (unitPricePesewas: number, quantity: string, extra: Partial<CartLineInput> = {}): CartLineInput =>
  ({ unitPricePesewas, quantity, discountPesewas: 0, taxRateBp: 0, ...extra });

it('takes tax out of inclusive prices', () => {
  const t = calculateCartTotals([line(1150, '2.000', { taxRateBp: 1500 })], { taxMode: 'inclusive' });
  expect(t).toMatchObject({ subtotalPesewas: 2300, taxPesewas: 300, totalPesewas: 2300 });
  expect(calculateCartTotals([line(999, '1.000', { taxRateBp: 1500 })], { taxMode: 'inclusive' }).taxPesewas).toBe(130);
});

it('adds tax to exclusive prices after the discount', () => {
  const t = calculateCartTotals([line(1000, '1.000', { taxRateBp: 1500, discountPesewas: 100 })], { taxMode: 'exclusive' });
  expect(t.lines[0]).toEqual({ grossPesewas: 1000, discountPesewas: 100, netPesewas: 900, taxPesewas: 135, totalPesewas: 1035 });
  expect(t).toMatchObject({ subtotalPesewas: 1000, discountPesewas: 100, taxPesewas: 135, totalPesewas: 1035 });
});

it('rounds half up once per line', () => {
  const t = calculateCartTotals([line(1999, '0.250'), line(333, '1.500')], { taxMode: 'exclusive' });
  expect(t.lines.map((l) => l.grossPesewas)).toEqual([500, 500]);
});

it('uses a label price as the gross', () => {
  expect(calculateCartTotals([line(1999, '0.500', { labelPricePesewas: 1000 })], { taxMode: 'inclusive' }).totalPesewas).toBe(1000);
});

it('spreads a cart discount by line amount, leftover to the largest line', () => {
  const t = calculateCartTotals([line(1000, '1.000'), line(500, '1.000')], { taxMode: 'inclusive', cartDiscountPesewas: 100 });
  expect(t.lines.map((l) => l.discountPesewas)).toEqual([67, 33]);
  expect(t).toMatchObject({ subtotalPesewas: 1500, discountPesewas: 100, totalPesewas: 1400 });
});

it('handles an empty cart', () => {
  expect(calculateCartTotals([], { taxMode: 'inclusive', cartDiscountPesewas: 0 }))
    .toEqual({ lines: [], subtotalPesewas: 0, discountPesewas: 0, taxPesewas: 0, totalPesewas: 0 });
});

it('refuses discounts above the amount', () => {
  expect(() => calculateCartTotals([line(100, '1.000', { discountPesewas: 101 })], { taxMode: 'inclusive' })).toThrow(RangeError);
  expect(() => calculateCartTotals([line(100, '1.000')], { taxMode: 'inclusive', cartDiscountPesewas: 101 })).toThrow(RangeError);
});
