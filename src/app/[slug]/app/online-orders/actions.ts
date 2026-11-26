'use server';
import { revalidatePath } from 'next/cache';
import type { FormState } from '@/components/form';
import { getDb } from '@/db/client';
import { cancelOnlineOrder, completeOnlineOrder, confirmTransfer, setOnlineOrderStep } from '@/server/online-orders';
import { pageCtx } from '../page-ctx';

const text = (fd: FormData, k: string) => String(fd.get(k) ?? '').trim();
const refresh = (slug: string, id: string) => { revalidatePath(`/${slug}/app/online-orders`); revalidatePath(`/${slug}/app/online-orders/${id}`); };

export async function confirmTransferAction(slug: string, id: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'online_orders');
  const r = await confirmTransfer(getDb(), ctx, id, text(fd, 'reference'), new Date());
  if (!r.ok) return { error: r.error === 'reference_required' ? 'Enter the transfer reference.' : 'This order is not waiting for a transfer.' };
  refresh(slug, id);
  return { error: null, message: 'Payment confirmed. The customer was told by SMS.' };
}

export async function stepAction(slug: string, id: string, step: 'ready' | 'out_for_delivery'): Promise<FormState> {
  const ctx = await pageCtx(slug, 'online_orders');
  const r = await setOnlineOrderStep(getDb(), ctx, id, step, new Date());
  if (!r.ok) return { error: 'The order is not at that step yet.' };
  refresh(slug, id);
  return { error: null, message: 'Updated. The customer was told by SMS.' };
}

export async function completeAction(slug: string, id: string): Promise<FormState> {
  const ctx = await pageCtx(slug, 'online_orders');
  const r = await completeOnlineOrder(getDb(), ctx, id, new Date());
  if (!r.ok) return { error: r.error === 'no_register' ? 'Hand over from a till: sign in with your PIN on a registered till.' : r.error === 'no_open_shift' ? 'Open a shift on this till first.' : 'The order cannot be completed now.' };
  refresh(slug, id);
  return { error: null, message: 'Handed over and recorded as a sale.' };
}

export async function cancelAction(slug: string, id: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'online_orders');
  const r = await cancelOnlineOrder(getDb(), ctx, id, text(fd, 'reason'), new Date());
  if (!r.ok) return { error: r.error === 'reason_required' ? 'Give a reason.' : 'This order is already closed.' };
  refresh(slug, id);
  return { error: null, message: r.refundDuePesewas ? 'Cancelled. Refund the customer from Paystack or by transfer.' : 'Cancelled.' };
}
