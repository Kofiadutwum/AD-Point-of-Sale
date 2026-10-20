import { expect, it } from 'vitest';
import { normaliseSlug, validateSlug } from '@/lib/slug';

it('turns shop names into slugs', () => {
  expect(normaliseSlug("  Ama's Shop!! ")).toBe('amas-shop');
  expect(normaliseSlug('Kofi  &  Sons Provisions')).toBe('kofi-sons-provisions');
});

it('validates length, characters, and reserved words', () => {
  expect(validateSlug('ab')).toBe('too_short');
  expect(validateSlug('a'.repeat(41))).toBe('too_long');
  expect(validateSlug('shop--x')).toBe('invalid_chars');
  expect(validateSlug('-shop')).toBe('invalid_chars');
  expect(validateSlug('admin')).toBe('reserved');
  expect(validateSlug('activate')).toBe('reserved');
  expect(validateSlug('kofi-provisions')).toBe('ok');
});
