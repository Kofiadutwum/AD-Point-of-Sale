'use server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type { FormState } from '@/components/form';
import { getDb } from '@/db/client';
import { normaliseGhanaPhone } from '@/lib/contact';
import { parseCedis } from '@/lib/money';
import { requestApproval } from '@/server/approvals';
import { cancelOrder, collectOrder, createOrder, payOrder } from '@/server/customer-orders';
import { listCustomers } from '@/server/customers';
import { pageCtx } from '../page-ctx';
import { linesFromForm } from '../stock/form-lines';

type Method = 'cash' | 'momo_manual' | 'card_terminal' | 'bank_transfer';
const text = (fd: FormData, k: string) => String(fd.get(k) ?? '').trim();
const MESSAGES: Record<string, string> = {
  no_register: 'Take orders at a till: sign in with your PIN on a registered till.', unknown_customer: 'Choose the customer.', unknown_item: 'An item cannot be ordered.',
  deposit_too_small: 'The deposit is below the shop minimum.', reference_required: 'Enter the payment reference.', not_open: 'This order is closed.', too_much: 'That is more than is owed.',
  payment_incomplete: 'The order is not fully paid yet.', order_not_open: 'This order is closed.', approval_required: 'A manager must approve: choose who and enter their PIN.',
  invalid_input: 'Check the details.', not_enough_stock: 'Not enough stock to hand the items over.',
};
const say = (code: string) => MESSAGES[code] ?? code.replaceAll('_', ' ');

export async function createOrderAction(slug: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'layaway');
  const phone = normaliseGhanaPhone(text(fd, 'phone'));
  if (!phone) return { error: 'Enter the customer phone.' };
  const customer = (await listCustomers(getDb(), ctx, { query: text(fd, 'phone'), limit: 5 })).find((c) => c.phone === phone);
  if (!customer) return { error: 'No customer has that phone. Add them on the Customers page first.' };
  const l = await linesFromForm(ctx, fd, 'layaway');
  if ('error' in l) return { error: l.error };
  const deposit = text(fd, 'deposit') ? parseCedis(text(fd, 'deposit')) : 0;
  if (deposit === null) return { error: 'Enter the deposit in cedis.' };
  const r = await createOrder(getDb(), ctx, {
    kind: text(fd, 'kind') === 'special' ? 'special' : 'layaway', customerId: customer.id, lines: l.lines.map((x) => ({ variantId: x.variantId, unitId: x.unitId, quantity: x.quantity })),
    deposit: { method: text(fd, 'method') as Method, amountPesewas: deposit, reference: text(fd, 'reference') }, dueDate: text(fd, 'dueDate') || undefined, note: text(fd, 'note'),
  }, new Date());
  if (!r.ok) return { error: say(r.error) };
  redirect(`/${slug}/app/orders/${r.orderId}`);
}

export async function payOrderAction(slug: string, orderId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'layaway');
  const amount = parseCedis(text(fd, 'amount'));
  if (!amount) return { error: 'Enter the amount in cedis.' };
  const r = await payOrder(getDb(), ctx, { orderId, method: text(fd, 'method') as Method, amountPesewas: amount, reference: text(fd, 'reference') }, new Date());
  if (!r.ok) return { error: say(r.error) };
  revalidatePath(`/${slug}/app/orders/${orderId}`);
  return { error: null, message: r.status === 'ready' ? 'Paid in full: ready to collect.' : 'Payment recorded.' };
}

export async function collectOrderAction(slug: string, orderId: string): Promise<FormState> {
  const ctx = await pageCtx(slug, 'layaway');
  const r = await collectOrder(getDb(), ctx, orderId, new Date());
  if (!r.ok) return { error: say(r.error) };
  redirect(`/${slug}/app/receipts/${r.saleId}`);
}

export async function cancelOrderAction(slug: string, orderId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'layaway');
  let approvalToken: string | undefined;
  if (text(fd, 'approverId') && text(fd, 'pin')) {
    const a = await requestApproval(getDb(), ctx, { action: 'cancel_order', contextKey: orderId, approverId: text(fd, 'approverId'), pin: text(fd, 'pin') }, new Date());
    if (!a.ok) return { error: say(a.error) };
    approvalToken = a.token;
  }
  const r = await cancelOrder(getDb(), ctx, { orderId, reason: text(fd, 'reason'), approvalToken }, new Date());
  if (!r.ok) return { error: say(r.error) };
  revalidatePath(`/${slug}/app/orders/${orderId}`);
  return { error: null, message: `Cancelled. GHS ${(r.refundPesewas / 100).toFixed(2)} returned as ${r.refundAs === 'cash' ? 'cash' : 'store credit'}.` };
}
