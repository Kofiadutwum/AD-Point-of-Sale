'use server';
import { revalidatePath } from 'next/cache';
import type { FormState } from '@/components/form';
import { getDb } from '@/db/client';
import { formatCedis } from '@/lib/money';
import { recordProduction, saveProductionList } from '@/server/production';
import { lookupStockItem } from '@/server/stock';
import { pageCtx } from '../page-ctx';

const MESSAGES: Record<string, string> = {
  invalid_input: 'Check the quantities.', not_found: 'That item was not found.', not_supported: 'Only items without batch or serial tracking can be made ahead for now.',
  unknown_ingredient: 'An ingredient was not found.', contains_itself: 'An item cannot be made from itself.', no_production_list: 'Set what this item is made from first.',
};
const text = (fd: FormData, k: string) => String(fd.get(k) ?? '').trim();

/** Spec 6.27: what one of the made item takes, ingredients by barcode or SKU in their base units. */
export async function saveListAction(slug: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_products');
  const made = await lookupStockItem(getDb(), ctx, text(fd, 'made'), 'manage_products');
  if (!made) return { error: 'No item has that barcode or SKU.' };
  const ingredients = [];
  for (const k of [0, 1, 2, 3, 4, 5]) {
    if (!text(fd, `code_${k}`)) continue;
    const item = await lookupStockItem(getDb(), ctx, text(fd, `code_${k}`), 'manage_products');
    if (!item) return { error: `No ingredient has the barcode or SKU ${text(fd, `code_${k}`)}.` };
    ingredients.push({ variantId: item.variantId, quantity: text(fd, `qty_${k}`) });
  }
  const r = await saveProductionList(getDb(), ctx, { variantId: made.variantId, ingredients });
  if (!r.ok) return { error: MESSAGES[r.error] };
  revalidatePath(`/${slug}/app/production`);
  return { error: null, message: `Saved what ${made.name} is made from.` };
}

export async function recordAction(slug: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'record_production');
  const r = await recordProduction(getDb(), ctx, { branchId: text(fd, 'branchId'), variantId: text(fd, 'variantId'), quantity: text(fd, 'quantity') }, new Date());
  if (!r.ok) return { error: MESSAGES[r.error] };
  revalidatePath(`/${slug}/app/production`);
  return {
    error: null,
    message: `Recorded. Cost ${formatCedis(Math.round(Number(r.unitCostPesewas)))} each.${r.negativeStock ? ' Some ingredient stock is now below zero: check your counts.' : ''}`,
  };
}
