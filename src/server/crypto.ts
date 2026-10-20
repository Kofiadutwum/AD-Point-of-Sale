import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

// @node-rs/argon2 defaults to argon2id; these are the OWASP minimum settings.
const ARGON2 = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

export function hashSecret(secret: string): Promise<string> {
  return hash(secret, ARGON2);
}

export async function verifySecret(hashed: string, secret: string): Promise<boolean> {
  try {
    return await verify(hashed, secret);
  } catch {
    return false; // malformed hash
  }
}

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// verified against when an account does not exist, so a missing account and a wrong password take the same time
let dummyHash: Promise<string> | undefined;
export function dummySecretHash(): Promise<string> {
  dummyHash ??= hashSecret(newToken());
  return dummyHash;
}
