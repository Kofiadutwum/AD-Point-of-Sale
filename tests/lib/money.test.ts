import { expect, it } from 'vitest';
import { parseCedis, pesewasTimesQty } from '@/lib/money';

it('parses cedi amounts into whole pesewas', () => {
  expect(parseCedis('250')).toBe(25000);
  expect(parseCedis('250.5')).toBe(25050);
  expect(parseCedis('250.50')).toBe(25050);
  expect(parseCedis('1,250.00')).toBe(125000);
  expect(parseCedis(' 0.07 ')).toBe(7);
});

it('rejects anything that is not a plain positive amount with up to 2 decimals', () => {
  for (const bad of ['250.505', '-1', 'abc', '', '1.2.3', '1e3']) expect(parseCedis(bad)).toBeNull();
});

it('prices a quantity in whole pesewas, rounding half up', () => {
  expect(pesewasTimesQty(500, '24.000')).toBe(12000);
  expect(pesewasTimesQty(1999, '0.250')).toBe(500); // 499.75
  expect(pesewasTimesQty(1, '0.500')).toBe(1);
});
