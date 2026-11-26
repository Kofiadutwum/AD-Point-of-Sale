'use server';
import { revalidatePath } from 'next/cache';
import type { FormState } from '@/components/form';
import { getDb } from '@/db/client';
import { addBranch, addRegister } from '@/server/branches';
import { updateShopProfile } from '@/server/onboarding';
import type { Module } from '@/lib/permissions';
import { parseCedis } from '@/lib/money';
import { parsePercent } from '@/lib/tax';
import { saveCashSettings, saveOrderSettings, savePharmacySettings, saveReportSettings, saveStockSettings, saveReturnSettings, saveSalesSettings, saveSellingSettings, setOfflineEnabled } from '@/server/shop-settings';
import { grantSupportAccess, revokeSupportAccess } from '@/server/support';
import { saveTaxRule } from '@/server/tax-rules';
import { pageCtx } from '../page-ctx';

export async function saveOfflineAction(slug: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_shop_settings');
  await setOfflineEnabled(getDb(), ctx, formData.get('offlineEnabled') === 'on');
  revalidatePath(`/${slug}/app/settings`);
  return { error: null, message: 'Saved. Tills pick this up within a minute.' };
}

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

const failure = (things: 'branches' | 'tills'): Record<string, string> => ({
  limit_reached: `Your plan allows no more ${things}. Upgrade to add more.`,
  duplicate_code: 'That code is already used in this shop.',
  unknown_branch: 'Choose a branch.',
  invalid_input: 'Enter a name and a code of up to 6 letters or numbers.',
});

export async function addBranchAction(slug: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_shop_settings');
  const value = (k: string) => String(formData.get(k) ?? '');
  const r = await addBranch(getDb(), ctx, { name: value('name'), branchCode: value('code'), address: value('address'), phone: value('phone') });
  if (!r.ok) return { error: failure('branches')[r.error] };
  revalidatePath(`/${slug}/app/settings`);
  return { error: null, message: 'Branch added.' };
}

export async function addRegisterAction(slug: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_shop_settings');
  const value = (k: string) => String(formData.get(k) ?? '');
  const r = await addRegister(getDb(), ctx, { branchId: value('branchId'), name: value('name'), registerCode: value('code') });
  if (!r.ok) return { error: failure('tills')[r.error] };
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
    cashRoundingStep: Number(fd.get('cashRoundingStep') ?? 0),
  });
  if (!r.ok) return { error: 'Check the details.' };
  revalidatePath(`/${slug}/app/settings`);
  return { error: null, message: 'Saved.' };
}

export async function saveReturnsAction(slug: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_shop_settings');

  const limit = parseCedis(String(fd.get('refundLimit') ?? '').trim() || '0');
  if (limit === null) return { error: 'Enter the refund limit in GHS (0 = always ask a manager).' };
  const r = await saveReturnSettings(getDb(), ctx, {
    refundLimitPesewas: limit, allowNoReceiptReturns: fd.get('allowNoReceiptReturns') === 'on', noReceiptMonthlyLimit: Number(fd.get('noReceiptMonthlyLimit')),
  });
  if (!r.ok) return { error: 'Check the details.' };
  revalidatePath(`/${slug}/app/settings`);
  return { error: null, message: 'Saved.' };
}

export async function savePharmacyAction(slug: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_shop_settings');
  const r = await savePharmacySettings(getDb(), ctx, { otcOnly: fd.get('otcOnly') === 'on', expiryWarningDays: Number(fd.get('expiryWarningDays')) });
  if (!r.ok) return { error: 'Enter a warning period from 1 to 365 days.' };
  revalidatePath(`/${slug}/app/settings`);
  return { error: null, message: 'Saved.' };
}

export async function saveCashAction(slug: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_shop_settings');
  const variance = parseCedis(String(fd.get('varianceLimit') ?? '').trim() || '0');
  const expense = parseCedis(String(fd.get('expenseLimit') ?? '').trim() || '0');
  if (variance === null || expense === null) return { error: 'Enter the limits in GHS (0 = always ask a manager).' };
  const r = await saveCashSettings(getDb(), ctx, { requireShifts: fd.get('requireShifts') === 'on', cashVarianceLimitPesewas: variance, expenseApprovalLimitPesewas: expense });
  if (!r.ok) return { error: 'Check the details.' };
  revalidatePath(`/${slug}/app/settings`);
  return { error: null, message: 'Saved.' };
}

export async function saveReportsAction(slug: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_shop_settings');
  const r = await saveReportSettings(getDb(), ctx, { smsReports: fd.get('smsReports') === 'on', reportTime: String(fd.get('reportTime') ?? ''), weeklyReportDay: Number(fd.get('weeklyReportDay')) });
  if (!r.ok) return { error: 'Enter the time as HH:MM.' };
  revalidatePath(`/${slug}/app/settings`);
  return { error: null, message: 'Saved. Reports go to the manager phone in the shop profile.' };
}

export async function grantSupportAction(slug: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_shop_settings');
  const r = await grantSupportAccess(getDb(), ctx, { hours: Number(fd.get('hours')), reason: String(fd.get('reason') ?? '') }, new Date());
  if (!r.ok) return { error: 'Choose 1 to 72 hours and say what you need help with.' };
  revalidatePath(`/${slug}/app/settings`);
  return { error: null, message: 'Support can see your shop until you end it or the time runs out.' };
}

export async function revokeSupportAction(slug: string, sessionId: string): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_shop_settings');
  const r = await revokeSupportAccess(getDb(), ctx, sessionId, new Date());
  revalidatePath(`/${slug}/app/settings`);
  return r.ok ? { error: null, message: 'Support access ended.' } : { error: 'That access already ended.' };
}

export async function saveStockAction(slug: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_shop_settings');
  const count = parseCedis(String(fd.get('countLimit') ?? '').trim() || '0');
  const adjust = parseCedis(String(fd.get('adjustLimit') ?? '').trim() || '0');
  if (count === null || adjust === null) return { error: 'Enter the limits in GHS.' };
  const r = await saveStockSettings(getDb(), ctx, { countApprovalLimitPesewas: count, adjustmentApprovalLimitPesewas: adjust, reorderCoverDays: Number(fd.get('coverDays')) });
  if (!r.ok) return { error: 'Check the details.' };
  revalidatePath(`/${slug}/app/settings`);
  return { error: null, message: 'Saved.' };
}

export async function saveOrdersAction(slug: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_shop_settings');
  const fee = parseCedis(String(fd.get('fee') ?? '').trim() || '0');
  if (fee === null) return { error: 'Enter the fee in GHS.' };
  const momo = String(fd.get('momo') ?? '').trim();
  const r = await saveOrderSettings(getDb(), ctx, { layawayMinDepositPercent: Number(fd.get('minDeposit')), orderCancellationFeePesewas: fee, orderRefundAs: String(fd.get('refundAs')) as 'store_credit' | 'cash', momoNumber: momo || null });
  if (!r.ok) return { error: 'Check the details.' };
  revalidatePath(`/${slug}/app/settings`);
  return { error: null, message: 'Saved.' };
}
