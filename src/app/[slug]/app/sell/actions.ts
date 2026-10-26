'use server';
import { getDb } from '@/db/client';
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
