'use server';
import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import type { FormState } from '@/components/form';
import { getDb } from '@/db/client';
import { formatCedis, parseCedis } from '@/lib/money';
import { type ApprovalAction, requestApproval } from '@/server/approvals';
import type { Ctx } from '@/server/context';
import {
  processExchange, processReturn, quoteExchange, quoteNoReceiptReturn, quoteReturn, type RefundMethod, type ReturnItem, returnWithoutReceipt,
} from '@/server/returns';
import { lookupStockItem } from '@/server/stock';
import { pageCtx } from '../page-ctx';

const MESSAGES: Record<string, string> = {
  invalid_input: 'Check the quantities and fill in the reason.', not_found: 'That receipt or item was not found.',
  too_many: 'That is more than was sold, less what has come back already.', not_returnable: 'Bundles, meals, combos, and serial or batch items cannot be returned here yet.',
  approval_required: 'A manager must approve: choose who approves and enter their PIN.', reference_required: 'Enter the MoMo, card, or bank reference.',
  needs_customer: 'Store credit needs a customer on the sale.', not_allowed: 'Returns without a receipt are switched off in shop settings.',
  monthly_limit: 'This customer has reached the monthly limit for returns without a receipt.', no_price_history: 'That item has not sold in the last 90 days.',
  self_approval: 'Another person must approve.', not_authorised: 'That person cannot approve.', wrong_pin: 'Wrong PIN.', pin_locked: 'Too many wrong PINs. Try again later.',
  no_register: 'Exchanges are made at a till: sign in with your PIN on a registered till.', payment_incomplete: 'Not enough paid yet.',
  not_enough_stock: 'Not enough stock of a new item.', reduce_non_cash_amount: 'Only cash can give change. Reduce the MoMo, card, or bank amount.',
};
const METHODS: Record<RefundMethod, string> = { cash: 'cash', momo_manual: 'MoMo', card_terminal: 'card', bank_transfer: 'bank transfer', store_credit: 'store credit', credit: "the customer's account" };
const text = (fd: FormData, k: string) => String(fd.get(k) ?? '').trim();

/** A token when approval is needed and the form names a manager and PIN; a message otherwise. */
async function approve(ctx: Ctx, fd: FormData, needed: { action: ApprovalAction; contextKey: string } | null): Promise<{ token?: string } | { error: string }> {
  if (!needed) return {};
  if (!text(fd, 'approverId') || !text(fd, 'pin')) return { error: MESSAGES.approval_required };
  const a = await requestApproval(getDb(), ctx, { ...needed, approverId: text(fd, 'approverId'), pin: text(fd, 'pin') }, new Date());
  return a.ok ? { token: a.token } : { error: MESSAGES[a.error] };
}

export async function processReturnAction(slug: string, saleId: string, lineIds: string[], _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'process_return');
  const items: ReturnItem[] = lineIds.filter((id) => text(fd, `qty_${id}`) && Number(text(fd, `qty_${id}`)) !== 0)
    .map((id) => ({ saleLineId: id, quantity: text(fd, `qty_${id}`), condition: (text(fd, `cond_${id}`) || 'saleable') as ReturnItem['condition'] }));
  if (items.length === 0) return { error: 'Enter how many of each item come back.' };
  const refundMethod = text(fd, 'refundMethod') as RefundMethod;
  const quote = await quoteReturn(getDb(), ctx, { saleId, items, refundMethod });
  if (!quote.ok) return { error: MESSAGES[quote.error] };
  const a = await approve(ctx, fd, quote.approval);
  if ('error' in a) return { error: a.error };
  const r = await processReturn(getDb(), ctx, {
    saleId, items, refundMethod, reason: text(fd, 'reason'), reference: text(fd, 'reference') || undefined, approvalToken: a.token,
  }, new Date());
  if (!r.ok) return { error: MESSAGES[r.error] };
  revalidatePath(`/${slug}/app/returns`);
  return { error: null, message: `Return recorded. Refund ${formatCedis(r.refundPesewas)} by ${METHODS[refundMethod]}.` };
}

