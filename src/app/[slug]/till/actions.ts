'use server';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { FormState } from '@/components/form';
import { getDb } from '@/db/client';
import { cookieOptions, DEVICE_COOKIE, SESSION_COOKIE } from '@/lib/cookies';
import { AccessError, requireContext } from '@/server/context';
import { type PinError, registerBranch, switchCashierWithPin } from '@/server/devices';
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
