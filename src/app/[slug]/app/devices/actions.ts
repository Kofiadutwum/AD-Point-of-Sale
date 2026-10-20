'use server';
import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import type { FormState } from '@/components/form';
import { getDb } from '@/db/client';
import { cookieOptions, DEVICE_COOKIE } from '@/lib/cookies';
import { registerDevice } from '@/server/devices';
import { pageCtx } from '../page-ctx';

const YEAR_MS = 365 * 86_400_000;

export async function registerDeviceAction(slug: string, registerId: string, _prev: FormState, _formData: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_devices');
  const now = new Date();
  const r = await registerDevice(getDb(), ctx, registerId, now);
  if (!r.ok) return { error: 'That till was not found.' };
  (await cookies()).set(DEVICE_COOKIE, r.deviceToken, cookieOptions(new Date(now.getTime() + YEAR_MS)));
  revalidatePath(`/${slug}/app/devices`);
  return { error: null, message: 'This device is now the till. Staff can switch in with their PIN.' };
}
