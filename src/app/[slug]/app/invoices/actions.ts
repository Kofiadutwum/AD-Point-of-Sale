'use server';
import { redirect } from 'next/navigation';
import type { FormState } from '@/components/form';
import { getDb } from '@/db/client';
import { createInvoice } from '@/server/quotes';
import { pageCtx } from '../page-ctx';
import { customerFromForm, itemsFromForm } from '../quotes/form-items';

const MESSAGES: Record<string, string> = {
  no_register: 'Invoice at a till: sign in with your PIN on a registered till.', invoice_needs_customer: 'Enter the phone of the business customer.',
  invalid_due_date: 'Choose the due date.', credit_over_limit: "This would take the customer over their credit limit. Raise it on the customer's account first.",
  unknown_item: 'An item cannot be invoiced.', not_enough_stock: 'Not enough stock of an item.', invalid_input: 'Check the quantities.',
};

export async function createInvoiceAction(slug: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'issue_invoices');
  const customer = await customerFromForm(ctx, fd);
  if ('error' in customer) return { error: customer.error };
  if (!customer.id) return { error: MESSAGES.invoice_needs_customer };
  const items = await itemsFromForm(ctx, fd);
  if ('error' in items) return { error: items.error };
  const r = await createInvoice(getDb(), ctx, { customerId: customer.id, lines: items.lines, dueDate: String(fd.get('dueDate') ?? '') }, new Date());
  if (!r.ok) return { error: MESSAGES[r.error] ?? r.error.replaceAll('_', ' ') };
  redirect(`/${slug}/d/${r.shareCode}`);
}
