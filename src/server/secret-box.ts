import 'server-only';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

// AES-256-GCM for secrets the server must read back (TOTP secrets), so a database dump alone does not reveal them.

function key(): Buffer {
  const raw = process.env.MFA_SECRET_KEY;
  if (raw) {
    const k = Buffer.from(raw, 'base64');
    if (k.length !== 32) throw new Error('MFA_SECRET_KEY must be 32 bytes, base64');
    return k;
  }
  if (process.env.NODE_ENV === 'production') throw new Error('MFA_SECRET_KEY is not set');
  return createHash('sha256').update('multishop-pos-dev-mfa-key').digest(); // shortcut: dev-only key, set MFA_SECRET_KEY before launch
}

export function sealSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `v1.${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')}`;
}

export function openSecret(sealed: string): string | null {
  if (!sealed.startsWith('v1.')) return null;
  const raw = Buffer.from(sealed.slice(3), 'base64url');
  if (raw.length < 29) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
