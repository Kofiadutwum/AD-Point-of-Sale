'use server';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { FormState } from '@/components/form';
import { getDb } from '@/db/client';
import { ADMIN_COOKIE, cookieOptions } from '@/lib/cookies';
import { platformSignIn } from '@/server/platform-admin';

export async function adminSignInAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ip = (await headers()).get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  const result = await platformSignIn(getDb(), {
    email: String(formData.get('email') ?? ''), password: String(formData.get('password') ?? ''), ip,
  }, new Date());
  if (!result.ok) {
    return { error: result.error === 'try_again_later' ? 'Too many attempts. Try again in 15 minutes.' : 'Wrong email or password.' };
  }
  (await cookies()).set(ADMIN_COOKIE, result.token, cookieOptions(result.expiresAt));
  redirect('/admin/shops');
}
