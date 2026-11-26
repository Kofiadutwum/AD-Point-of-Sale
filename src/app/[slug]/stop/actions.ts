'use server';
import type { FormState } from '@/components/form';
import { getDb } from '@/db/client';
import { optOut } from '@/server/marketing';

export async function stopAction(slug: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const r = await optOut(getDb(), slug, String(fd.get('phone') ?? ''), new Date());
  if (!r.ok) return { error: r.error === 'invalid_phone' ? 'Enter a Ghana phone number.' : 'This shop was not found.' };
  return { error: null, message: 'Done. You will not get promotional SMS from this shop again.' };
}
