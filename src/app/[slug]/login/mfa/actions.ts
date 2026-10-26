'use server';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { FormState } from '@/components/form';
import { getDb } from '@/db/client';
import { cookieOptions, MFA_COOKIE, SESSION_COOKIE } from '@/lib/cookies';
import { verifyMfaSignIn } from '@/server/mfa';
import { clientIp } from '@/server/rate-limit';

const MESSAGES = {
  expired: 'Sign in again.',
  wrong_code: 'Wrong code.',
  try_again_later: 'Too many attempts. Try again in 15 minutes.',
} as const;

export async function mfaAction(slug: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const jar = await cookies();
  const r = await verifyMfaSignIn(getDb(), {
    slug, challengeToken: jar.get(MFA_COOKIE)?.value ?? '', code: String(formData.get('code') ?? ''), ip: clientIp(await headers()),
  }, new Date());
  if (!r.ok) return { error: MESSAGES[r.error] };
  jar.delete(MFA_COOKIE);
  jar.set(SESSION_COOKIE, r.token, cookieOptions(r.expiresAt));
  redirect(`/${slug}/app`);
}
