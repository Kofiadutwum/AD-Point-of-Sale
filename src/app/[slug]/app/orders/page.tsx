import { ActionForm, Field } from '@/components/form';
import { getDb } from '@/db/client';
import { formatCedis } from '@/lib/money';
import { listOrders } from '@/server/customer-orders';
import { pageCtx } from '../page-ctx';
import { select, StockRows } from '../stock/parts';
import { createOrderAction } from './actions';

const STATUS = { open: 'Open', ready: 'Ready to collect', collected: 'Collected', cancelled: 'Cancelled' } as const;

/** Spec 4.21: layaway (items held, paid in parts) and special orders (items to come). Deposits are money held, not sales. */
export default async function OrdersPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await pageCtx(slug, 'layaway');
  const orders = await listOrders(getDb(), ctx);
  return (
    <main className="flex max-w-3xl flex-col gap-6">
      <a href={`/${slug}/app`} className="text-sm text-blue-800 underline">← Home</a>
      <h1 className="text-2xl font-semibold">Layaway and special orders</h1>
      <ul className="text-sm">{orders.map(({ o, customerName }) => (
        <li key={o.id}><a className="text-blue-800 underline" href={`/${slug}/app/orders/${o.id}`}>{o.number}</a> · {customerName} · {formatCedis(o.paidPesewas)} of {formatCedis(o.totalPesewas)} paid · {STATUS[o.status]}</li>
      ))}</ul>
      <details open={orders.length === 0}><summary className="cursor-pointer text-sm text-blue-800 underline">New order (at a till)</summary>
        <ActionForm action={createOrderAction.bind(null, slug)} submitLabel="Create order">
          <label className="flex flex-col gap-1 text-sm">Kind<select name="kind" className={select}><option value="layaway">Layaway (hold items in stock)</option><option value="special">Special order (items to come)</option></select></label>
          <Field label="Customer phone" name="phone" type="tel" />
          <StockRows rows={4} />
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Deposit (GHS)" name="deposit" inputMode="decimal" required={false} />
            <select name="method" className={select} aria-label="Paid by"><option value="cash">Cash</option><option value="momo_manual">MoMo</option><option value="card_terminal">Card</option><option value="bank_transfer">Bank</option></select>
            <Field label="Reference" name="reference" required={false} maxLength={100} />
          </div>
          <Field label="Collect by" name="dueDate" type="date" required={false} />
          <Field label="Note" name="note" required={false} maxLength={300} />
        </ActionForm>
      </details>
    </main>
  );
}
