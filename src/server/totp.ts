import 'server-only';
import { createHmac, randomBytes } from 'node:crypto';

// RFC 6238 TOTP with HMAC-SHA1, 6 digits, 30-second steps: what every authenticator app uses by default.
const STEP_SECONDS = 30;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; // RFC 4648 base32

function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return bits > 0 ? out + ALPHABET[(value << (5 - bits)) & 31] : out;
}

function base32Decode(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of text.replace(/=+$/, '').toUpperCase()) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error('invalid base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpStep(now: Date): number {
  return Math.floor(now.getTime() / 1000 / STEP_SECONDS);
}

export function totpAt(secret: string, step: number, digits = 6): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 15;
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(code).padStart(digits, '0');
}

/** The matched step within one step either side, or null. A step at or before lastStep never matches again. */
export function matchTotp(secret: string, code: string, now: Date, lastStep: number | null): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const step = totpStep(now);
  for (const s of [step - 1, step, step + 1]) {
    if (lastStep !== null && s <= lastStep) continue;
    if (totpAt(secret, s) === code) return s;
  }
  return null;
}

export function otpauthUri(secret: string, label: { issuer: string; account: string }): string {
  const issuer = encodeURIComponent(label.issuer);
  return `otpauth://totp/${issuer}:${encodeURIComponent(label.account)}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
}
