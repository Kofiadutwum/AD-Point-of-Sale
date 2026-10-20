import { expect, it } from 'vitest';
import { parseCedis } from '@/lib/money';

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

it('rejects amounts too large to count exactly in pesewas', () => {
  expect(parseCedis('99999999999999999999')).toBeNull();
  expect(parseCedis('90071992547409.92')).toBeNull();
});
