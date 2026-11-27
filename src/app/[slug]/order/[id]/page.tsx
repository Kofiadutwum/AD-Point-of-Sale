import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { ActionForm } from '@/components/form';
import { getDb } from '@/db/client';
import { formatCedis } from '@/lib/money';
import { publicOrder } from '@/server/online-orders';
import { confirmOrderReturn } from '@/server/shop-paystack';
import { payAgainAction } from '../actions';
import { ProofUpload } from './proof-upload';
import { orderTokenCookie } from '../token';

export const metadata = { robots: { index: false } };

const SAY: Record<string, string> = {
  awaiting_payment: 'Waiting for your payment', proof_uploaded: 'The shop is checking your payment', confirmed: 'Paid. The shop is preparing your order',
  ready: 'Ready', out_for_delivery: 'On the way', completed: 'Completed', cancelled: 'Cancelled', expired: 'Lapsed: it was not paid in time',
};

/** Spec 6.49: the visitor's own order (their verified phone only): status, transfer details and proof upload. */
export default async function VisitorOrderPage({ params, searchParams }: { params: Promise<{ slug: string; id: string }>; searchParams: Promise<{ reference?: string }> }) {
  const { slug, id } = await params;
  const { reference } = await searchParams;
  const now = new Date();
  if (reference) await confirmOrderReturn(getDb(), slug, reference, now); // back from Paystack checkout
  const o = await publicOrder(getDb(), slug, id, (await cookies()).get(orderTokenCookie(slug))?.value, now);
  if (!o) notFound();
  return (
    <main className="mx-auto flex max-w-xl flex-col gap-4 p-4">
      <a href={`/${slug}`} className="text-sm underline">← {o.shopName}</a>
      <h1 className="text-2xl font-semibold">Order {o.number}</h1>
      <p className="text-lg">{SAY[o.status]}</p>
      <ul className="text-sm">{o.lines.map((l, i) => <li key={i}>{Number(l.quantity)} × {l.name} · {formatCedis(l.totalPesewas)}</li>)}</ul>
      <p className="font-semibold">Total {formatCedis(o.totalPesewas)}{o.deliveryFeePesewas > 0 ? ` (+ ${formatCedis(o.deliveryFeePesewas)} delivery, paid on delivery)` : ''}</p>
      {o.payUrl && <a href={o.payUrl} className="self-start rounded bg-green-700 px-4 py-3 font-semibold text-white">Pay now (card or MoMo)</a>}
      {!o.payUrl && o.payMethod === 'paystack' && o.status === 'awaiting_payment' && <ActionForm action={payAgainAction.bind(null, slug, id)} submitLabel="Pay now (card or MoMo)"><span /></ActionForm>}
      {o.status === 'awaiting_payment' && <p className="text-sm">Pay by {o.expiresAt.toISOString().slice(11, 16)} UTC or the order lapses. We text you at each step.</p>}
      {o.payMethod === 'transfer' && (o.status === 'awaiting_payment' || o.status === 'proof_uploaded') && (
        <section className="flex flex-col gap-2 rounded border p-3">
          <h2 className="font-semibold">Pay by transfer</h2>
          <p className="whitespace-pre-line text-sm">{o.transferInstructions}</p>
          <p className="text-sm">Use <strong>{o.number}</strong> as the reference, then upload a screenshot.</p>
          <ProofUpload slug={slug} orderId={id} label={o.hasProof ? 'Replace the screenshot' : 'Upload the screenshot'} />
        </section>
      )}
    </main>
  );
}
