import { notFound } from 'next/navigation';
import { ActionForm, Field } from '@/components/form';
import { getDb } from '@/db/client';
import { formatCedis } from '@/lib/money';
import { getOnlineOrder } from '@/server/online-orders';
import { pageCtx } from '../../page-ctx';
import { cancelAction, completeAction, confirmTransferAction, stepAction } from '../actions';
import { STATUS_LABEL } from '../status';

/** Spec 6.49: one online order: check the transfer, mark ready or out for delivery, hand over (a sale at this till), or cancel. */
export default async function OnlineOrderPage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  const ctx = await pageCtx(slug, 'online_orders');
  const o = await getOnlineOrder(getDb(), ctx, id);
  if (!o) notFound();
  const paid = ['confirmed', 'ready', 'out_for_delivery'].includes(o.status);
  const open = paid || o.status === 'awaiting_payment' || o.status === 'proof_uploaded';
  return (
    <main className="flex max-w-2xl flex-col gap-5">
      <a href={`/${slug}/app/online-orders`} className="text-sm text-blue-800 underline">← Online orders</a>
      <section className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Order {o.number}</h1>
        <p className="text-sm">{STATUS_LABEL[o.status]} · {o.createdAt.toISOString().slice(0, 16).replace('T', ' ')} · from {o.source}</p>
        <p className="text-sm">{o.contactName} · {o.contactPhone} · {o.fulfilment === 'delivery' ? `deliver to: ${o.deliveryAddress}` : 'pickup'}</p>
        {o.note && <p className="text-sm">Note: {o.note}</p>}
        <ul className="text-sm">{o.lines.map((l, i) => <li key={i}>{Number(l.quantity)} × {l.name} · {formatCedis(l.totalPesewas)}</li>)}</ul>
        <p className="text-lg">Total {formatCedis(o.totalPesewas)} · paid {formatCedis(o.paidPesewas)} by {o.payMethod}{o.paymentReference ? ` (${o.paymentReference})` : ''}</p>
        {o.deliveryFeePesewas > 0 && <p className="text-sm">Delivery fee {formatCedis(o.deliveryFeePesewas)}, paid on delivery.</p>}
      </section>
      {o.proofKey && (
        <section>
          <h2 className="font-semibold">Proof of transfer</h2>
          {/* eslint-disable-next-line @next/next/no-img-element -- private image behind the staff session */}
          <img src={`/${slug}/app/online-orders/${o.id}/proof`} alt="Transfer proof uploaded by the customer" className="max-h-96 rounded border" />
        </section>
      )}
      {o.payMethod === 'transfer' && (o.status === 'awaiting_payment' || o.status === 'proof_uploaded') && (
        <ActionForm action={confirmTransferAction.bind(null, slug, o.id)} submitLabel="Money arrived: confirm">
          <Field label="Transfer reference" name="reference" maxLength={100} />
        </ActionForm>
      )}
      {o.status === 'confirmed' && <ActionForm action={stepAction.bind(null, slug, o.id, 'ready')} submitLabel="Mark ready"><span /></ActionForm>}
      {o.fulfilment === 'delivery' && (o.status === 'confirmed' || o.status === 'ready') && <ActionForm action={stepAction.bind(null, slug, o.id, 'out_for_delivery')} submitLabel="Out for delivery"><span /></ActionForm>}
      {paid && <ActionForm action={completeAction.bind(null, slug, o.id)} submitLabel="Handed over: record the sale"><span /></ActionForm>}
      {open && (
        <details><summary className="cursor-pointer text-sm text-red-700 underline">Cancel order</summary>
          <ActionForm action={cancelAction.bind(null, slug, o.id)} submitLabel="Cancel order">
            <Field label="Reason" name="reason" maxLength={200} />
          </ActionForm>
        </details>
      )}
    </main>
  );
}
