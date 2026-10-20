'use server';
import { revalidatePath } from 'next/cache';
import type { FormState } from '@/components/form';
import { getDb } from '@/db/client';
import { formatCedis, parseCedis } from '@/lib/money';
import { issueOwnerActivationLink } from '@/server/onboarding';
import { type ManualPayment, recordManualPayment, setShopSuspended } from '@/server/subscriptions';
import { resetOwnerMfa } from '@/server/platform-admin';
import { adminCtx, adminToken } from '../../../admin-ctx';

export async function recordPaymentAction(tenantId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const { adminId } = await adminCtx();
  const amountPesewas = parseCedis(String(formData.get('amount') ?? ''));
  if (amountPesewas === null || amountPesewas === 0) return { error: 'Enter the amount in cedis, for example 1,200.00.' };
  const payment: ManualPayment = {
    method: String(formData.get('method')) as ManualPayment['method'],
    reference: String(formData.get('reference') ?? ''),
    amountPesewas,
    periodMonths: Number(formData.get('months')),
    planId: String(formData.get('plan') ?? ''),
  };
  const result = await recordManualPayment(getDb(), adminId, tenantId, payment, new Date());
  if (!result.ok) {
    return { error: result.error === 'duplicate_reference' ? 'This payment reference was already recorded.' : 'Check the payment details.' };
  }
  revalidatePath(`/admin/shops/${tenantId}`);
  return { error: null, message: `Recorded ${formatCedis(amountPesewas)}. Paid until ${result.endDate}.` };
}

export async function resetMfaAction(tenantId: string, _prev: FormState, _formData: FormData): Promise<FormState> {
  await adminCtx();
  await resetOwnerMfa(getDb(), await adminToken(), tenantId, new Date());
  return { error: null, message: 'Two-step sign-in is off for the owner. They can turn it on again after signing in.' };
}

export async function suspendAction(tenantId: string, suspended: boolean, _prev: FormState, formData: FormData): Promise<FormState> {
  const { adminId } = await adminCtx();
  const reason = String(formData.get('reason') ?? '').trim();
  if (!reason) return { error: 'Give a reason.' };
  await setShopSuspended(getDb(), adminId, tenantId, suspended, reason);
  revalidatePath(`/admin/shops/${tenantId}`);
  return { error: null, message: suspended ? 'Shop suspended.' : 'Shop active again.' };
}

export async function issueLinkAction(tenantId: string, _prev: FormState, _formData: FormData): Promise<FormState> {
  const { adminId } = await adminCtx();
  const { activationUrl } = await issueOwnerActivationLink(getDb(), adminId, tenantId, new Date());
  return { error: null, message: 'New activation link for the owner (earlier links no longer work):', copy: activationUrl };
}
