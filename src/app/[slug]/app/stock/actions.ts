'use server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type { FormState } from '@/components/form';
import { getDb } from '@/db/client';
import type { AdjustmentReason } from '@/db/schema';
import { type ApprovalAction, requestApproval } from '@/server/approvals';
import type { Ctx } from '@/server/context';
import { adjustmentKey, adjustStock, cancelCount, finishCount, getCount, receiveTransfer, recordCount, sendTransfer, startCount } from '@/server/inventory';
import { pageCtx } from '../page-ctx';
import { LINE_ERRORS, linesFromForm } from './form-lines';

const text = (fd: FormData, k: string) => String(fd.get(k) ?? '').trim();
const say = (code: string) => LINE_ERRORS[code] ?? code.replaceAll('_', ' ');

/** A manager's approval token when an approver and PIN were given, else nothing. */
async function approval(ctx: Ctx, fd: FormData, action: ApprovalAction, contextKey: string): Promise<{ token?: string } | { error: string }> {
  if (!text(fd, 'approverId') || !text(fd, 'pin')) return {};
  const a = await requestApproval(getDb(), ctx, { action, contextKey, approverId: text(fd, 'approverId'), pin: text(fd, 'pin') }, new Date());
  return a.ok ? { token: a.token } : { error: say(a.error) };
}

export async function sendTransferAction(slug: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'transfer_stock');
  const l = await linesFromForm(ctx, fd, 'receive_stock');
  if ('error' in l) return { error: l.error };
  const r = await sendTransfer(getDb(), ctx, { fromBranchId: text(fd, 'fromBranchId'), toBranchId: text(fd, 'toBranchId'), lines: l.lines, note: text(fd, 'note') }, new Date());
  if (!r.ok) return { error: r.error === 'same_branch' ? 'Choose two different branches.' : say(r.error) };
  revalidatePath(`/${slug}/app/stock`);
  return { error: null, message: `Transfer ${r.number} sent. The other branch confirms it when the stock arrives.` };
}

export async function receiveTransferAction(slug: string, transferId: string, lineIds: string[], _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'receive_stock');
  const r = await receiveTransfer(getDb(), ctx, { transferId, lines: lineIds.map((id) => ({ lineId: id, receivedQuantity: text(fd, `got_${id}`), reason: text(fd, `why_${id}`) })) }, new Date());
  if (!r.ok) return { error: r.error === 'reason_required' ? 'Say why an item arrived short or over.' : r.error === 'already_received' ? 'Already received.' : say(r.error) };
  revalidatePath(`/${slug}/app/stock/transfers/${transferId}`);
  return { error: null, message: r.differences ? `Received with ${r.differences} difference(s) recorded.` : 'Received.' };
}

export async function adjustAction(slug: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'adjust_stock');
  const l = await linesFromForm(ctx, fd, 'receive_stock');
  if ('error' in l) return { error: l.error };
  const line = { variantId: l.lines[0].variantId, unitId: l.lines[0].unitId, quantity: l.lines[0].quantity, batchNumber: l.lines[0].batchNumber };
  const reason = text(fd, 'reason') as AdjustmentReason;
  const branchId = text(fd, 'branchId');
  const a = await approval(ctx, fd, 'stock_adjustment', adjustmentKey(branchId, line, reason));
  if ('error' in a) return { error: a.error };
  const r = await adjustStock(getDb(), ctx, { branchId, line, reason, note: text(fd, 'note'), approvalToken: a.token }, new Date());
  if (!r.ok) return { error: say(r.error) };
  revalidatePath(`/${slug}/app/stock`);
  return { error: null, message: 'Stock adjusted.' };
}

export async function startCountAction(slug: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'stock_count');
  const r = await startCount(getDb(), ctx, { branchId: text(fd, 'branchId'), note: text(fd, 'note') }, new Date());
  if (!r.ok) return { error: r.error === 'nothing_to_count' ? 'No stock to count at this branch.' : say(r.error) };
  redirect(`/${slug}/app/stock/counts/${r.countId}`);
}

export async function saveCountAction(slug: string, countId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'stock_count');
  const c = await getCount(getDb(), ctx, countId);
  if (!c) return { error: 'Count not found.' };
  let saved = 0;
  for (const l of c.lines) {
    const v = text(fd, `n_${l.id}`);
    if (!v) continue;
    const r = await recordCount(getDb(), ctx, { countId, variantId: l.variantId, batchNumber: l.batchNumber ?? undefined, quantity: v, mode: 'set' }, new Date());
    if (!r.ok) return { error: `${l.name}: ${say(r.error)}` };
    saved++;
  }
  revalidatePath(`/${slug}/app/stock/counts/${countId}`);
  return { error: null, message: `Saved ${saved} count(s). Keep counting, then finish.` };
}

export async function finishCountAction(slug: string, countId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'stock_count');
  const a = await approval(ctx, fd, 'stock_count', countId);
  if ('error' in a) return { error: a.error };
  const r = await finishCount(getDb(), ctx, { countId, approvalToken: a.token }, new Date());
  if (!r.ok) return { error: say(r.error) };
  revalidatePath(`/${slug}/app/stock/counts/${countId}`);
  return { error: null, message: `Done: ${r.counted} counted, ${r.notCounted} left unchanged.` };
}

export async function cancelCountAction(slug: string, countId: string): Promise<FormState> {
  const ctx = await pageCtx(slug, 'stock_count');
  await cancelCount(getDb(), ctx, countId);
  revalidatePath(`/${slug}/app/stock/counts/${countId}`);
  return { error: null, message: 'Count cancelled; stock unchanged.' };
}
