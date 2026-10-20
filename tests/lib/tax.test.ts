import { expect, it } from 'vitest';
import { chooseTaxRule, effectiveRateBp, parsePercent } from '@/lib/tax';

// example rates only; real rates are entered by each shop
const levies = [{ name: 'NHIL', rateBp: 250 }, { name: 'GETFund', rateBp: 250 }, { name: 'COVID-19', rateBp: 100 }];

it('works out the effective rate in basis points', () => {
  expect(effectiveRateBp({ rateBp: 1500, levies: [], vatOnLevies: false })).toBe(1500);
  expect(effectiveRateBp({ rateBp: 1500, levies, vatOnLevies: false })).toBe(2100);
  expect(effectiveRateBp({ rateBp: 1500, levies, vatOnLevies: true })).toBe(2190);
});

it('parses percentages to basis points', () => {
  expect(parsePercent('15')).toBe(1500);
  expect(parsePercent('2.5')).toBe(250);
  for (const bad of ['12.345', '101', '-1', 'abc', '']) expect(parsePercent(bad), bad).toBeNull();
});

it('uses the product rule, then the shop default, and nothing when tax is off', () => {
  const rules = [{ id: 'vat', isDefault: true }, { id: 'exempt', isDefault: false }];
  expect(chooseTaxRule(true, 'exempt', rules)?.id).toBe('exempt');
  expect(chooseTaxRule(true, null, rules)?.id).toBe('vat');
  expect(chooseTaxRule(false, 'exempt', rules)).toBeNull();
});
