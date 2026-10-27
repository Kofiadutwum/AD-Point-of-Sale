'use server';
import { revalidatePath } from 'next/cache';
import type { FormState } from '@/components/form';
import { getDb } from '@/db/client';
import { recordClosingLeftover, recordPots } from '@/server/pots';
import { recordWastage, type WastageReason } from '@/server/wastage';
import { pageCtx } from '../page-ctx';

const MESSAGES: Record<string, string> = {
  invalid_input: 'Check the quantity and try again.', not_assigned: 'You are not set up at this branch.', not_sold_by_amount: 'Only sell-by-amount items have pots.',
  already_closed: 'The count for this item is already closed.', no_pots: 'Record pots cooked first.', leftover_above_cooked: 'The leftover cannot be more than was cooked.',
  too_old: 'Only today and yesterday can be counted.', unknown_item: 'Pick an item.', use_pot_leftover: 'Count sell-by-amount items with the leftover count.',
  not_wastable: 'Combo meals cannot be wasted as a whole; waste their parts.',
};

async function run(slug: string, message: string, change: (ctx: Awaited<ReturnType<typeof pageCtx>>) => Promise<{ ok: true } | { ok: false; error: string }>): Promise<FormState> {
  const r = await change(await pageCtx(slug, 'record_kitchen_stock'));
  if (!r.ok) return { error: MESSAGES[r.error] ?? 'Something went wrong. Try again.' };
  revalidatePath(`/${slug}/app/kitchen-stock`);
  return { error: null, message };
}
const text = (fd: FormData, key: string) => String(fd.get(key) ?? '').trim();

export async function addPotsAction(slug: string, branchId: string, variantId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  return run(slug, 'Pots recorded.', (ctx) => recordPots(getDb(), ctx, { branchId, variantId, pots: text(fd, 'pots') }, new Date()));
}

export async function closePotAction(slug: string, branchId: string, variantId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const leftover = text(fd, 'leftoverOther') || text(fd, 'leftover');
  return run(slug, 'Count saved.', (ctx) => recordClosingLeftover(getDb(), ctx, { branchId, variantId, leftover }, new Date()));
}

export async function wastageAction(slug: string, branchId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  return run(slug, 'Wastage recorded.', (ctx) => recordWastage(getDb(), ctx, {
    branchId, variantId: text(fd, 'variantId'), quantity: text(fd, 'quantity'), reason: text(fd, 'reason') as WastageReason, note: text(fd, 'note') || undefined,
  }, new Date()));
}
