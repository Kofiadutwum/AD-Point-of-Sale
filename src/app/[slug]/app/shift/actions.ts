'use server';
import { revalidatePath } from 'next/cache';
import type { FormState } from '@/components/form';
import { getDb } from '@/db/client';
import { formatCedis, parseCedis } from '@/lib/money';
import { requestApproval } from '@/server/approvals';
import { cashMovement, closeShift, currentShift, openShift, varianceKey } from '@/server/shifts';
import { pageCtx } from '../page-ctx';

const MESSAGES: Record<string, string> = {
  no_register: 'Shifts are kept at a till: sign in with your PIN on a registered till.', invalid_input: 'Enter the amount in cedis, and a reason.',
  shift_already_open: 'This till already has an open shift.', no_open_shift: 'Open a shift first.',
  reason_required: 'The counted cash does not match: enter a reason.', approval_required: 'A manager must approve this difference: choose who and enter their PIN.',
  self_approval: 'Another person must approve.', not_authorised: 'That person cannot approve.', wrong_pin: 'Wrong PIN.', pin_locked: 'Too many wrong PINs. Try again later.',
};
const text = (fd: FormData, k: string) => String(fd.get(k) ?? '').trim();
const cedis = (fd: FormData, k: string) => (text(fd, k) === '' ? null : parseCedis(text(fd, k)));

export async function openShiftAction(slug: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'make_sale');
  const float = text(fd, 'float') === '' ? 0 : parseCedis(text(fd, 'float'));
  if (float === null) return { error: MESSAGES.invalid_input };
  const r = await openShift(getDb(), ctx, { openingCashPesewas: float }, new Date());
  if (!r.ok) return { error: MESSAGES[r.error] };
  revalidatePath(`/${slug}/app/shift`);
  return { error: null, message: 'Shift opened.' };
}

export async function cashMovementAction(slug: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_cash');
  const amount = cedis(fd, 'amount');
  if (!amount) return { error: MESSAGES.invalid_input };
  const type = text(fd, 'type') === 'paid_in' ? 'paid_in' : 'paid_out';
  const r = await cashMovement(getDb(), ctx, { type, amountPesewas: amount, reason: text(fd, 'reason') }, new Date());
  if (!r.ok) return { error: MESSAGES[r.error] };
  revalidatePath(`/${slug}/app/shift`);
  return { error: null, message: `${type === 'paid_in' ? 'Paid in' : 'Paid out'} ${formatCedis(amount)}.` };
}

export async function closeShiftAction(slug: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'make_sale');
  const counted = cedis(fd, 'counted');
  if (counted === null) return { error: 'Enter the cash you counted, in cedis.' };
  const reason = text(fd, 'reason') || undefined;
  let approvalToken: string | undefined;
  if (text(fd, 'approverId') && text(fd, 'pin')) {
    const shift = await currentShift(getDb(), ctx);
    if (!shift) return { error: MESSAGES.no_open_shift };
    const a = await requestApproval(getDb(), ctx, {
      action: 'cash_variance', contextKey: varianceKey(shift.shiftId, counted - shift.expectedCashPesewas), approverId: text(fd, 'approverId'), pin: text(fd, 'pin'),
    }, new Date());
    if (!a.ok) return { error: MESSAGES[a.error] };
    approvalToken = a.token;
  }
  const r = await closeShift(getDb(), ctx, { countedCashPesewas: counted, reason, approvalToken }, new Date());
  if (!r.ok) return { error: MESSAGES[r.error] };
  revalidatePath(`/${slug}/app/shift`);
  const v = r.variancePesewas;
  return { error: null, message: `Shift closed. Expected ${formatCedis(r.summary.expectedCashPesewas)}, counted ${formatCedis(counted)}${v === 0 ? ': it balances.' : `: ${v > 0 ? 'over' : 'short'} by ${formatCedis(Math.abs(v))}.`}` };
}
