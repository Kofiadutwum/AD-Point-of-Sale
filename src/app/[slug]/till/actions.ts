'use server';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { FormState } from '@/components/form';
import { getDb } from '@/db/client';
import { cookieOptions, DEVICE_COOKIE, SESSION_COOKIE } from '@/lib/cookies';
import { AccessError, requireContext } from '@/server/context';
import { type PinError, registerBranch, switchCashierWithPin } from '@/server/devices';
import type { DiningOption } from '@/lib/food';
import { createPhoneOrder, findPhoneOrder, type PhoneOrderInput } from '@/server/phone-orders';
import { markAvailable, markSoldOut } from '@/server/sold-out';

const MESSAGES: Record<PinError, string> = {
  device_not_registered: 'This device is not registered as a till. Ask a manager to register it.',
  not_assigned: 'You are not set up to sell on this till.',
  pin_locked: 'PIN locked for 15 minutes. Your manager has been told.',
  wrong_pin: 'Wrong PIN.',
};

export async function pinAction(slug: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const jar = await cookies();
  const r = await switchCashierWithPin(getDb(), {
    deviceToken: jar.get(DEVICE_COOKIE)?.value, staffId: String(formData.get('staffId') ?? ''), pin: String(formData.get('pin') ?? ''),
  }, new Date());
  if (!r.ok) return { error: MESSAGES[r.error] };
  jar.set(SESSION_COOKIE, r.token, cookieOptions(r.expiresAt));
  redirect(`/${slug}/app`);
}

const SOLD_OUT_MESSAGES = {
  invalid_input: 'Pick an item first.', unknown_item: 'That item is not in the catalogue.', not_assigned: 'You are not set up to sell at this branch.',
} as const;

/** Spec 6.55: from the till's PIN session; the branch is the branch of the session's till. */
async function soldOutChange(slug: string, variantId: string, soldOut: boolean): Promise<{ ok: true } | { ok: false; error: string }> {
  const db = getDb();
  const now = new Date();
  let ctx;
  try {
    ctx = await requireContext(db, { slug, sessionToken: (await cookies()).get(SESSION_COOKIE)?.value, permission: 'mark_sold_out' }, now);
  } catch (e) {
    if (e instanceof AccessError) return { ok: false, error: 'Switch in with your PIN to mark items sold out.' };
    throw e;
  }
  if (!ctx.registerId) return { ok: false, error: 'Mark items sold out from a till.' };
  const branchId = await registerBranch(db, ctx);
  const r = soldOut
    ? await markSoldOut(db, ctx, { branchId, variantId }, now)
    : await markAvailable(db, ctx, { branchId, variantId }, now);
  return r.ok ? { ok: true } : { ok: false, error: SOLD_OUT_MESSAGES[r.error] };
}

export async function markSoldOutAction(slug: string, variantId: string) {
  return soldOutChange(slug, variantId, true);
}

export async function markAvailableAction(slug: string, variantId: string) {
  return soldOutChange(slug, variantId, false);
}

const PHONE_MESSAGES: Record<string, string> = {
  invalid_input: 'Check the order and try again.', no_register: 'Take phone orders from a till.', unknown_channel: 'Pick the phone or WhatsApp channel.',
  customer_details_required: 'Enter the name, a Ghana phone number, and a pickup time or address.', unknown_item: 'An item is no longer in the catalogue.',
  not_sellable: 'An item cannot be sold.', invalid_quantity: 'Check the quantities and amounts.', invalid_choices: 'Pick the combo choices again.', invalid_add_ons: 'Pick the add-ons again.',
  sold_out: 'An item is sold out today.',
};

async function channelCtx(slug: string) {
  try {
    return await requireContext(getDb(), { slug, sessionToken: (await cookies()).get(SESSION_COOKIE)?.value, permission: 'enter_channel_orders' }, new Date());
  } catch (e) {
    if (e instanceof AccessError) return null;
    throw e;
  }
}

/** Spec 6.57: a phone or WhatsApp order sent to the kitchen now and paid when collected. Online only. */
export async function createPhoneOrderAction(slug: string, input: PhoneOrderInput): Promise<{ ok: true; orderNumber: string } | { ok: false; error: string }> {
  const ctx = await channelCtx(slug);
  if (!ctx) return { ok: false, error: 'Switch in with your PIN to take phone orders.' };
  const r = await createPhoneOrder(getDb(), ctx, input, new Date());
  return r.ok ? { ok: true, orderNumber: r.orderNumber } : { ok: false, error: PHONE_MESSAGES[r.error] ?? 'Something went wrong. Try again.' };
}

export type CollectableOrder = {
  kitchenOrderId: string; channelId: string; diningOption: DiningOption; customerName: string;
  lines: Array<{
    variantId: string; unitId: string; quantity: string; byAmount?: boolean; amountPesewas?: number; choices?: Array<{ slotId: string; variantId: string }>;
    addOns?: Array<{ groupId: string; optionId: string }>; note?: string;
  }>;
};

/** Today's unpaid phone order with this number, to load into a locked cart for payment. */
export async function findPhoneOrderAction(slug: string, orderNumber: string): Promise<{ ok: true; order: CollectableOrder } | { ok: false; error: string }> {
  const ctx = await channelCtx(slug);
  if (!ctx) return { ok: false, error: 'Switch in with your PIN to collect phone orders.' };
  const order = await findPhoneOrder(getDb(), ctx, orderNumber, new Date());
  return order ? { ok: true, order } : { ok: false, error: 'No unpaid phone order with that number today.' };
}
