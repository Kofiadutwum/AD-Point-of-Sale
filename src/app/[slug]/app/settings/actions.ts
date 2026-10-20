'use server';
import { revalidatePath } from 'next/cache';
import type { FormState } from '@/components/form';
import { getDb } from '@/db/client';
import { addBranch, addRegister } from '@/server/branches';
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

const LIMITS: Record<string, string> = {
  limit_reached: 'Your plan allows no more of these. Upgrade to add more.',
  duplicate_code: 'That code is already used in this shop.',
  unknown_branch: 'Choose a branch.',
  invalid_input: 'Enter a name and a code of up to 6 letters or numbers.',
};

export async function addBranchAction(slug: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_shop_settings');
  const value = (k: string) => String(formData.get(k) ?? '');
  const r = await addBranch(getDb(), ctx, { name: value('name'), branchCode: value('code'), address: value('address'), phone: value('phone') });
  if (!r.ok) return { error: LIMITS[r.error] };
  revalidatePath(`/${slug}/app/settings`);
  return { error: null, message: 'Branch added.' };
}

export async function addRegisterAction(slug: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_shop_settings');
  const value = (k: string) => String(formData.get(k) ?? '');
  const r = await addRegister(getDb(), ctx, { branchId: value('branchId'), name: value('name'), registerCode: value('code') });
  if (!r.ok) return { error: LIMITS[r.error] };
  revalidatePath(`/${slug}/app/settings`);
  return { error: null, message: 'Till added.' };
}
