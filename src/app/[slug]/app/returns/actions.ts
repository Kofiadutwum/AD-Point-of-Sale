'use server';
import { revalidatePath } from 'next/cache';
import type { FormState } from '@/components/form';
import { getDb } from '@/db/client';
import { formatCedis } from '@/lib/money';
import { type ApprovalAction, requestApproval } from '@/server/approvals';
import type { Ctx } from '@/server/context';
import { processReturn, quoteNoReceiptReturn, quoteReturn, type RefundMethod, type ReturnItem, returnWithoutReceipt } from '@/server/returns';
import { lookupStockItem } from '@/server/stock';
import { pageCtx } from '../page-ctx';

const MESSAGES: Record<string, string> = {
  invalid_input: 'Check the quantities and fill in the reason.', not_found: 'That receipt or item was not found.',
  too_many: 'That is more than was sold, less what has come back already.', not_returnable: 'Bundles, meals, combos, and serial or batch items cannot be returned here yet.',
  approval_required: 'A manager must approve: choose who approves and enter their PIN.', reference_required: 'Enter the MoMo, card, or bank reference.',
  needs_customer: 'Store credit needs a customer on the sale.', not_allowed: 'Returns without a receipt are switched off in shop settings.',
  monthly_limit: 'This customer has reached the monthly limit for returns without a receipt.', no_price_history: 'That item has not sold in the last 90 days.',
  self_approval: 'Another person must approve.', not_authorised: 'That person cannot approve.', wrong_pin: 'Wrong PIN.', pin_locked: 'Too many wrong PINs. Try again later.',
};
const METHODS: Record<RefundMethod, string> = { cash: 'cash', momo_manual: 'MoMo', card_terminal: 'card', bank_transfer: 'bank transfer', store_credit: 'store credit' };
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
