import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ReceiptBody } from '@/components/receipt-view';
import { getDb } from '@/db/client';
import { getPublicReceipt } from '@/server/receipts';

export const metadata: Metadata = { title: 'Receipt', robots: { index: false, follow: false } };

/** The receipt link a customer opens from WhatsApp or SMS (spec 4.10). No sign-in. */
export default async function PublicReceiptPage({ params }: { params: Promise<{ slug: string; code: string }> }) {
  const { slug, code } = await params;
  const r = await getPublicReceipt(getDb(), slug, code);
  if (!r) notFound();
  return (
    <main className="mx-auto my-6 max-w-sm rounded border bg-white p-4">
      <ReceiptBody r={r} />
    </main>
  );
}
