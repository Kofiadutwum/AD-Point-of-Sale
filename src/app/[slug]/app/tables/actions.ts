'use server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type { FormState } from '@/components/form';
import { getDb } from '@/db/client';
import type { DiningOption } from '@/lib/food';
import { saveServiceCharge, saveTable } from '@/server/tables';
import { openTicket } from '@/server/tickets';
import { pageCtx } from '../page-ctx';

const MESSAGES: Record<string, string> = {
  invalid_input: 'Check the name and try again.', no_branch: 'Open tables from a till, or ask a manager to set your branch.',
  table_taken: 'Another waiter just opened this table.', unknown_table: 'That table is not in use.', mode_not_allowed: 'Turn on table service for this branch first.',
  duplicate_name: 'Another table already has that name.', not_assigned: 'You do not work at this branch.', not_found: 'That table no longer exists.',
};
const text = (fd: FormData, key: string) => String(fd.get(key) ?? '').trim();

async function open(slug: string, input: Parameters<typeof openTicket>[2]): Promise<FormState> {
  const r = await openTicket(getDb(), await pageCtx(slug, 'take_orders'), input, new Date());
  if (!r.ok) return { error: MESSAGES[r.error] ?? 'Something went wrong. Try again.' };
  redirect(`/${slug}/app/tickets/${r.ticketId}`);
}

export async function openTableAction(slug: string, tableId: string, _prev: FormState, _fd: FormData): Promise<FormState> {
  return open(slug, { tableId, diningOption: 'eat_in' });
}

export async function newTicketAction(slug: string, _prev: FormState, fd: FormData): Promise<FormState> {
  return open(slug, { label: text(fd, 'label'), diningOption: (text(fd, 'diningOption') || 'eat_in') as DiningOption });
}

export async function saveTableAction(slug: string, branchId: string, tableId: string | null, _prev: FormState, fd: FormData): Promise<FormState> {
  const r = await saveTable(getDb(), await pageCtx(slug, 'manage_shop_settings'), { ...(tableId ? { id: tableId } : {}), branchId, name: text(fd, 'name'), active: fd.get('active') === 'on' });
  if (!r.ok) return { error: MESSAGES[r.error] ?? 'Something went wrong. Try again.' };
  revalidatePath(`/${slug}/app/tables`);
  return { error: null, message: 'Table saved.' };
}

export async function serviceChargeAction(slug: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const percent = text(fd, 'percent') || '0';
  const bp = /^\d{1,2}(\.\d{1,2})?$/.test(percent) ? Math.round(Number(percent) * 100) : -1;
  const r = await saveServiceCharge(getDb(), await pageCtx(slug, 'manage_shop_settings'), bp);
  if (!r.ok) return { error: 'Enter a service charge from 0 to 25%.' };
  revalidatePath(`/${slug}/app/tables`);
  return { error: null, message: 'Service charge saved.' };
}
