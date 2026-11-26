'use server';
import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type { FormState } from '@/components/form';
import { getDb } from '@/db/client';
import { parseCedis } from '@/lib/money';
import type { TenderMethod } from '@/server/sales';
import {
  addTicketLine, cancelTicket, moveTicketLines, payTicket, printBill, removeTicketLine, sendToKitchen, voidSentLine,
} from '@/server/tickets';
import { pageCtx } from '../../page-ctx';

const MESSAGES: Record<string, string> = {
  not_found: 'That ticket or item is no longer there.', not_open: 'This ticket is closed.', invalid_input: 'Check what you entered.',
  unknown_item: 'That item is no longer in the catalogue.', not_sellable: 'That item cannot be sold.', invalid_quantity: 'Check the quantity.',
  invalid_choices: 'Pick the choices again.', invalid_add_ons: 'Pick the add-ons (required groups need a choice).', sold_out: 'Sold out today.',
  already_sent: 'It went to the kitchen already: void it instead.', nothing_new: 'Nothing new to send.', not_sent: 'That item has not gone to the kitchen.',
  self_approval: 'Another person must approve.', not_authorised: 'That person cannot approve voids here.', wrong_pin: 'Wrong PIN.', pin_locked: 'That PIN is locked for 15 minutes.',
  has_sent_lines: 'Items went to the kitchen: void them first.', ticket_not_open: 'This ticket is closed.', payment_incomplete: 'Not enough paid.',
  reference_required: 'Enter the reference for MoMo, card, or bank payments.', reduce_non_cash_amount: 'Only cash can give change.', order_changed: 'The ticket changed. Reload and try again.',
  no_register: 'Take payment from a till (switch in with your PIN).',
};
const text = (fd: FormData, key: string) => String(fd.get(key) ?? '').trim();
const say = (r: { ok: true } | { ok: false; error: string }, slug: string, ticketId: string, done = 'Saved.'): FormState => {
  if (!r.ok) return { error: MESSAGES[r.error] ?? 'Something went wrong. Try again.' };
  revalidatePath(`/${slug}/app/tickets/${ticketId}`);
  return { error: null, message: done };
};
const ctxOf = (slug: string) => pageCtx(slug, 'take_orders');

export async function addLineAction(slug: string, ticketId: string, variantId: string, unitId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  // each add-on group posts its chosen option ids as group-<groupId>
  const addOns = [...fd.keys()].filter((k) => k.startsWith('group-')).flatMap((k) => fd.getAll(k).map(String).filter(Boolean).map((optionId) => ({ groupId: k.slice(6), optionId })));
  const r = await addTicketLine(getDb(), await ctxOf(slug), ticketId, {
    variantId, unitId, quantity: text(fd, 'quantity') || '1', ...(addOns.length ? { addOns } : {}), ...(text(fd, 'note') ? { note: text(fd, 'note') } : {}),
    ...(text(fd, 'seat') ? { seat: Number(text(fd, 'seat')) } : {}),
  }, new Date());
  if (!r.ok) return say(r, slug, ticketId);
  redirect(`/${slug}/app/tickets/${ticketId}`);
}

export async function removeLineAction(slug: string, ticketId: string, lineId: string, _prev: FormState, _fd: FormData): Promise<FormState> {
  return say(await removeTicketLine(getDb(), await ctxOf(slug), lineId), slug, ticketId, 'Removed.');
}

export async function sendAction(slug: string, ticketId: string, _prev: FormState, _fd: FormData): Promise<FormState> {
  return say(await sendToKitchen(getDb(), await ctxOf(slug), ticketId, new Date()), slug, ticketId, 'Sent to the kitchen.');
}

export async function voidAction(slug: string, ticketId: string, lineId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  return say(await voidSentLine(getDb(), await ctxOf(slug), {
    lineId, reason: text(fd, 'reason'), prepared: fd.get('prepared') === 'on', approverId: text(fd, 'approverId'), approverPin: text(fd, 'pin'),
  }, new Date()), slug, ticketId, 'Voided.');
}

export async function moveAction(slug: string, ticketId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const r = await moveTicketLines(getDb(), await ctxOf(slug), { fromTicketId: ticketId, toTicketId: text(fd, 'to'), lineIds: fd.getAll('lineId').map(String) }, new Date());
  if (r.ok && r.merged) redirect(`/${slug}/app/tickets/${text(fd, 'to')}`);
  return say(r, slug, ticketId, 'Moved.');
}

export async function printBillAction(slug: string, ticketId: string, _prev: FormState, _fd: FormData): Promise<FormState> {
  return say(await printBill(getDb(), await ctxOf(slug), ticketId, new Date()), slug, ticketId, 'Bill marked printed.');
}

export async function cancelAction(slug: string, ticketId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const r = await cancelTicket(getDb(), await ctxOf(slug), ticketId, text(fd, 'reason'), new Date());
  if (!r.ok) return say(r, slug, ticketId);
  redirect(`/${slug}/app/tables`);
}

/** One tender from the form fields method<suffix>, amount<suffix>, reference<suffix>; null when the amount is missing. */
function tenderFrom(fd: FormData, suffix = '') {
  const amountPesewas = parseCedis(text(fd, `amount${suffix}`));
  if (amountPesewas === null || amountPesewas <= 0) return null;
  const reference = text(fd, `reference${suffix}`);
  return { id: randomUUID(), method: (text(fd, `method${suffix}`) || 'cash') as TenderMethod, amountPesewas, ...(reference ? { reference } : {}) };
}

async function pay(slug: string, ticketId: string, tenders: NonNullable<ReturnType<typeof tenderFrom>>[], part?: Array<{ lineId: string; quantity: string }>, shares?: number): Promise<FormState> {
  const r = await payTicket(getDb(), await ctxOf(slug), { ticketId, tenders, ...(part ? { part } : {}) }, new Date());
  if (!r.ok) return say(r, slug, ticketId);
  redirect(`/${slug}/app/receipts/${r.saleId}${shares ? `?shares=${shares}` : ''}`);
}

export async function payAction(slug: string, ticketId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const tender = tenderFrom(fd);
  return tender ? pay(slug, ticketId, [tender]) : { error: 'Enter the amount paid in cedis.' };
}

/** Spec 6.38: one person pays the items or quantities chosen for them; the ticket stays open until everything is paid. */
export async function payPartAction(slug: string, ticketId: string, partJson: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const tender = tenderFrom(fd);
  return tender ? pay(slug, ticketId, [tender], JSON.parse(partJson)) : { error: 'Enter the amount paid in cedis.' };
}

/** Spec 6.38: the bill split equally; one tender per share, and the receipt prints a slip per share. */
export async function payEqualAction(slug: string, ticketId: string, shares: number, _prev: FormState, fd: FormData): Promise<FormState> {
  const tenders = Array.from({ length: shares }, (_, i) => tenderFrom(fd, `-${i}`));
  if (tenders.some((x) => x === null)) return { error: 'Enter every share in cedis.' };
  return pay(slug, ticketId, tenders as NonNullable<ReturnType<typeof tenderFrom>>[], undefined, shares);
}
