'use server';
import { revalidatePath } from 'next/cache';
import type { FormState } from '@/components/form';
import { getDb } from '@/db/client';
import { handOverOrder, markOrderReady, tickPackedLine } from '@/server/kitchen';
import { cancelPhoneOrder } from '@/server/phone-orders';
import { pageCtx } from '../page-ctx';

const MESSAGES: Record<string, string> = {
  not_found: 'That order is no longer open.', wrong_status: 'That order has already moved on.', no_packing: 'Eat-in orders are not packed.',
  unknown_line: 'That item is not on the order.', not_packed: 'Pack every item before handing over.', invalid_input: 'Write who took the order.',
  not_paid: 'Take payment at the till first.', already_paid: 'This order is paid; refund it instead of cancelling.',
};

async function run(slug: string, change: (ctx: Awaited<ReturnType<typeof pageCtx>>) => Promise<{ ok: true } | { ok: false; error: string }>): Promise<FormState> {
  const r = await change(await pageCtx(slug, 'run_kitchen'));
  if (!r.ok) return { error: MESSAGES[r.error] ?? 'Something went wrong. Try again.' };
  revalidatePath(`/${slug}/app/kitchen`);
  return { error: null };
}

export async function readyAction(slug: string, orderId: string, _prev: FormState, _fd: FormData): Promise<FormState> {
  return run(slug, (ctx) => markOrderReady(getDb(), ctx, orderId, new Date()));
}

export async function packAction(slug: string, orderId: string, lineNo: number, packed: boolean, _prev: FormState, _fd: FormData): Promise<FormState> {
  return run(slug, (ctx) => tickPackedLine(getDb(), ctx, { orderId, lineNo, packed }, new Date()));
}

export async function cancelPhoneOrderAction(slug: string, orderId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const r = await cancelPhoneOrder(getDb(), await pageCtx(slug, 'enter_channel_orders'), { kitchenOrderId: orderId, reason: String(fd.get('reason') ?? '') }, new Date());
  if (!r.ok) return { error: MESSAGES[r.error] ?? 'Something went wrong. Try again.' };
  revalidatePath(`/${slug}/app/kitchen`);
  return { error: null };
}

export async function handOverAction(slug: string, orderId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  return run(slug, (ctx) => handOverOrder(getDb(), ctx, { orderId, handedTo: String(fd.get('handedTo') ?? '') || undefined }, new Date()));
}
