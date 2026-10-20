'use server';
import { revalidatePath } from 'next/cache';
import type { FormState } from '@/components/form';
import { getDb } from '@/db/client';
import type { PriceListKind } from '@/db/schema';
import { formatCedis } from '@/lib/money';
import { createPriceList, quotePrice, removePriceListItem, updatePriceList } from '@/server/price-lists';
import { parseScannedCode } from '@/server/scan';
import { pageCtx } from '../page-ctx';
import { ticked, value } from '../products/form-data';

const MESSAGES: Record<string, string> = {
  retail_exists: 'This shop already has a Retail list.',
  branch_has_list: 'That branch already has a price list.',
  unknown_branch: 'Choose a branch.',
  invalid_quantity: 'Enter a quantity above zero; whole numbers for items sold whole.',
  not_found: 'This item no longer exists.',
};
const message = (error: string) => MESSAGES[error] ?? 'Check the details.';
const optionalDate = (fd: FormData, key: string) => value(fd, key) || null;

export async function createPriceListAction(slug: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_products');
  const kind = value(fd, 'kind') as PriceListKind;
  const r = await createPriceList(getDb(), ctx, {
    name: value(fd, 'name'), kind, branchId: kind === 'branch' ? value(fd, 'branchId') : null,
    startsOn: optionalDate(fd, 'startsOn'), endsOn: optionalDate(fd, 'endsOn'),
  });
  if (!r.ok) return { error: message(r.error) };
  revalidatePath(`/${slug}/app/price-lists`);
  return { error: null, message: 'Price list created.' };
}

export async function updatePriceListAction(slug: string, priceListId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_products');
  const r = await updatePriceList(getDb(), ctx, priceListId, {
    name: value(fd, 'name'), startsOn: optionalDate(fd, 'startsOn'), endsOn: optionalDate(fd, 'endsOn'), active: ticked(fd, 'active'),
  });
  if (!r.ok) return { error: message(r.error) };
  revalidatePath(`/${slug}/app/price-lists`);
  return { error: null, message: 'Saved.' };
}

export async function removePriceAction(slug: string, itemId: string, _prev: FormState, _fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_products');
  const r = await removePriceListItem(getDb(), ctx, itemId);
  if (!r.ok) return { error: message(r.error) };
  revalidatePath(`/${slug}/app/price-lists`);
  return { error: null, message: 'Price removed.' };
}

export async function priceCheckAction(slug: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_products');
  const scan = await parseScannedCode(getDb(), ctx, value(fd, 'code'));
  if (!scan.found) return { error: 'No item has that barcode.' };
  const r = await quotePrice(getDb(), ctx, {
    unitId: scan.unitId, quantity: value(fd, 'quantity'), branchId: value(fd, 'branchId'), priceListId: value(fd, 'priceListId') || null,
  }, new Date());
  if (!r.ok) return { error: message(r.error) };
  return { error: null, message: `${formatCedis(r.unitPricePesewas)} each` };
}
