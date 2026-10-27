'use server';
import { revalidatePath } from 'next/cache';
import type { FormState } from '@/components/form';
import { getDb } from '@/db/client';
import type { ServiceMode } from '@/lib/food';
import { saveFoodSettings, setServiceModes } from '@/server/food-settings';
import { createBoardLink } from '@/server/ready-board';
import { pageCtx } from '../../page-ctx';

const MESSAGES: Record<string, string> = {
  invalid_input: 'Check the form and try again.', unknown_item: 'Pick an active item as the pack.', unknown_branch: 'That branch no longer exists.',
  module_off: 'Turn on the kitchen module in shop settings first.',
};

export async function saveFoodSettingsAction(slug: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_shop_settings');
  const r = await saveFoodSettings(getDb(), ctx, {
    packVariantId: String(fd.get('packVariantId') ?? '') || null, packFeeMode: fd.get('packFeeMode') === 'per_item' ? 'per_item' : 'per_order',
  });
  if (!r.ok) return { error: MESSAGES[r.error] };
  revalidatePath(`/${slug}/app/settings/food`);
  return { error: null, message: 'Saved.' };
}

export async function saveModesAction(slug: string, branchId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_shop_settings');
  const r = await setServiceModes(getDb(), ctx, branchId, fd.getAll('modes').map(String) as ServiceMode[]);
  if (!r.ok) return { error: MESSAGES[r.error] };
  revalidatePath(`/${slug}/app/settings/food`);
  return { error: null, message: 'Saved.' };
}

export async function boardLinkAction(slug: string, branchId: string, _prev: FormState, _fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_devices');
  const r = await createBoardLink(getDb(), ctx, branchId);
  if (!r.ok) return { error: MESSAGES[r.error] };
  const base = (process.env.APP_URL ?? '').replace(/\/+$/, '');
  // shown once: only its hash is stored
  return { error: null, message: 'Open this link on the screen customers watch. Any older link for this branch stops working.', copy: `${base}/${slug}/board/${r.token}` };
}
