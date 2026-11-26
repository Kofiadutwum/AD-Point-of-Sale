import { createHash, createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { processedEvents, signupVerifications, subscriptionCheckouts, subscriptionPayments, subscriptions, users } from '@/db/schema';
import { asPlatform } from '@/db/tenant';
import { applyReference, billingOverview, cancelAutoRenew, handleWebhook, runBillingJob, startCheckout } from '@/server/billing';
import type { Ctx } from '@/server/context';
import type { Paystack, VerifiedTransaction } from '@/server/paystack';
import { completeSignup, startSignup } from '@/server/signup';
import { ctxFor, type SeededShop, seedShop } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

const t0 = new Date('2026-11-26T09:00:00Z');
const KEY = 'sk_test_fake';
beforeAll(() => { process.env.PAYSTACK_SECRET_KEY = KEY; });
let db: Db;
let close: () => Promise<void>;
let shop: SeededShop;
let owner: Ctx;

/** A fake Paystack: verify answers from `results`; charges are recorded. */
function fakePaystack(results: Record<string, Partial<VerifiedTransaction>> = {}) {
  const charges: string[] = [];
  const client: Paystack = {
    initialize: async (i) => ({ authorizationUrl: `https://checkout.paystack.test/${i.reference}` }),
    verify: async (reference) => ({ status: 'success', reference, amount: 360000, currency: 'GHS', ...results[reference] } as VerifiedTransaction),
    chargeAuthorization: async (i) => { charges.push(i.reference); return { status: 'success' }; },
  };
  return { client, charges, results };
}
const sub = async () => (await asPlatform(db, (tx) => tx.select().from(subscriptions).where(eq(subscriptions.tenantId, shop.tenantId))))[0];
const payments = () => asPlatform(db, (tx) => tx.select().from(subscriptionPayments));

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  shop = await seedShop(db, { subscription: { status: 'active', endDate: '2026-12-10' } });
  owner = await ctxFor(db, shop, 'owner', t0);
});
afterEach(async () => { await close(); });

it('extends a year only after Paystack confirms the payment, once per reference', async () => {
  const p = fakePaystack();
  expect(await startCheckout(db, owner, { planId: 'enterprise', autoRenew: false }, t0, p.client)).toEqual({ ok: false, error: 'invalid_plan' });
  const c = await startCheckout(db, owner, { planId: 'standard', autoRenew: false }, t0, p.client) as { reference: string; authorizationUrl: string };
  expect(c.authorizationUrl).toContain(c.reference);
  expect((await sub()).endDate).toBe('2026-12-10'); // nothing until verified
  p.results[c.reference] = { status: 'ongoing' };
  expect(await applyReference(db, c.reference, t0, p.client)).toBe('pending');
  p.results[c.reference] = {};
  expect(await applyReference(db, c.reference, t0, p.client)).toBe('applied');
  expect(await sub()).toMatchObject({ endDate: '2027-12-10', status: 'active', planId: 'standard', autoRenew: false });
  expect(await applyReference(db, c.reference, t0, p.client)).toBe('already');
  expect(await payments()).toHaveLength(1);
  expect((await billingOverview(db, owner, t0)).payments[0]).toMatchObject({ method: 'paystack', amountPesewas: 360000 });
});

it('refuses a payment for the wrong amount', async () => {
  const p = fakePaystack();
  const c = await startCheckout(db, owner, { planId: 'standard', autoRenew: false }, t0, p.client) as { reference: string };
  p.results[c.reference] = { amount: 100 };
  expect(await applyReference(db, c.reference, t0, p.client)).toBe('mismatch');
  expect((await sub()).endDate).toBe('2026-12-10');
});

it('webhooks need a valid signature and a redelivery changes nothing', async () => {
  const p = fakePaystack();
  const c = await startCheckout(db, owner, { planId: 'standard', autoRenew: false }, t0, p.client) as { reference: string };
  const body = new TextEncoder().encode(JSON.stringify({ event: 'charge.success', data: { reference: c.reference } }));
  const sig = createHmac('sha512', KEY).update(body).digest('hex');
  expect(await handleWebhook(db, body, 'forged', t0, p.client)).toEqual({ status: 401 });
  expect(await handleWebhook(db, body, sig, t0, p.client)).toEqual({ status: 200 });
  expect(await handleWebhook(db, body, sig, t0, p.client)).toEqual({ status: 200 });
  expect(await payments()).toHaveLength(1);
  expect((await sub()).endDate).toBe('2027-12-10');
});

