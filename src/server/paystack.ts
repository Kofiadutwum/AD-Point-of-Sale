import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';

// The platform's own Paystack account: subscriptions only, never shop sales money (spec 5).

export type PaystackAuthorization = { authorization_code: string; reusable: boolean; last4?: string; brand?: string; channel?: string };
export type VerifiedTransaction = { status: string; reference: string; amount: number; currency: string; channel?: string; authorization?: PaystackAuthorization; customer?: { email?: string } };

export type Paystack = {
  initialize(input: { email: string; amountPesewas: number; reference: string; callbackUrl: string; metadata: Record<string, string> }): Promise<{ authorizationUrl: string }>;
  verify(reference: string): Promise<VerifiedTransaction>;
  chargeAuthorization(input: { authorizationCode: string; email: string; amountPesewas: number; reference: string }): Promise<{ status: string }>;
};

const secret = () => {
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) throw new Error('PAYSTACK_SECRET_KEY is not set');
  return key;
};

async function call<T>(key: string, path: string, init: { method: 'GET' | 'POST'; body?: unknown }): Promise<T> {
  const res = await fetch(`https://api.paystack.co${path}`, {
    method: init.method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(20_000),
  });
  const json = await res.json().catch(() => null) as { status?: boolean; message?: string; data?: T } | null;
  if (!res.ok || !json?.status || json.data === undefined) throw new Error(`paystack ${path}: ${json?.message ?? `HTTP ${res.status}`}`);
  return json.data;
}

/** Live client for a secret key: amounts are in pesewas (Paystack's subunit for GHS); card first, mobile money as the alternative. */
export const paystackWith = (key: () => string): Paystack => ({
  async initialize(i) {
    const d = await call<{ authorization_url: string }>(key(), '/transaction/initialize', {
      method: 'POST',
      body: { email: i.email, amount: i.amountPesewas, currency: 'GHS', reference: i.reference, callback_url: i.callbackUrl, channels: ['card', 'mobile_money'], metadata: i.metadata },
    });
    return { authorizationUrl: d.authorization_url };
  },
  verify: (reference) => call<VerifiedTransaction>(key(), `/transaction/verify/${encodeURIComponent(reference)}`, { method: 'GET' }),
  async chargeAuthorization(i) {
    const d = await call<{ status: string }>(key(), '/transaction/charge_authorization', {
      method: 'POST', body: { authorization_code: i.authorizationCode, email: i.email, amount: i.amountPesewas, currency: 'GHS', reference: i.reference },
    });
    return { status: d.status };
  },
});

/** The platform's account: subscriptions only. */
export const paystack: Paystack = paystackWith(secret);

/** Spec 6.11: HMAC-SHA512 of the raw body with the secret key, compared in constant time. */
export function validSignature(rawBody: Uint8Array, header: string | null, key = process.env.PAYSTACK_SECRET_KEY): boolean {
  if (!header || !key) return false;
  const expected = Buffer.from(createHmac('sha512', key).update(rawBody).digest('hex'));
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
