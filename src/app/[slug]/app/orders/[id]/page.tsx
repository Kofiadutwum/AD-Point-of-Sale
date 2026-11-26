import { notFound } from 'next/navigation';
import { ActionForm, Field } from '@/components/form';
import { PrintButton } from '@/components/print-button';
import { getDb } from '@/db/client';
import { formatCedis } from '@/lib/money';
import { listApprovers } from '@/server/approvals';
import { getOrder } from '@/server/customer-orders';
import { pageCtx } from '../../page-ctx';
import { ApproverFields, select } from '../../stock/parts';
import { cancelOrderAction, collectOrderAction, payOrderAction } from '../actions';

/** Spec 6.34: the order slip (balance and due date), part payments, collection, and cancellation. */
export default async function OrderPage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  const ctx = await pageCtx(slug, 'layaway');
  const [o, approvers] = await Promise.all([getOrder(getDb(), ctx, id), listApprovers(getDb(), ctx)]);
  if (!o) notFound();
  const owed = o.totalPesewas - o.paidPesewas;
  const live = o.status === 'open' || o.status === 'ready';
  return (
    <main className="flex max-w-2xl flex-col gap-5">
      <a href={`/${slug}/app/orders`} className="text-sm text-blue-800 underline">← Orders</a>
      <section className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{o.kind === 'layaway' ? 'Layaway' : 'Special order'} {o.number}</h1>
        <p className="text-sm">{o.customerName} · {o.phone} · {o.status}{o.dueDate ? ` · collect by ${o.dueDate}` : ''}</p>
        <ul className="text-sm">{o.lines.map((l, i) => <li key={i}>{Number(l.quantity)} {l.unitName} {l.name} · {formatCedis(l.totalPesewas)}</li>)}</ul>
        <p className="text-lg">Total {formatCedis(o.totalPesewas)} · paid {formatCedis(o.paidPesewas)} · <strong>left {formatCedis(Math.max(owed, 0))}</strong></p>
        <ul className="text-xs text-gray-700">{o.payments.map((p) => <li key={p.id}>{p.createdAt.toISOString().slice(0, 10)} · {p.method} · {formatCedis(p.amountPesewas)}</li>)}</ul>
        <PrintButton />
      </section>
      {live && owed > 0 && (
        <ActionForm action={payOrderAction.bind(null, slug, o.id)} submitLabel="Record payment">
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Amount (GHS)" name="amount" inputMode="decimal" defaultValue={(owed / 100).toFixed(2)} />
            <select name="method" className={select} aria-label="Paid by"><option value="cash">Cash</option><option value="momo_manual">MoMo</option><option value="card_terminal">Card</option><option value="bank_transfer">Bank</option></select>
            <Field label="Reference" name="reference" required={false} maxLength={100} />
          </div>
        </ActionForm>
      )}
      {live && owed <= 0 && <ActionForm action={collectOrderAction.bind(null, slug, o.id)} submitLabel="Hand over and make the sale"><span /></ActionForm>}
      {live && (
        <details><summary className="cursor-pointer text-sm text-red-700 underline">Cancel order</summary>
          <ActionForm action={cancelOrderAction.bind(null, slug, o.id)} submitLabel="Cancel order">
            <Field label="Reason" name="reason" maxLength={200} />
            <ApproverFields approvers={approvers} />
          </ActionForm>
        </details>
      )}
    </main>
  );
}
