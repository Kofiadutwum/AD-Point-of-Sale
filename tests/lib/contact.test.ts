import { expect, it } from 'vitest';
import { normaliseEmail, normaliseGhanaPhone } from '@/lib/contact';

it('normalises every common Ghana phone format to 233XXXXXXXXX', () => {
  for (const input of ['024 123 4567', '+233 24 123 4567', '0241234567', '233241234567', '(024) 123-4567'])
    expect(normaliseGhanaPhone(input)).toBe('233241234567');
});

it('rejects phone numbers of the wrong length', () => {
  expect(normaliseGhanaPhone('12345')).toBeNull();
  expect(normaliseGhanaPhone('02412345678')).toBeNull();
});

it('trims and lowercases emails and rejects malformed ones', () => {
  expect(normaliseEmail('  Ama@Shop.COM ')).toBe('ama@shop.com');
  expect(normaliseEmail('ama')).toBeNull();
  expect(normaliseEmail('ama@shop')).toBeNull();
});

it('accepts international prefixes written with 00 or a bracketed trunk 0', () => {
  for (const input of ['00233 24 123 4567', '+233 (0)24 123 4567', '00233 (0) 24 123 4567'])
    expect(normaliseGhanaPhone(input)).toBe('233241234567');
});
