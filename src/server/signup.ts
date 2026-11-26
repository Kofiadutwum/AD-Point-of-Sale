import 'server-only';
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { signupVerifications, tenants } from '@/db/schema';
import { asPlatform } from '@/db/tenant';
import { normaliseEmail, normaliseGhanaPhone } from '@/lib/contact';
import { SHOP_TYPES, type ShopType } from '@/lib/permissions';
import { normaliseSlug, validateSlug } from '@/lib/slug';
import { sendEmail } from './email';
import { activateAccount, appName, MIN_PASSWORD_LENGTH, onboardShop } from './onboarding';
import { type Fail, fail, isUuid } from './products';
import { countFailedAttempt, tooManyAttempts } from './rate-limit';
import type { SendSms } from './sms';

const CODE_MINUTES = 30;
const MAX_CODE_TRIES = 5;
const hash = (id: string, code: string) => createHash('sha256').update(`${id}:${code}`).digest('hex');
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

export type SignupInput = { shopName: string; slug: string; shopType: string; ownerName: string; email: string; phone: string };

/** Spec 4.27, 6.48: a free trial by self sign-up; one code goes to the phone and one to the email, and both must come back. */
export async function startSignup(db: Db, input: SignupInput, ip: string, now: Date, sms: SendSms): Promise<
  { ok: true; id: string } | Fail<'invalid_input' | 'slug_unavailable' | 'invalid_email' | 'invalid_phone' | 'try_again_later'>
> {
  const shopName = input.shopName?.trim() ?? '';
  const ownerName = input.ownerName?.trim() ?? '';
  if (!shopName || shopName.length > 100 || !ownerName || ownerName.length > 100 || !SHOP_TYPES.includes(input.shopType as ShopType)) return fail('invalid_input');
  const email = normaliseEmail(input.email ?? '');
  if (!email) return fail('invalid_email');
  const phone = normaliseGhanaPhone(input.phone ?? '');
  if (!phone) return fail('invalid_phone');
  const slug = normaliseSlug(input.slug ?? '');
  if (validateSlug(slug) !== 'ok') return fail('slug_unavailable');
  const smsCode = newCode();
  const emailCode = newCode();
  const id = await asPlatform(db, async (tx) => {
    const key = `signup:${ip}`;
    if (await tooManyAttempts(tx, key, now)) return null;
    await countFailedAttempt(tx, key, now); // every start counts, so one address cannot send SMS without limit
    const [taken] = await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, slug));
    if (taken) return 'taken' as const;
    const [row] = await tx.insert(signupVerifications).values({
      shopName, shopType: input.shopType, slug, ownerName, email, phone, smsCodeHash: 'x', emailCodeHash: 'x', expiresAt: new Date(now.getTime() + CODE_MINUTES * 60_000), createdAt: now,
    }).returning({ id: signupVerifications.id });
    await tx.update(signupVerifications).set({ smsCodeHash: hash(row.id, smsCode), emailCodeHash: hash(row.id, emailCode) }).where(eq(signupVerifications.id, row.id));
    return row.id;
  });
  if (id === null) return fail('try_again_later');
  if (id === 'taken') return fail('slug_unavailable');
  await sms(phone, `${appName()} sign-up code: ${smsCode}. It expires in ${CODE_MINUTES} minutes.`);
  await sendEmail({ to: email, subject: `Your ${appName()} sign-up code`, text: `Your email code is ${emailCode}. It expires in ${CODE_MINUTES} minutes.\nIf you did not sign up, ignore this email.` });
  return { ok: true, id };
}

/** Both codes right: the shop is created on a 14-day trial and the owner's password is set. */
export async function completeSignup(db: Db, input: { id: string; smsCode: string; emailCode: string; password: string }, now: Date): Promise<
  { ok: true; slug: string } | Fail<'expired' | 'wrong_code' | 'weak_password' | 'slug_unavailable'>
> {
  if (!isUuid(input.id)) return fail('expired');
  if ((input.password ?? '').length < MIN_PASSWORD_LENGTH) return fail('weak_password');
  const row = await asPlatform(db, async (tx) => {
    const [v] = await tx.select().from(signupVerifications).where(eq(signupVerifications.id, input.id)).for('update');
    if (!v || v.usedAt || v.expiresAt.getTime() <= now.getTime() || v.attempts >= MAX_CODE_TRIES) return 'expired' as const;
    if (!same(hash(v.id, (input.smsCode ?? '').trim()), v.smsCodeHash) || !same(hash(v.id, (input.emailCode ?? '').trim()), v.emailCodeHash)) {
      await tx.update(signupVerifications).set({ attempts: v.attempts + 1 }).where(eq(signupVerifications.id, v.id));
      return 'wrong_code' as const;
    }
    await tx.update(signupVerifications).set({ usedAt: now }).where(eq(signupVerifications.id, v.id));
    return v;
  });
  if (row === 'expired' || row === 'wrong_code') return fail(row);
  const shop = await onboardShop(db, null, {
    name: row.shopName, requestedSlug: row.slug, shopType: row.shopType as ShopType, owner: { name: row.ownerName, email: row.email, phone: row.phone }, start: { kind: 'trial' },
  }, now, { emailActivation: false });
  if (!shop.ok) return fail('slug_unavailable');
  const token = shop.activationUrl.split('/').at(-1)!;
  const done = await activateAccount(db, { token, password: input.password }, now);
  if (!done.ok) return fail('weak_password');
  return { ok: true, slug: shop.slug };
}
