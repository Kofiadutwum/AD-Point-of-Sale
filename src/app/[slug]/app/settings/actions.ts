'use server';
import { revalidatePath } from 'next/cache';
import type { FormState } from '@/components/form';
import { getDb } from '@/db/client';
import { updateShopProfile } from '@/server/onboarding';
import { pageCtx } from '../page-ctx';

export async function saveProfileAction(slug: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_shop_settings');
  const value = (k: string) => String(formData.get(k) ?? '');
  const r = await updateShopProfile(getDb(), ctx, {
    name: value('name'), address: value('address'), phone: value('phone'), managerPhone: value('managerPhone'),
    taxMode: value('taxMode') === 'exclusive' ? 'exclusive' : 'inclusive', businessDayCutoff: value('businessDayCutoff'),
  });
  if (!r.ok) return { error: 'Check the details: phone numbers must be Ghana numbers and the cutoff a time like 04:00.' };
  revalidatePath(`/${slug}/app/settings`);
  return { error: null, message: 'Saved.' };
}
