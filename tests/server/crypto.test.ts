import { expect, it } from 'vitest';
import { hashSecret, newToken, tokenHash, verifySecret } from '@/server/crypto';

it('hashes secrets with argon2id and verifies them', async () => {
  const h = await hashSecret('1234');
  expect(h).toMatch(/^\$argon2id\$/);
  expect(await verifySecret(h, '1234')).toBe(true);
  expect(await verifySecret(h, '1235')).toBe(false);
});

it('makes 32-byte url-safe tokens and sha256 hashes', () => {
  expect(newToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(tokenHash('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
