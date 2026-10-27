'use server';
import { revalidatePath } from 'next/cache';
import type { FormState } from '@/components/form';
import { getDb } from '@/db/client';
import { formatCedis, parseCedis } from '@/lib/money';
import { recordChannelPayout } from '@/server/channel-payouts';
import { pageCtx } from '../../page-ctx';

const MESSAGES: Record<string, string> = {
  invalid_input: 'Check the amount, reference, and dates.', unknown_channel: 'Pick a channel.',
  duplicate_reference: 'A payout with that reference is already recorded.', nothing_to_match: 'No unpaid orders in those dates.',
};
const text = (fd: FormData, key: string) => String(fd.get(key) ?? '').trim();

export async function payoutAction(slug: string, channelId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_channels');
  const r = await recordChannelPayout(getDb(), ctx, {
    channelId, amountPesewas: parseCedis(text(fd, 'amount')) ?? -1, reference: text(fd, 'reference'), periodFrom: text(fd, 'from'), periodTo: text(fd, 'to'),
  }, new Date());
  if (!r.ok) return { error: MESSAGES[r.error] ?? 'Something went wrong. Try again.' };
  revalidatePath(`/${slug}/app/channels/payouts`);
  const gap = r.differencePesewas === 0 ? 'It matches.' : r.differencePesewas < 0 ? `The app paid ${formatCedis(-r.differencePesewas)} less.` : `The app paid ${formatCedis(r.differencePesewas)} more.`;
  return { error: null, message: `Matched ${r.matched} orders worth ${formatCedis(r.expectedPesewas)}. ${gap}` };
}
