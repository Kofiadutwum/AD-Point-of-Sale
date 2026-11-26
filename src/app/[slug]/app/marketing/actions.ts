'use server';
import { revalidatePath } from 'next/cache';
import type { FormState } from '@/components/form';
import { getDb } from '@/db/client';
import type { CampaignSegment } from '@/db/schema';
import { sendCampaign } from '@/server/marketing';
import { pageCtx } from '../page-ctx';

const MESSAGES: Record<string, string> = {
  invalid_input: 'Write a message of up to 300 characters.', no_recipients: 'No customers in that group have agreed to SMS.',
  over_allowance: "This needs more SMS than are left this month.", cost_changed: 'The number of customers changed. Check the cost again.',
};

export async function sendCampaignAction(slug: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'marketing');
  const r = await sendCampaign(getDb(), ctx, {
    segment: String(fd.get('segment')) as CampaignSegment, message: String(fd.get('message') ?? ''), confirmedParts: Number(fd.get('confirmedParts')),
  }, new Date());
  if (!r.ok) return { error: MESSAGES[r.error] };
  revalidatePath(`/${slug}/app/marketing`);
  return { error: null, message: `Queued for ${r.recipients} customers. Sending from ${r.sendAfter.toLocaleString('en-GB', { timeZone: 'Africa/Accra' })}.` };
}
