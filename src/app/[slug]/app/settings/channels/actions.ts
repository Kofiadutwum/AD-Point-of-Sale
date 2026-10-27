'use server';
import { revalidatePath } from 'next/cache';
import type { FormState } from '@/components/form';
import { getDb } from '@/db/client';
import type { ChannelKind } from '@/lib/food';
import { saveChannel } from '@/server/channels';
import { pageCtx } from '../../page-ctx';

const MESSAGES: Record<string, string> = {
  invalid_input: 'Check the name (up to 40 letters) and the commission (0 to 100%).', duplicate_name: 'Another channel already has that name.',
  unknown_price_list: 'Pick one of your price lists.', module_off: 'Turn on the kitchen module first.',
};
const text = (fd: FormData, key: string) => String(fd.get(key) ?? '').trim();

/** Commission typed as a percent, e.g. "22.5", stored as basis points; -1 (refused) when it is not a number. */
function percentToBp(input: string): number {
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(input)) return -1;
  return Math.round(Number(input) * 100);
}

export async function saveChannelAction(slug: string, channelId: string | null, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_channels');
  const r = await saveChannel(getDb(), ctx, {
    ...(channelId ? { id: channelId } : {}),
    name: text(fd, 'name'), kind: text(fd, 'kind') as ChannelKind, priceListId: text(fd, 'priceListId') || null,
    commissionBp: percentToBp(text(fd, 'commission') || '0'), collectedBy: text(fd, 'collectedBy') === 'app' ? 'app' : 'shop', active: fd.get('active') === 'on',
  });
  if (!r.ok) return { error: MESSAGES[r.error] ?? 'Something went wrong. Try again.' };
  revalidatePath(`/${slug}/app/settings/channels`);
  return { error: null, message: 'Channel saved.' };
}
