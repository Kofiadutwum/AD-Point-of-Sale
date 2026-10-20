'use server';
import { revalidatePath } from 'next/cache';
import type { FormState } from '@/components/form';
import { getDb } from '@/db/client';
import { parseCedis } from '@/lib/money';
import { addCustomer, issueStoreCredit } from '@/server/customers';
import { pageCtx } from '../page-ctx';

const MESSAGES: Record<string, string> = {
  invalid_input: 'Enter a name and a Ghana phone number.', duplicate_phone: 'A customer with that phone already exists.',
  unknown_price_list: 'Choose a price list.', not_found: 'That customer no longer exists.',
};

export async function addCustomerAction(slug: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'make_sale');
  const r = await addCustomer(getDb(), ctx, {
    name: String(fd.get('name') ?? ''), phone: String(fd.get('phone') ?? ''), priceListId: String(fd.get('priceListId') ?? '') || null,
  });
  if (!r.ok) return { error: MESSAGES[r.error] };
  revalidatePath(`/${slug}/app/customers`);
  return { error: null, message: 'Customer added.' };
}

export async function storeCreditAction(slug: string, customerId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'approve_actions');
  const amount = parseCedis(String(fd.get('amount') ?? ''));
  if (!amount) return { error: 'Enter an amount in GHS.' };
  const r = await issueStoreCredit(getDb(), ctx, {
    customerId, amountPesewas: amount, source: fd.get('source') === 'refund' ? 'refund' : 'goodwill', reason: String(fd.get('reason') ?? ''),
  }, new Date());
  if (!r.ok) return { error: r.error === 'invalid_input' ? 'Enter a reason.' : MESSAGES[r.error] };
  revalidatePath(`/${slug}/app/customers`);
  return { error: null, message: 'Store credit given.' };
}
