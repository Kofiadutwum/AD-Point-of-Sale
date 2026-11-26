'use server';
import type { FormState } from '@/components/form';
import { getDb } from '@/db/client';
import { startPairing } from '@/server/customer-display';
import { pageCtx } from '../page-ctx';

export async function pairAction(slug: string): Promise<FormState> {
  const ctx = await pageCtx(slug, 'make_sale');
  const r = await startPairing(getDb(), ctx, new Date());
  if (!r.ok) return { error: 'Pair from a till: sign in with your PIN on a registered till.' };
  return { error: null, message: `Code ${r.code}. Enter it on the display within 10 minutes.` };
}
