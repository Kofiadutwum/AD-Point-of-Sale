'use server';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { FormState } from '@/components/form';
import { getDb } from '@/db/client';
import { clientIp } from '@/server/rate-limit';
import { completeSignup, startSignup } from '@/server/signup';
import { sendSms } from '@/server/sms';

const MESSAGES: Record<string, string> = {
  invalid_input: 'Fill in every field.', slug_unavailable: 'That web address is taken or not allowed. Try another.', invalid_email: 'Check the email address.',
  invalid_phone: 'Enter a Ghana phone number.', try_again_later: 'Too many sign-ups from here. Try again in 15 minutes.',
  expired: 'These codes have expired. Start again.', wrong_code: 'One of the codes is wrong. Check the SMS and the email.', weak_password: 'Use a password of at least 10 characters.',
};
const text = (fd: FormData, k: string) => String(fd.get(k) ?? '');

export async function startSignupAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const r = await startSignup(getDb(), {
    shopName: text(fd, 'shopName'), slug: text(fd, 'slug'), shopType: text(fd, 'shopType'), ownerName: text(fd, 'ownerName'), email: text(fd, 'email'), phone: text(fd, 'phone'),
  }, clientIp(await headers()), new Date(), sendSms);
  if (!r.ok) return { error: MESSAGES[r.error] };
  redirect(`/signup/verify/${r.id}`);
}

export async function completeSignupAction(id: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const r = await completeSignup(getDb(), { id, smsCode: text(fd, 'smsCode'), emailCode: text(fd, 'emailCode'), password: text(fd, 'password') }, new Date());
  if (!r.ok) return { error: MESSAGES[r.error] };
  redirect(`/${r.slug}/login`);
}
