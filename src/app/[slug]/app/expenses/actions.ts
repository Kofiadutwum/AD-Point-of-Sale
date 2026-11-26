'use server';
import { revalidatePath } from 'next/cache';
import type { FormState } from '@/components/form';
import { getDb } from '@/db/client';
import type { ExpenseMethod } from '@/db/schema';
import { formatCedis, parseCedis } from '@/lib/money';
import { requestApproval } from '@/server/approvals';
import { expenseKey, recordExpense } from '@/server/expenses';
import { pageCtx } from '../page-ctx';

const MESSAGES: Record<string, string> = {
  invalid_input: 'Enter a category and the amount in cedis.', no_branch: 'Choose a branch.', reference_required: 'Enter the MoMo, card, or bank reference.',
  approval_required: 'A manager must approve this expense: choose who and enter their PIN.', self_approval: 'Another person must approve.',
  not_authorised: 'That person cannot approve.', wrong_pin: 'Wrong PIN.', pin_locked: 'Too many wrong PINs. Try again later.',
};
const text = (fd: FormData, k: string) => String(fd.get(k) ?? '').trim();

export async function recordExpenseAction(slug: string, branchId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'record_expenses');
  const amount = parseCedis(text(fd, 'amount'));
  if (!amount) return { error: MESSAGES.invalid_input };
  const branch = text(fd, 'branchId') || branchId;
  let approvalToken: string | undefined;
  if (text(fd, 'approverId') && text(fd, 'pin')) {
    const a = await requestApproval(getDb(), ctx, { action: 'expense', contextKey: expenseKey(branch, amount), approverId: text(fd, 'approverId'), pin: text(fd, 'pin') }, new Date());
    if (!a.ok) return { error: MESSAGES[a.error] };
    approvalToken = a.token;
  }
  const r = await recordExpense(getDb(), ctx, {
    branchId: branch || undefined, category: text(fd, 'category'), amountPesewas: amount, method: text(fd, 'method') as ExpenseMethod,
    reference: text(fd, 'reference') || undefined, note: text(fd, 'note') || undefined, approvalToken,
  }, new Date());
  if (!r.ok) return { error: MESSAGES[r.error] };
  revalidatePath(`/${slug}/app/expenses`);
  return { error: null, message: `Recorded ${formatCedis(amount)}${r.fromShift ? ', paid out of this shift' : ''}.` };
}
