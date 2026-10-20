import { afterEach, expect, it, vi } from 'vitest';
import { openSecret, sealSecret } from '@/server/secret-box';
import { matchTotp, newTotpSecret, otpauthUri, totpAt, totpStep } from '@/server/totp';

afterEach(() => { vi.unstubAllEnvs(); });

const RFC = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // base32 of ASCII "12345678901234567890"

it('matches the RFC 6238 SHA-1 vectors', () => {
  expect([59, 1111111109, 1111111111, 1234567890, 2000000000].map((s) => totpAt(RFC, Math.floor(s / 30), 8)))
    .toEqual(['94287082', '07081804', '14050471', '89005924', '69279037']);
});

it('accepts one step either side and never the same step twice', () => {
  const now = new Date(1234567890_000);
  const step = totpStep(now);
  expect(matchTotp(RFC, totpAt(RFC, step - 1), now, null)).toBe(step - 1);
  expect(matchTotp(RFC, totpAt(RFC, step + 1), now, null)).toBe(step + 1);
  expect(matchTotp(RFC, totpAt(RFC, step - 2), now, null)).toBeNull();
  expect(matchTotp(RFC, totpAt(RFC, step), now, step)).toBeNull();
  expect(matchTotp(RFC, 'abcdef', now, null)).toBeNull();
});

it('makes 32-character base32 secrets and an otpauth link', () => {
  const s = newTotpSecret();
  expect(s).toMatch(/^[A-Z2-7]{32}$/);
  expect(otpauthUri(s, { issuer: 'Multi-Shop POS', account: 'ama@x.test' }))
    .toBe(`otpauth://totp/Multi-Shop%20POS:ama%40x.test?secret=${s}&issuer=Multi-Shop%20POS&algorithm=SHA1&digits=6&period=30`);
});

it('seals and opens a secret, and refuses a tampered one', () => {
  const sealed = sealSecret(RFC);
  expect(sealed).not.toContain(RFC);
  expect(openSecret(sealed)).toBe(RFC);
  const flipped = sealed.slice(0, -2) + (sealed.at(-2) === 'A' ? 'B' : 'A') + sealed.at(-1);
  expect(openSecret(flipped)).toBeNull();
  expect(openSecret('garbage')).toBeNull();
});

it('requires MFA_SECRET_KEY in production', () => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('MFA_SECRET_KEY', '');
  expect(() => sealSecret('x')).toThrow(/MFA_SECRET_KEY/);
});
