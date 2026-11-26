'use server';
import { getDb } from '@/db/client';
import { requestApproval } from '@/server/approvals';
import { previewCoupon } from '@/server/promotions';
import { type Customer, listCustomers } from '@/server/customers';
import { type CatalogueHit, searchCatalogue } from '@/server/products';
import { lookupTillItem, type TillItem, tillItemForVariant } from '@/server/till';
import QRCode from 'qrcode';
import { checkTillCharge, startTillCharge } from '@/server/shop-paystack';
import { pageCtx } from '../page-ctx';

/** A scanned or typed code; when it is not a code, catalogue matches to pick from (spec 6.5). */
export async function findItemAction(
  slug: string, input: { code: string; branchId: string; customerId: string | null },
): Promise<{ item: TillItem | null; hits: CatalogueHit[] }> {
  const ctx = await pageCtx(slug, 'make_sale');
  const item = await lookupTillItem(getDb(), ctx, input, new Date());
  if (item) return { item, hits: [] };
  return { item: null, hits: input.code.trim() ? await searchCatalogue(getDb(), ctx, { query: input.code, limit: 10 }) : [] };
}

/** Prices a picked item, or re-prices a line when its quantity or customer changes (quantity breaks, customer lists). */
export async function priceItemAction(
  slug: string, input: { variantId: string; unitId?: string; quantity: string; branchId: string; customerId: string | null },
): Promise<TillItem | null> {
  const ctx = await pageCtx(slug, 'make_sale');
  return tillItemForVariant(getDb(), ctx, input, new Date());
}

export async function findCustomersAction(slug: string, query: string): Promise<Customer[]> {
  const ctx = await pageCtx(slug, 'make_sale');
  return query.trim() ? listCustomers(getDb(), ctx, { query, limit: 5 }) : [];
}

/** Spec 6.36: a pharmacist approves prescription-only medicine on this sale with their PIN. */
export async function rxApprovalAction(slug: string, saleId: string, approverId: string, pin: string): Promise<{ token: string } | { error: string }> {
  const ctx = await pageCtx(slug, 'make_sale');
  if (!approverId || !pin) return { error: 'A pharmacist must approve: choose who and enter their PIN.' };
  const r = await requestApproval(getDb(), ctx, { action: 'dispense_prescription', contextKey: saleId, approverId, pin }, new Date());
  if (r.ok) return { token: r.token };
  return { error: r.error === 'wrong_pin' ? 'Wrong PIN.' : r.error === 'pin_locked' ? 'Too many wrong PINs. Try again later.' : 'That person cannot approve.' };
}

/** Spec 6.29: checks a coupon so the till can show its discount; the sale uses it up. */
export async function checkCouponAction(slug: string, input: { code: string; customerId: string | null; branchId: string }) {
  const ctx = await pageCtx(slug, 'make_sale');
  return previewCoupon(getDb(), ctx, input.code, input.customerId, input.branchId, new Date());
}

const CHARGE_ERRORS: Record<string, string> = {
  not_connected: 'Connect Paystack under Payments and integrations first.', no_register: 'Paystack charges are taken on a registered till.',
  unknown_item: 'Some items cannot be charged by Paystack (combos and sell-by-amount items). Take another payment.', discount_not_allowed: 'You may not give discounts.',
  provider_unavailable: 'Paystack is not answering. Try again or take another payment.', invalid_input: 'Add items first.',
};

/** Spec 4.3: opens a Paystack charge on the shop's own account; the customer pays on their phone by scanning the code. */
export async function startPaystackAction(slug: string, input: { customerId: string | null; lines: Array<{ variantId: string; unitId: string; quantity: string; discountPesewas: number }> }) {
  const ctx = await pageCtx(slug, 'make_sale');
  const r = await startTillCharge(getDb(), ctx, input, new Date());
  if (!r.ok) return { ok: false as const, error: CHARGE_ERRORS[r.error] ?? 'The charge could not start.' };
  return { ok: true as const, reference: r.reference, url: r.authorizationUrl, amountPesewas: r.amountPesewas, qr: await QRCode.toString(r.authorizationUrl, { type: 'svg', margin: 1 }) };
}

/** The till polls this; the sale exists only once Paystack confirms the money. */
export async function checkPaystackAction(slug: string, reference: string) {
  const ctx = await pageCtx(slug, 'make_sale');
  const r = await checkTillCharge(getDb(), ctx, reference, new Date());
  const o = r.outcome;
  if (o === 'completed') return { state: 'paid' as const, saleId: r.saleId ?? null, receiptNumber: 'receiptNumber' in r ? r.receiptNumber ?? null : null };
  if (typeof o === 'object') return { state: 'stuck' as const, error: o.paidNotRecorded === 'no_open_shift' ? 'Paid, but this till has no open shift. Open one; the sale is recorded on the next check.' : 'Paid, but the sale could not be recorded yet. It retries on the next check.' };
  return { state: o === 'pending' ? 'waiting' as const : 'failed' as const };
}
