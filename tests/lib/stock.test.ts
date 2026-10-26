import { expect, it } from 'vitest';
import { unitCostOf, weightedAverageCost } from '@/lib/stock';

it('works out unit cost per base unit', () => {
  expect(unitCostOf(4500, '1000.000')).toBe('4.5000');
  expect(unitCostOf(1000, '3.000')).toBe('333.3333');
  expect(unitCostOf(0, '5.000')).toBe('0.0000');
});

it('updates the weighted average cost', () => {
  expect(weightedAverageCost('10.000', '400.0000', '10.000', '500.0000')).toBe('450.0000');
  expect(weightedAverageCost('0.000', '400.0000', '5.000', '500.0000')).toBe('500.0000');
  expect(weightedAverageCost('-2.000', '400.0000', '5.000', '500.0000')).toBe('500.0000');
  expect(weightedAverageCost('1.000', '1.0000', '2.000', '2.0000')).toBe('1.6667');
});
