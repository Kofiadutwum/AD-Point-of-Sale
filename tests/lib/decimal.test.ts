import { expect, it } from 'vitest';
import { multiplyQty, parseQuantity, ratioToQty, rollUpCost, validSaleQuantity } from '@/lib/decimal';

it('parses quantities to 3 decimal places', () => {
  expect(parseQuantity('1.25')).toBe('1.250');
  expect(parseQuantity(' 2 ')).toBe('2.000');
  for (const bad of ['0.0005', '-1', '1e3', '1,5', '', '100000000000']) expect(parseQuantity(bad), bad).toBeNull();
});

it('converts units to base units exactly', () => {
  expect(multiplyQty('1.000', '24.000')).toBe('24.000'); // 1 carton = 24 pieces
  expect(multiplyQty('1.000', '10.000')).toBe('10.000'); // 1 strip = 10 tablets
  expect(multiplyQty('0.333', '1.500')).toBe('0.500'); // 0.4995 rounds half up
});

it('divides into a quantity, rounding half up', () => {
  expect(ratioToQty(2n, 3n)).toBe('0.667');
  expect(ratioToQty(1n, 2000n)).toBe('0.001');
});

it('checks sale quantities', () => {
  expect(validSaleQuantity('1.250', true)).toBe(true);
  expect(validSaleQuantity('1.250', false)).toBe(false);
  expect(validSaleQuantity('0.000', true)).toBe(false);
  expect(validSaleQuantity(null, true)).toBe(false);
});

it('rolls up component costs to 4 places', () => {
  expect(rollUpCost([{ quantity: '0.250', cost: '1200.0000' }, { quantity: '0.050', cost: '3000.0000' }, { quantity: '1.000', cost: '1500.0000' }])).toBe('1950.0000');
  expect(rollUpCost([{ quantity: '3.000', cost: '416.6667' }])).toBe('1250.0001');
});
