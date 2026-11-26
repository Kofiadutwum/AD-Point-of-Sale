import { getDb } from '@/db/client';
import { applyReference } from '@/server/billing';
import { paystack } from '@/server/paystack';
import { pageCtx } from '../../page-ctx';

const SAY: Record<string, string> = {
  applied: 'Payment confirmed. Thank you: your subscription is extended.', already: 'This payment is already applied.',
  pending: 'Paystack has not confirmed the payment yet. Mobile money can take a few minutes; your plan updates once it does.',
  failed: 'The payment did not go through. You were not charged; try again.', mismatch: 'The amount paid does not match the plan. Contact support with your reference.',
  unknown: 'We could not find this payment.',
};

/** Paystack sends the owner back here; the result is checked with Paystack on the server, never taken from the address bar. */
export default async function BillingReturnPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ reference?: string; trxref?: string }> }) {
  const { slug } = await params;
  const q = await searchParams;
  await pageCtx(slug, 'manage_shop_settings', { allowReadOnly: true });
  const reference = q.reference ?? q.trxref ?? '';
  const result = reference.startsWith('SUB-') ? await applyReference(getDb(), reference, new Date(), paystack) : 'unknown';
  return (
    <main className="flex max-w-xl flex-col gap-4">
      <h1 className="text-2xl font-semibold">Payment</h1>
      <p>{SAY[result]}</p>
      <a href={`/${slug}/app/billing`} className="text-blue-800 underline">Back to billing</a>
    </main>
  );
}
