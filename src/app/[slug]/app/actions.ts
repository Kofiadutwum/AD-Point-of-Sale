'use server';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getDb } from '@/db/client';
import { SESSION_COOKIE } from '@/lib/cookies';
import { revalidatePath } from 'next/cache';
import type { FormState } from '@/components/form';
import { signOut } from '@/server/auth';
import { resolveHeldSale } from '@/server/held-sales';
import { pageCtx } from './page-ctx';

export async function signOutAction(slug: string): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await signOut(getDb(), token);
  jar.delete(SESSION_COOKIE);
  redirect(`/${slug}/login`);
}

export async function resolveHeldAction(slug: string, heldSaleId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'approve_actions');
  const r = await resolveHeldSale(getDb(), ctx, heldSaleId, String(formData.get('note') ?? ''), new Date());
  if (!r.ok) return { error: 'Already resolved.' };
  revalidatePath(`/${slug}/app`);
  return { error: null, message: 'Resolved.' };
}
