'use server';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { FormState } from '@/components/form';
import { getDb } from '@/db/client';
import { cookieOptions, DEVICE_COOKIE, SESSION_COOKIE } from '@/lib/cookies';
import { type PinError, switchCashierWithPin } from '@/server/devices';

const MESSAGES: Record<PinError, string> = {
  device_not_registered: 'This device is not registered as a till. Ask a manager to register it.',
  not_assigned: 'You are not set up to sell on this till.',
  pin_locked: 'PIN locked for 15 minutes. Your manager has been told.',
  wrong_pin: 'Wrong PIN.',
};

export async function pinAction(slug: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const jar = await cookies();
  const r = await switchCashierWithPin(getDb(), {
    deviceToken: jar.get(DEVICE_COOKIE)?.value, staffId: String(formData.get('staffId') ?? ''), pin: String(formData.get('pin') ?? ''),
  }, new Date());
  if (!r.ok) return { error: MESSAGES[r.error] };
  jar.set(SESSION_COOKIE, r.token, cookieOptions(r.expiresAt));
  redirect(`/${slug}/app`);
}
