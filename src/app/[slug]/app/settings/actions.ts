'use server';
import { revalidatePath } from 'next/cache';
import type { FormState } from '@/components/form';
import { getDb } from '@/db/client';
import { addBranch, addRegister } from '@/server/branches';
import { updateShopProfile } from '@/server/onboarding';
import type { Module } from '@/lib/permissions';
import { parsePercent } from '@/lib/tax';
import { saveSalesSettings, saveSellingSettings } from '@/server/shop-settings';
import { saveTaxRule } from '@/server/tax-rules';
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

export async function saveSellingAction(slug: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_shop_settings');
  const value = (k: string) => String(formData.get(k) ?? '');
  const carries = value('scaleCarries');
  // digit positions are shown 1-based and stored 0-based
  const scaleLayout = carries === 'weight' || carries === 'price'
    ? {
      prefix: value('scalePrefix').trim(), carries,
      itemStart: Number(value('itemFrom')) - 1, itemLength: Number(value('itemLength')),
      valueStart: Number(value('valueFrom')) - 1, valueLength: Number(value('valueLength')),
    } as const
    : null;
  const r = await saveSellingSettings(getDb(), ctx, {
    taxEnabled: formData.get('taxEnabled') === 'on', scaleLayout, modules: formData.getAll('modules').map(String) as Module[],
  });
  if (!r.ok) {
    if (r.error === 'barcodes_clash') {
      return { error: `These barcodes would be read as scale labels: ${r.codes.join(', ')}. Change them or use another prefix.` };
    }
    if (r.error === 'scale_codes_clash') {
      return { error: `These scale item codes would be misread with this layout: ${r.codes.join(', ')}. Change those items first.` };
    }
    return { error: 'Check the details.' };
  }
  revalidatePath(`/${slug}/app/settings`);
  return { error: null, message: 'Saved.' };
}

const TAX_ERRORS: Record<string, string> = {
  duplicate_name: 'A tax rule with that name already exists.',
  in_use: 'Products use this rule. Move them to another rule first.',
  invalid_input: 'Check the details.',
  not_found: 'Check the details.',
};

export async function saveTaxRuleAction(slug: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_shop_settings');
  const value = (k: string) => String(formData.get(k) ?? '');
  const rateBp = parsePercent(value('rate'));
  const levies = [1, 2, 3].flatMap((i) => {
    const name = value(`levyName${i}`).trim();
    return name ? [{ name, rateBp: parsePercent(value(`levyRate${i}`)) ?? -1 }] : []; // -1 fails validation
  });
  if (rateBp === null) return { error: TAX_ERRORS.invalid_input };
  const r = await saveTaxRule(getDb(), ctx, {
    id: value('id') || undefined, name: value('name'), rateBp, levies,
    vatOnLevies: formData.get('vatOnLevies') === 'on', isDefault: formData.get('isDefault') === 'on', active: formData.get('active') === 'on',
  });
  if (!r.ok) return { error: TAX_ERRORS[r.error] };
  revalidatePath(`/${slug}/app/settings`);
  return { error: null, message: 'Tax rule saved.' };
}

export async function saveSalesAction(slug: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_shop_settings');
  const r = await saveSalesSettings(getDb(), ctx, {
    allowNegativeStock: fd.get('allowNegativeStock') === 'on', taxNumber: String(fd.get('taxNumber') ?? ''), receiptFooter: String(fd.get('receiptFooter') ?? ''),
  });
  if (!r.ok) return { error: 'Check the details.' };
  revalidatePath(`/${slug}/app/settings`);
  return { error: null, message: 'Saved.' };
}
