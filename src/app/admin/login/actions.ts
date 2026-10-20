'use server';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { FormState } from '@/components/form';
import { getDb } from '@/db/client';
import { ADMIN_COOKIE, cookieOptions } from '@/lib/cookies';
import { platformSignIn } from '@/server/platform-admin';
import { clientIp } from '@/server/rate-limit';

export async function adminSignInAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await platformSignIn(getDb(), {
    email: String(formData.get('email') ?? ''), password: String(formData.get('password') ?? ''), ip: clientIp(await headers()),
  }, new Date());
  if (!result.ok) {
    return { error: result.error === 'try_again_later' ? 'Too many attempts. Try again in 15 minutes.' : 'Wrong email or password.' };
  }
  (await cookies()).set(ADMIN_COOKIE, result.token, cookieOptions(result.expiresAt));
  redirect('/admin/shops');
}
