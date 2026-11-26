'use server';
import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import type { FormState } from '@/components/form';
import { getDb } from '@/db/client';
import { formatCedis, parseCedis } from '@/lib/money';
import { requestApproval } from '@/server/approvals';
import { cancelQuote, convertQuoteToSale, createInvoice } from '@/server/quotes';
import { pageCtx } from '../../page-ctx';

const text = (fd: FormData, k: string) => String(fd.get(k) ?? '').trim();
const MESSAGES: Record<string, string> = {
  not_open: 'This quote was already used or cancelled.', approval_required: 'The quote has expired: a manager must approve its prices (choose who and enter their PIN).',
  no_register: 'Sell or invoice at a till: sign in with your PIN on a registered till.', payment_incomplete: 'Not enough paid yet.', invoice_needs_customer: 'Invoices need the customer on the quote.',
  invalid_due_date: 'Choose the due date.', credit_over_limit: "This would take the customer over their credit limit. Raise it on the customer's account first.",
  reference_required: 'Enter the MoMo, card, or bank reference.', not_enough_stock: 'Not enough stock of an item.', credit_not_allowed: 'You cannot sell on credit.',
  wrong_pin: 'Wrong PIN.', not_authorised: 'That person cannot approve.', self_approval: 'Another person must approve.', pin_locked: 'Too many wrong PINs. Try again later.',
};
const say = (code: string) => MESSAGES[code] ?? code.replaceAll('_', ' ');

async function expiredApproval(slug: string, quoteId: string, fd: FormData): Promise<{ token?: string } | { error: string }> {
  if (!text(fd, 'approverId') || !text(fd, 'pin')) return {};
  const ctx = await pageCtx(slug, 'make_sale');
  const a = await requestApproval(getDb(), ctx, { action: 'honour_expired_quote', contextKey: quoteId, approverId: text(fd, 'approverId'), pin: text(fd, 'pin') }, new Date());
  return a.ok ? { token: a.token } : { error: say(a.error) };
}

export async function sellQuoteAction(slug: string, quoteId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'make_sale');
  const cash = text(fd, 'cash') ? parseCedis(text(fd, 'cash')) : 0;
  const other = text(fd, 'otherAmount') ? parseCedis(text(fd, 'otherAmount')) : 0;
  const method = text(fd, 'otherMethod') as 'momo_manual' | 'card_terminal' | 'bank_transfer';
  if (cash === null || other === null) return { error: 'Check the payment amounts.' };
  const a = await expiredApproval(slug, quoteId, fd);
  if ('error' in a) return { error: a.error };
  const tenders = [
    ...(cash > 0 ? [{ id: randomUUID(), method: 'cash' as const, amountPesewas: cash }] : []),
    ...(other > 0 ? [{ id: randomUUID(), method, amountPesewas: other, reference: text(fd, 'otherReference') || undefined }] : []),
  ];
  const r = await convertQuoteToSale(getDb(), ctx, { quoteId, tenders, approvalToken: a.token }, new Date());
  if (!r.ok) return { error: say(r.error) };
  revalidatePath(`/${slug}/app/quotes/${quoteId}`);
  return { error: null, message: `Sold. Change ${formatCedis(r.changeDuePesewas)}.` };
}

export async function invoiceQuoteAction(slug: string, quoteId: string, customerId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'issue_invoices');
  const a = await expiredApproval(slug, quoteId, fd);
  if ('error' in a) return { error: a.error };
  const r = await createInvoice(getDb(), ctx, { customerId, quoteId, dueDate: text(fd, 'dueDate'), approvalToken: a.token }, new Date());
  if (!r.ok) return { error: say(r.error) };
  revalidatePath(`/${slug}/app/quotes/${quoteId}`);
  return { error: null, message: `Invoice ${r.number} issued. Share it: /${slug}/d/${r.shareCode}` };
}

export async function cancelQuoteAction(slug: string, quoteId: string): Promise<FormState> {
  const ctx = await pageCtx(slug, 'make_sale');
  const r = await cancelQuote(getDb(), ctx, quoteId);
  if (!r.ok) return { error: say(r.error) };
  revalidatePath(`/${slug}/app/quotes/${quoteId}`);
  return { error: null, message: 'Quote cancelled.' };
}
