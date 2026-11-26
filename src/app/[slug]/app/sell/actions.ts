'use server';
import { getDb } from '@/db/client';
import { requestApproval } from '@/server/approvals';
import { previewCoupon } from '@/server/promotions';
import { type Customer, listCustomers } from '@/server/customers';
import { type CatalogueHit, searchCatalogue } from '@/server/products';
import { lookupTillItem, type TillItem, tillItemForVariant } from '@/server/till';
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
