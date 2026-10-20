'use server';
import { revalidatePath } from 'next/cache';
import type { FormState } from '@/components/form';
import { getDb } from '@/db/client';
import { parseCedis } from '@/lib/money';
import { SHOP_TYPES, type ShopType } from '@/lib/permissions';
import { type OnboardError, type OnboardInput, onboardShop } from '@/server/onboarding';
import type { ManualPayment } from '@/server/subscriptions';
import { adminCtx } from '../../admin-ctx';

const SLUG_HINTS: Record<string, string> = {
  too_short: 'Use at least 3 characters.',
  too_long: 'Use at most 40 characters.',
  invalid_chars: 'Use letters, numbers, and single hyphens.',
  reserved: 'That word is reserved.',
  taken: 'Another shop already uses it.',
};

function onboardMessage(e: OnboardError): string {
  switch (e.error) {
    case 'choose_another_slug': return `That shop address is not available. ${SLUG_HINTS[e.reason]}`;
    case 'owner_contact_required': return 'Enter the owner’s email or a valid Ghana phone number.';
    case 'duplicate_reference': return 'This payment reference was already recorded.';
    case 'invalid_payment': return 'Check the payment details.';
  }
}

const text = (f: FormData, k: string) => String(f.get(k) ?? '').trim();

export async function createShopAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { adminId } = await adminCtx();
  const shopType = text(formData, 'shopType') as ShopType;
  if (!SHOP_TYPES.includes(shopType)) return { error: 'Choose a shop type.' };
  let start: OnboardInput['start'] = { kind: 'trial' };
  if (text(formData, 'start') === 'paid') {
    const amountPesewas = parseCedis(text(formData, 'amount'));
    if (!amountPesewas) return { error: 'Enter the amount paid in cedis, for example 1,200.00.' };
    const payment: ManualPayment = {
      method: text(formData, 'method') as ManualPayment['method'], reference: text(formData, 'reference'),
      amountPesewas, periodMonths: Number(text(formData, 'months')), planId: 'standard',
    };
    start = { kind: 'paid', payment };
  }
  const name = text(formData, 'name');
  const r = await onboardShop(getDb(), adminId, {
    name, requestedSlug: text(formData, 'slug') || name, shopType, start,
    owner: { name: text(formData, 'ownerName'), email: text(formData, 'ownerEmail') || undefined, phone: text(formData, 'ownerPhone') || undefined },
  }, new Date());
  if (!r.ok) return { error: onboardMessage(r) };
  revalidatePath('/admin/shops');
  return { error: null, message: `Shop created at /${r.slug}. Send the owner this activation link:`, copy: r.activationUrl };
}
