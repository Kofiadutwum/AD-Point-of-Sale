import { expect, it } from 'vitest';
import { cashRounding } from '@/lib/cash-rounding';

it('rounds the cash part to the step, half up', () => {
  expect(cashRounding(997, 0, true, 10)).toBe(3); // 9.97 → 10.00
  expect(cashRounding(994, 0, true, 10)).toBe(-4); // 9.94 → 9.90
  expect(cashRounding(995, 0, true, 10)).toBe(5); // half up
  expect(cashRounding(1997, 1000, true, 10)).toBe(3); // only what cash pays
  expect(cashRounding(1012, 0, true, 5)).toBe(-2);
  expect(cashRounding(1050, 0, true, 100)).toBe(50);
});

it('no rounding without cash or when off', () => {
  expect(cashRounding(997, 997, false, 10)).toBe(0);
  expect(cashRounding(997, 0, true, 0)).toBe(0);
  expect(cashRounding(1000, 0, true, 10)).toBe(0);
});
