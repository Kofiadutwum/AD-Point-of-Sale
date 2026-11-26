'use server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type { FormState } from '@/components/form';
import { getDb } from '@/db/client';
import { cancelAutoRenew, startCheckout } from '@/server/billing';
import { paystack } from '@/server/paystack';
import { pageCtx } from '../page-ctx';

const MESSAGES: Record<string, string> = {
  invalid_plan: 'Choose a plan.', email_required: 'Enter an email address for the payment receipt.', provider_unavailable: 'Paystack is not answering. Try again in a few minutes.',
};

export async function payAction(slug: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_shop_settings', { allowReadOnly: true });
  const r = await startCheckout(getDb(), ctx, { planId: String(fd.get('planId') ?? ''), autoRenew: fd.get('autoRenew') === 'on', email: String(fd.get('email') ?? '') || undefined }, new Date(), paystack);
  if (!r.ok) return { error: MESSAGES[r.error] };
  redirect(r.authorizationUrl);
}

export async function cancelRenewalAction(slug: string): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_shop_settings', { allowReadOnly: true });
  await cancelAutoRenew(getDb(), ctx);
  revalidatePath(`/${slug}/app/billing`);
  return { error: null, message: 'Card renewal is off. Your plan runs to its end date; renew by hand before then.' };
}