export async function noReceiptAction(slug: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'process_return');
  const item = await lookupStockItem(getDb(), ctx, text(fd, 'code'), 'process_return');
  if (!item) return { error: 'No item has that barcode or SKU.' };
  const customer = { name: text(fd, 'name'), phone: text(fd, 'phone') };
  const items = [{ variantId: item.variantId, unitId: item.unitId, quantity: text(fd, 'quantity'), condition: (text(fd, 'condition') || 'saleable') as ReturnItem['condition'] }];
  const quote = await quoteNoReceiptReturn(getDb(), ctx, { customer, items });
  if (!quote.ok) return { error: quote.error === 'invalid_input' ? 'Enter the customer name, a Ghana phone number, and a quantity.' : MESSAGES[quote.error] };
  const a = await approve(ctx, fd, { action: 'no_receipt_return', contextKey: quote.contextKey });
  if ('error' in a) return { error: a.error };
  const r = await returnWithoutReceipt(getDb(), ctx, { customer, items, reason: text(fd, 'reason'), approvalToken: a.token ?? '' }, new Date());
  if (!r.ok) return { error: MESSAGES[r.error] };
  revalidatePath(`/${slug}/app/returns`);
  return { error: null, message: `${item.name} taken back. ${formatCedis(r.creditPesewas)} store credit given to ${customer.name}.` };
}

const PAY_METHODS = ['momo_manual', 'card_terminal', 'bank_transfer'] as const;

/** Spec 6.32: "Work out the difference" quotes; the main button records the exchange (a manager approves a refund of leftover credit when needed). */
export async function exchangeAction(slug: string, saleId: string, lineIds: string[], _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'process_return');
  const items: ReturnItem[] = lineIds.filter((id) => text(fd, `xqty_${id}`) && Number(text(fd, `xqty_${id}`)) !== 0)
    .map((id) => ({ saleLineId: id, quantity: text(fd, `xqty_${id}`), condition: (text(fd, `xcond_${id}`) || 'saleable') as ReturnItem['condition'] }));
  if (items.length === 0) return { error: 'Enter how many of each item come back.' };
  const newLines = [];
  for (const k of [0, 1, 2]) {
    if (!text(fd, `code_${k}`)) continue;
    const item = await lookupStockItem(getDb(), ctx, text(fd, `code_${k}`), 'process_return');
    if (!item) return { error: `No item has the barcode or SKU ${text(fd, `code_${k}`)}.` };
    newLines.push({ variantId: item.variantId, unitId: item.unitId, quantity: text(fd, `nqty_${k}`) || '1' });
  }
  if (newLines.length === 0) return { error: 'Scan or type at least one new item.' };
  const refundMethod = (text(fd, 'refundMethod') || undefined) as RefundMethod | undefined;
  const base = { saleId, items, newLines, reason: text(fd, 'reason'), refundMethod, reference: text(fd, 'reference') || undefined };
  const quote = await quoteExchange(getDb(), ctx, base, new Date());
  if (!quote.ok) return { error: MESSAGES[quote.error] ?? quote.error.replaceAll('_', ' ') };
  const summary = `Returned ${formatCedis(quote.returnPesewas)}, new items ${formatCedis(quote.newTotalPesewas)}. `
    + (quote.refundPesewas > 0 ? `Give back ${formatCedis(quote.refundPesewas)}${quote.approval ? ' (a manager must approve)' : ''}.`
      : `Customer pays ${formatCedis(quote.toPayPesewas)}${quote.cashToPayPesewas !== quote.toPayPesewas ? ` (${formatCedis(quote.cashToPayPesewas)} in cash)` : ''}.`);
  if (fd.get('step') === 'quote') return { error: null, message: summary };

  const cash = text(fd, 'cash') ? parseCedis(text(fd, 'cash')) : 0;
  const other = text(fd, 'otherAmount') ? parseCedis(text(fd, 'otherAmount')) : 0;
  const otherMethod = text(fd, 'otherMethod') as (typeof PAY_METHODS)[number];
  if (cash === null || other === null || (other > 0 && !PAY_METHODS.includes(otherMethod))) return { error: 'Check the payment amounts.' };
  const tenders = [
    ...(cash > 0 ? [{ id: randomUUID(), method: 'cash' as const, amountPesewas: cash }] : []),
    ...(other > 0 ? [{ id: randomUUID(), method: otherMethod, amountPesewas: other, reference: text(fd, 'otherReference') || undefined }] : []),
  ];
  const a = await approve(ctx, fd, quote.approval);
  if ('error' in a) return { error: a.error };
  const r = await processExchange(getDb(), ctx, { ...base, tenders, approvalToken: a.token }, new Date());
  if (!r.ok) return { error: MESSAGES[r.error] ?? r.error.replaceAll('_', ' ') };
  revalidatePath(`/${slug}/app/returns`);
  return {
    error: null,
    message: `Exchange recorded. ${r.refundPesewas > 0 ? `Give back ${formatCedis(r.refundPesewas)} by ${METHODS[refundMethod!]}.` : `Change ${formatCedis(r.changeDuePesewas)}.`}`,
  };
}