it('card renewal: consent and card saved, reminders, a charge on the end date, a notice when it fails', async () => {
  const p = fakePaystack();
  const c = await startCheckout(db, owner, { planId: 'standard', autoRenew: true }, t0, p.client) as { reference: string };
  const [row] = await asPlatform(db, (tx) => tx.select().from(subscriptionCheckouts).where(eq(subscriptionCheckouts.reference, c.reference)));
  expect(row.consentText).toContain('GHS 3,600.00');
  p.results[c.reference] = { authorization: { authorization_code: 'AUTH_x1', reusable: true, last4: '4081', brand: 'visa' }, customer: { email: 'card@x.test' } };
  await applyReference(db, c.reference, t0, p.client);
  const s = await sub();
  expect(s).toMatchObject({ autoRenew: true, cardLabel: 'visa ending 4081', billingEmail: 'card@x.test', endDate: '2027-12-10' });
  expect(s.authorizationCode).not.toContain('AUTH_x1'); // sealed

  expect(await runBillingJob(db, new Date('2027-11-10T09:00:00Z'), p.client)).toEqual({ notices: 1, renewals: 0 }); // 30 days before
  expect(await runBillingJob(db, new Date('2027-11-10T15:00:00Z'), p.client)).toEqual({ notices: 0, renewals: 0 }); // not twice
  expect(await runBillingJob(db, new Date('2027-12-10T09:00:00Z'), p.client)).toMatchObject({ renewals: 1 });
  expect(p.charges).toHaveLength(1);
  expect(await sub()).toMatchObject({ endDate: '2028-12-10', autoRenew: true });

  const failing = fakePaystack();
  failing.client.verify = async (reference) => ({ status: 'failed', reference, amount: 360000, currency: 'GHS' });
  expect(await runBillingJob(db, new Date('2028-12-10T09:00:00Z'), failing.client)).toMatchObject({ renewals: 1 });
  expect((await sub()).endDate).toBe('2028-12-10');
  const notices = await asPlatform(db, (tx) => tx.select().from(processedEvents).where(eq(processedEvents.provider, 'notice')));
  expect(notices.some((n) => n.eventType.startsWith('renewal-failed:'))).toBe(true);
  expect(await runBillingJob(db, new Date('2028-12-10T15:00:00Z'), failing.client)).toMatchObject({ renewals: 0 }); // one attempt per end date

  await cancelAutoRenew(db, owner);
  expect(await sub()).toMatchObject({ autoRenew: false, authorizationCode: null });
});

it('trial reminders 3 days and 1 day before the end, and a notice after it ends', async () => {
  await asPlatform(db, (tx) => tx.update(subscriptions).set({ status: 'trial', planId: 'trial', endDate: '2026-11-29' }).where(eq(subscriptions.tenantId, shop.tenantId)));
  const p = fakePaystack();
  expect((await runBillingJob(db, t0, p.client)).notices).toBe(1);
  expect((await runBillingJob(db, new Date('2026-11-28T09:00:00Z'), p.client)).notices).toBe(1);
  expect((await runBillingJob(db, new Date('2026-11-30T09:00:00Z'), p.client)).notices).toBe(1);
});

it('self sign-up needs both codes, then opens a 14-day trial with the owner signed up', async () => {
  const sent: string[] = [];
  const input = { shopName: 'Ama Provisions', slug: 'ama-provisions', shopType: 'retail', ownerName: 'Ama', email: 'ama@signup.test', phone: '0244000123' };
  expect(await startSignup(db, { ...input, slug: shop.slug }, '1.2.3.4', t0, async () => {})).toEqual({ ok: false, error: 'slug_unavailable' });
  const s = await startSignup(db, input, '1.2.3.4', t0, async (_to, text) => { sent.push(text); }) as { id: string };
  const smsCode = sent[0].match(/\d{6}/)![0];
  expect(await completeSignup(db, { id: s.id, smsCode, emailCode: '000000', password: 'long-enough-pass' }, t0)).toEqual({ ok: false, error: 'wrong_code' });
  expect(await completeSignup(db, { id: s.id, smsCode, emailCode: '000000', password: 'short' }, t0)).toEqual({ ok: false, error: 'weak_password' });
  // the email code only goes to the inbox; set a known one to finish the flow
  await asPlatform(db, (tx) => tx.update(signupVerifications).set({ emailCodeHash: createHash('sha256').update(`${s.id}:123456`).digest('hex') }).where(eq(signupVerifications.id, s.id)));
  expect(await completeSignup(db, { id: s.id, smsCode, emailCode: '123456', password: 'long-enough-pass' }, t0)).toEqual({ ok: true, slug: 'ama-provisions' });
  expect(await completeSignup(db, { id: s.id, smsCode, emailCode: '123456', password: 'long-enough-pass' }, t0)).toEqual({ ok: false, error: 'expired' }); // used
  const [u] = await asPlatform(db, (tx) => tx.select().from(users).where(eq(users.email, 'ama@signup.test')));
  expect(u).toMatchObject({ status: 'active', rolePreset: 'owner', phone: '233244000123' });
});
