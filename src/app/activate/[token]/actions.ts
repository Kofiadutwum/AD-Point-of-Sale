'use server';
import { redirect } from 'next/navigation';
import type { FormState } from '@/components/form';
import { getDb } from '@/db/client';
import { activateAccount } from '@/server/onboarding';

const MESSAGES = {
  invalid_or_expired: 'This link has expired or was already used. Ask for a new one.',
  weak_password: 'Use at least 10 characters.',
  invalid_pin: 'PIN must be 4 to 6 digits.',
} as const;

export async function activateAction(token: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const password = String(formData.get('password') ?? '');
  if (password !== String(formData.get('confirm') ?? '')) return { error: 'Passwords do not match.' };
  const r = await activateAccount(getDb(), { token, password, pin: String(formData.get('pin') ?? '') }, new Date());
  if (!r.ok) return { error: MESSAGES[r.error] };
  redirect(`/${r.slug}/login`);
}
