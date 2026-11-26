'use server';
import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import type { FormState } from '@/components/form';
import { getDb } from '@/db/client';
import { formatCedis, parseCedis } from '@/lib/money';
import { cancelCounterOrder, collectCounterOrder, sendCounterOrder } from '@/server/counter-orders';
import { lookupStockItem } from '@/server/stock';
import { pageCtx } from '../page-ctx';

const MESSAGES: Record<string, string> = {
  invalid_input: 'Check the quantities.', no_branch: 'Sign in at a till or a single branch to send orders.', unknown_item: 'An item is not in the catalogue.',
  not_sellable: 'An item is not for sale.', invalid_quantity: 'Check the quantities.', sold_out: 'An item is sold out.',
  not_open: 'That order is already paid or cancelled.', expired: 'That order has expired. Send it again.', wrong_branch: 'That order belongs to another branch.',
  no_register: 'Take payment at a till: sign in with your PIN on a registered till.', payment_incomplete: 'Not enough paid yet.',
  reference_required: 'Enter the MoMo, card, or bank reference.', not_enough_stock: 'Not enough stock of an item.',
  reduce_non_cash_amount: 'Only cash can give change. Reduce the MoMo, card, or bank amount.',
};
const PAY_METHODS = ['momo_manual', 'card_terminal', 'bank_transfer'] as const;
const text = (fd: FormData, k: string) => String(fd.get(k) ?? '').trim();
const say = (code: string) => MESSAGES[code] ?? code.replaceAll('_', ' ');

export async function sendOrderAction(slug: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'make_sale');
  const lines = [];
  for (const k of [0, 1, 2, 3, 4]) {
    if (!text(fd, `code_${k}`)) continue;
    const item = await lookupStockItem(getDb(), ctx, text(fd, `code_${k}`), 'make_sale');
    if (!item) return { error: `No item has the barcode or SKU ${text(fd, `code_${k}`)}.` };
    lines.push({ variantId: item.variantId, unitId: item.unitId, quantity: text(fd, `qty_${k}`) || '1' });
  }
  if (lines.length === 0) return { error: 'Scan or type at least one item.' };
  const r = await sendCounterOrder(getDb(), ctx, { lines }, new Date());
  if (!r.ok) return { error: say(r.error) };
  revalidatePath(`/${slug}/app/counter-orders`);
  return { error: null, message: `Order ${r.orderNumber} sent. Give the customer this number to pay at the cashier.` };
}

export async function collectOrderAction(slug: string, orderId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'make_sale');
  const cash = text(fd, 'cash') ? parseCedis(text(fd, 'cash')) : 0;
  const other = text(fd, 'otherAmount') ? parseCedis(text(fd, 'otherAmount')) : 0;
  const method = text(fd, 'otherMethod') as (typeof PAY_METHODS)[number];
  if (cash === null || other === null || (other > 0 && !PAY_METHODS.includes(method))) return { error: 'Check the payment amounts.' };
  const tenders = [
    ...(cash > 0 ? [{ id: randomUUID(), method: 'cash' as const, amountPesewas: cash }] : []),
    ...(other > 0 ? [{ id: randomUUID(), method, amountPesewas: other, reference: text(fd, 'otherReference') || undefined }] : []),
  ];
  const r = await collectCounterOrder(getDb(), ctx, { orderId, tenders }, new Date());
  if (!r.ok) return { error: say(r.error) };
  revalidatePath(`/${slug}/app/counter-orders`);
  return { error: null, message: `Order ${r.orderNumber} paid. Change ${formatCedis(r.changeDuePesewas)}.` };
}

export async function cancelOrderAction(slug: string, orderId: string): Promise<FormState> {
  const ctx = await pageCtx(slug, 'make_sale');
  const r = await cancelCounterOrder(getDb(), ctx, orderId, new Date());
  if (!r.ok) return { error: say(r.error) };
  revalidatePath(`/${slug}/app/counter-orders`);
  return { error: null, message: 'Order cancelled.' };
}
