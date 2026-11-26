'use server';
import { redirect } from 'next/navigation';
import type { FormState } from '@/components/form';
import { getDb } from '@/db/client';
import { createQuote } from '@/server/quotes';
import { pageCtx } from '../page-ctx';
import { customerFromForm, itemsFromForm } from './form-items';

const MESSAGES: Record<string, string> = {
  invalid_input: 'Check the quantities and the days the quote is valid.', no_branch: 'Sign in at a till or with a single branch.', unknown_customer: 'That customer no longer exists.',
  unknown_item: 'An item cannot be quoted (combos and items sold by amount are not quoted).', discount_not_allowed: 'You cannot give discounts.',
};

export async function createQuoteAction(slug: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'make_sale');
  const customer = await customerFromForm(ctx, fd);
  if ('error' in customer) return { error: customer.error };
  const items = await itemsFromForm(ctx, fd);
  if ('error' in items) return { error: items.error };
  const r = await createQuote(getDb(), ctx, {
    customerId: customer.id ?? undefined, lines: items.lines, validDays: Number(fd.get('validDays') || 7), note: String(fd.get('note') ?? ''),
  }, new Date());
  if (!r.ok) return { error: MESSAGES[r.error] };
  redirect(`/${slug}/app/quotes/${r.quoteId}`);
}
