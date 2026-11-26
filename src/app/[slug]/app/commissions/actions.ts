'use server';
import { revalidatePath } from 'next/cache';
import type { FormState } from '@/components/form';
import { getDb } from '@/db/client';
import { parseCedis } from '@/lib/money';
import { deactivateCommissionRule, markCommissionPaid, saveCommissionRule } from '@/server/rewards';
import { lookupStockItem } from '@/server/stock';
import { pageCtx } from '../page-ctx';

const text = (fd: FormData, k: string) => String(fd.get(k) ?? '').trim();

export async function saveRuleAction(slug: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_commissions');
  let productId: string | null = null;
  if (text(fd, 'code')) {
    const item = await lookupStockItem(getDb(), ctx, text(fd, 'code'), 'manage_commissions');
    if (!item) return { error: 'No item has that barcode or SKU.' };
    productId = item.productId;
  }
  const pct = text(fd, 'percent') ? Math.round(Number(text(fd, 'percent')) * 100) : null;
  const fixed = text(fd, 'fixed') ? parseCedis(text(fd, 'fixed')) : null;
  const r = await saveCommissionRule(getDb(), ctx, { userId: text(fd, 'userId') || null, productId, categoryId: text(fd, 'categoryId') || null, percentBp: pct, fixedPesewas: fixed });
  if (!r.ok) return { error: 'Give either a percent or a fixed amount per item, not both.' };
  revalidatePath(`/${slug}/app/commissions`);
  return { error: null, message: 'Rule saved. It applies to sales from now on.' };
}

export async function removeRuleAction(slug: string, id: string): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_commissions');
  await deactivateCommissionRule(getDb(), ctx, id);
  revalidatePath(`/${slug}/app/commissions`);
  return { error: null, message: 'Rule removed.' };
}

export async function markPaidAction(slug: string, userId: string, from: string, to: string): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_commissions');
  const r = await markCommissionPaid(getDb(), ctx, { userId, from, to }, new Date());
  if (!r.ok) return { error: 'Check the dates.' };
  revalidatePath(`/${slug}/app/commissions`);
  return { error: null, message: `Marked GHS ${(r.paidPesewas / 100).toFixed(2)} as paid.` };
}
