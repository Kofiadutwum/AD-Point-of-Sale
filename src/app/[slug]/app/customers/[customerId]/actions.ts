'use server';
import { revalidatePath } from 'next/cache';
import type { FormState } from '@/components/form';
import { getDb } from '@/db/client';
import { formatCedis, parseCedis } from '@/lib/money';
import { adjustBalance, recordDebtPayment, saveCreditTerms } from '@/server/customer-accounts';
import { pageCtx } from '../../page-ctx';

const text = (fd: FormData, k: string) => String(fd.get(k) ?? '').trim();
const MESSAGES: Record<string, string> = {
  invalid_input: 'Check the amount.', not_found: 'That customer no longer exists.', invalid_amount: 'The amount must be more than zero and no more than what they owe.',
  reference_required: 'Enter the MoMo, card, or bank reference.', reason_required: 'Enter a reason.',
};

export async function termsAction(slug: string, customerId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'approve_actions');
  const limit = parseCedis(text(fd, 'limit') || '0');
  if (limit === null) return { error: 'Enter the credit limit in GHS (0 = no credit).' };
  const r = await saveCreditTerms(getDb(), ctx, { customerId, creditLimitPesewas: limit, reminderConsent: fd.get('consent') === 'on' });
  if (!r.ok) return { error: MESSAGES[r.error] };
  revalidatePath(`/${slug}/app/customers/${customerId}`);
  return { error: null, message: 'Saved.' };
}

export async function paymentAction(slug: string, customerId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'receive_debt_payment');
  const amount = parseCedis(text(fd, 'amount'));
  if (!amount) return { error: MESSAGES.invalid_input };
  const method = text(fd, 'method') as 'cash' | 'momo_manual' | 'card_terminal' | 'bank_transfer';
  const r = await recordDebtPayment(getDb(), ctx, { customerId, amountPesewas: amount, method, reference: text(fd, 'reference') || undefined }, new Date());
  if (!r.ok) return { error: MESSAGES[r.error] };
  revalidatePath(`/${slug}/app/customers/${customerId}`);
  return { error: null, message: `Received ${formatCedis(amount)} from ${r.customerName}. They now owe ${formatCedis(r.balancePesewas)}.` };
}

export async function adjustAction(slug: string, customerId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'approve_actions');
  const amount = parseCedis(text(fd, 'amount'));
  if (!amount) return { error: MESSAGES.invalid_input };
  const r = await adjustBalance(getDb(), ctx, { customerId, amountPesewas: text(fd, 'direction') === 'up' ? amount : -amount, reason: text(fd, 'reason') }, new Date());
  if (!r.ok) return { error: MESSAGES[r.error] };
  revalidatePath(`/${slug}/app/customers/${customerId}`);
  return { error: null, message: `Adjusted. They now owe ${formatCedis(r.balancePesewas)}.` };
}
