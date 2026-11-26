import type { Metadata } from 'next';
import { ActionForm, Field } from '@/components/form';
import { stopAction } from './actions';

export const metadata: Metadata = { title: 'Stop promotional SMS', robots: { index: false, follow: false } };

/** Public opt-out page linked from every promotional SMS (spec 6.42). */
export default async function StopPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return (
    <main className="mx-auto my-10 flex max-w-sm flex-col gap-4 p-4">
      <h1 className="text-xl font-semibold">Stop promotional SMS</h1>
      <p className="text-sm text-gray-700">Enter your phone number and this shop will not send you promotional SMS again. Receipts are not affected.</p>
      <ActionForm action={stopAction.bind(null, slug)} submitLabel="Stop SMS">
        <Field label="Phone number" name="phone" type="tel" autoComplete="tel" />
      </ActionForm>
    </main>
  );
}
