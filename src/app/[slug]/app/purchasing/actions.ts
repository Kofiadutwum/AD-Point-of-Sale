'use server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type { FormState } from '@/components/form';
import { getDb } from '@/db/client';
import { parseCedis } from '@/lib/money';
import {
  closePurchaseOrder, createPurchaseOrder, getPurchaseOrder, markPurchaseOrderSent, payBill, receivePurchaseOrder, returnToSupplier, saveSupplier, setSupplierItem, suggestPurchaseOrders, type SupplierPayMethod,
} from '@/server/purchasing';
import { lookupStockItem } from '@/server/stock';
import { pageCtx } from '../page-ctx';
import { LINE_ERRORS, linesFromForm } from '../stock/form-lines';

const text = (fd: FormData, k: string) => String(fd.get(k) ?? '').trim();
const say = (code: string) => MESSAGES[code] ?? LINE_ERRORS[code] ?? code.replaceAll('_', ' ');
const MESSAGES: Record<string, string> = {
  duplicate_name: 'A supplier with that name exists.', invalid_line: 'Check the items and quantities.', not_open: 'This order is not open for receiving (send it first).',
  over_received: 'That is more than was ordered.', too_much: 'That is more than the bill.', not_enough_credit: 'Not enough supplier credit.', reference_required: 'Enter the payment reference.',
  reason_required: 'Say why the goods go back.', batch_required: 'Batch items need a batch number and expiry.', expired_batch: 'Cannot receive expired stock.', serials_mismatch: 'Enter one serial number per unit.',
  duplicate_serial: 'A serial number is already in stock.', not_purchasable: 'That unit cannot be bought.', batch_expiry_mismatch: 'That batch number has a different expiry.',
};
const done = (slug: string) => revalidatePath(`/${slug}/app/purchasing`);

export async function saveSupplierAction(slug: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_purchasing');
  const r = await saveSupplier(getDb(), ctx, { name: text(fd, 'name'), phone: text(fd, 'phone'), email: text(fd, 'email'), paymentTermsDays: Number(text(fd, 'terms') || 0), leadTimeDays: Number(text(fd, 'lead') || 7), note: text(fd, 'note') });
  if (!r.ok) return { error: r.error === 'invalid_input' ? 'Check the name, phone, email, and days.' : say(r.error) };
  done(slug);
  return { error: null, message: 'Supplier saved.' };
}

export async function linkItemAction(slug: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_purchasing');
  const item = await lookupStockItem(getDb(), ctx, text(fd, 'code'), 'manage_purchasing');
  if (!item) return { error: 'No item has that barcode or SKU. Scan the pack barcode to set the pack size.' };
  const cost = text(fd, 'cost') ? parseCedis(text(fd, 'cost')) : undefined;
  if (cost === null) return { error: 'Enter the cost in cedis.' };
  const r = await setSupplierItem(getDb(), ctx, { supplierId: text(fd, 'supplierId'), variantId: item.variantId, unitId: item.unitId, lastCostPesewas: cost, isMain: fd.get('isMain') === 'on' });
  if (!r.ok) return { error: 'That unit cannot be bought, or the supplier was not found.' };
  return { error: null, message: `${item.name} (${item.unitName}) linked.` };
}

export async function createPoAction(slug: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_purchasing');
  const l = await linesFromForm(ctx, fd, 'manage_purchasing');
  if ('error' in l) return { error: l.error };
  const r = await createPurchaseOrder(getDb(), ctx, { branchId: text(fd, 'branchId'), supplierId: text(fd, 'supplierId'), note: text(fd, 'note'), lines: l.lines.map((x) => ({ variantId: x.variantId, unitId: x.unitId, quantity: x.quantity, unitCostPesewas: x.costPesewas })) });
  if (!r.ok) return { error: say(r.error) };
  redirect(`/${slug}/app/purchasing/${r.purchaseOrderId}`);
}

export async function suggestAction(slug: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_purchasing');
  const r = await suggestPurchaseOrders(getDb(), ctx, text(fd, 'branchId'), new Date());
  if (!r.ok) return { error: 'Branch not found.' };
  done(slug);
  const extra = r.noSupplier.length ? ` No main supplier for: ${r.noSupplier.slice(0, 5).join(', ')}${r.noSupplier.length > 5 ? '…' : ''}.` : '';
  return { error: null, message: r.created.length ? `${r.created.length} draft order(s) ready to review.${extra}` : `Nothing needs ordering.${extra}` };
}

export async function payBillAction(slug: string, billId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_purchasing');
  const amount = parseCedis(text(fd, 'amount'));
  if (!amount) return { error: 'Enter the amount in cedis.' };
  const r = await payBill(getDb(), ctx, { billId, amountPesewas: amount, method: text(fd, 'method') as SupplierPayMethod, reference: text(fd, 'reference') });
  if (!r.ok) return { error: say(r.error) };
  done(slug);
  return { error: null, message: 'Payment recorded.' };
}

export async function supplierReturnAction(slug: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_purchasing');
  const l = await linesFromForm(ctx, fd, 'manage_purchasing');
  if ('error' in l) return { error: l.error };
  const credit = text(fd, 'credit') ? parseCedis(text(fd, 'credit')) : undefined;
  if (credit === null) return { error: 'Enter the credit in cedis.' };
  const r = await returnToSupplier(getDb(), ctx, { branchId: text(fd, 'branchId'), supplierId: text(fd, 'supplierId'), reason: text(fd, 'reason'), creditPesewas: credit, lines: l.lines });
  if (!r.ok) return { error: say(r.error) };
  done(slug);
  return { error: null, message: 'Return recorded; the supplier credit can pay their bills.' };
}

export async function markSentAction(slug: string, poId: string): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_purchasing');
  const r = await markPurchaseOrderSent(getDb(), ctx, poId, new Date());
  revalidatePath(`/${slug}/app/purchasing/${poId}`);
  return r.ok ? { error: null, message: 'Marked as sent.' } : { error: 'Only a draft can be sent.' };
}

export async function receivePoAction(slug: string, poId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_purchasing');
  const po = await getPurchaseOrder(getDb(), ctx, poId);
  if (!po) return { error: 'Order not found.' };
  const lines = [];
  for (const l of po.lines) {
    const q = text(fd, `rq_${l.id}`);
    if (!q || Number(q) === 0) continue;
    const cost = parseCedis(text(fd, `rc_${l.id}`) || '0');
    if (cost === null) return { error: 'Enter costs in cedis.' };
    lines.push({ lineId: l.id, quantity: q, totalCostPesewas: cost, batchNumber: text(fd, `rb_${l.id}`) || undefined, expiryDate: text(fd, `re_${l.id}`) || undefined,
      serials: text(fd, `rs_${l.id}`) ? text(fd, `rs_${l.id}`).split(/\s+/) : undefined });
  }
  const r = await receivePurchaseOrder(getDb(), ctx, { purchaseOrderId: poId, lines, paidNow: fd.get('paidNow') === 'on', billReference: text(fd, 'billReference') }, new Date());
  if (!r.ok) return { error: say(r.error) };
  revalidatePath(`/${slug}/app/purchasing/${poId}`);
  return { error: null, message: `Received (${r.status === 'received' ? 'complete' : 'part'}).${r.billId ? ' A supplier bill was recorded.' : ''}` };
}

export async function closePoAction(slug: string, poId: string): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_purchasing');
  await closePurchaseOrder(getDb(), ctx, poId);
  revalidatePath(`/${slug}/app/purchasing/${poId}`);
  return { error: null, message: 'Order closed.' };
}
