'use server';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { FormState } from '@/components/form';
import { getDb } from '@/db/client';
import { cookieOptions, SESSION_COOKIE } from '@/lib/cookies';
import { type SignInError, signIn } from '@/server/auth';
import { clientIp } from '@/server/rate-limit';

const MESSAGES: Record<SignInError, string> = {
  access_denied: 'Wrong email, phone, or password.',
  try_again_later: 'Too many attempts. Try again in 15 minutes.',
  account_disabled: 'This account is disabled. Ask your shop owner.',
};

export async function signInAction(slug: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const result = await signIn(getDb(), {
    slug,
    identifier: String(formData.get('identifier') ?? ''),
    password: String(formData.get('password') ?? ''),
    ip: clientIp(await headers()),
  }, new Date());
  if (!result.ok) return { error: MESSAGES[result.error] };
  (await cookies()).set(SESSION_COOKIE, result.token, cookieOptions(result.expiresAt));
  redirect(`/${slug}/app`);
}
