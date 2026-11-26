import { ActionForm, Field } from '@/components/form';
import { getDb } from '@/db/client';
import { formatCedis } from '@/lib/money';
import { listCounterOrders, quoteCounterOrder } from '@/server/counter-orders';
import { pageCtx } from '../page-ctx';
import { cancelOrderAction, collectOrderAction, sendOrderAction } from './actions';

const select = 'rounded border border-gray-400 px-3 py-2';

export default async function CounterOrdersPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await pageCtx(slug, 'make_sale');
  const now = new Date();
  const orders = await listCounterOrders(getDb(), ctx, now);
  const quotes = ctx.registerId ? await Promise.all(orders.map((o) => quoteCounterOrder(getDb(), ctx, o.orderId, now))) : [];
  return (
    <main className="flex max-w-2xl flex-col gap-8">
      <a href={`/${slug}/app`} className="text-sm text-blue-800 underline">← Home</a>
      <section className="flex flex-col gap-3">
        <h1 className="text-2xl font-semibold">Counter orders</h1>
        <p className="text-sm text-gray-700">Build an order here; the customer pays at the cashier with the order number. Stock moves only when it is paid.</p>
        <ActionForm action={sendOrderAction.bind(null, slug)} submitLabel="Send to cashier">
          {[0, 1, 2, 3, 4].map((k) => (
            <div key={k} className="flex flex-wrap items-end gap-2">
              <Field label={`Item ${k + 1}: barcode or SKU`} name={`code_${k}`} required={false} maxLength={60} />
              <Field label="Quantity" name={`qty_${k}`} inputMode="decimal" required={false} defaultValue="1" />
            </div>
          ))}
        </ActionForm>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">Waiting for payment</h2>
        {orders.length === 0 && <p className="text-sm text-gray-700">No orders waiting.</p>}
        {!ctx.registerId && orders.length > 0 && <p className="text-sm text-gray-700">Take payment at a till: sign in with your PIN on a registered till.</p>}
        {orders.map((o, i) => {
          const q = quotes[i];
          return (
            <div key={o.orderId} className="flex flex-col gap-2 rounded border border-gray-300 p-3">
              <p className="font-semibold">Order {o.orderNumber} <span className="font-normal text-gray-700">from {o.createdBy}</span></p>
              <ul className="text-sm">{o.lines.map((l, k) => <li key={k}>{Number(l.quantity)} × {l.name}</li>)}</ul>
              {q && (q.ok ? <p className="text-lg">To pay: <strong>{formatCedis(q.totalPesewas)}</strong></p> : <p role="alert" className="text-sm text-red-700">{q.error.replaceAll('_', ' ')}</p>)}
              {ctx.registerId && (
                <ActionForm action={collectOrderAction.bind(null, slug, o.orderId)} submitLabel="Take payment">
                  <Field label="Cash (GHS)" name="cash" inputMode="decimal" required={false} />
                  <div className="flex flex-wrap items-end gap-2">
                    <select name="otherMethod" className={select} defaultValue="momo_manual" aria-label="Other payment">
                      <option value="momo_manual">MoMo</option><option value="card_terminal">Card</option><option value="bank_transfer">Bank transfer</option>
                    </select>
                    <Field label="Amount (GHS)" name="otherAmount" inputMode="decimal" required={false} />
                    <Field label="Reference" name="otherReference" required={false} maxLength={100} />
                  </div>
                </ActionForm>
              )}
              <ActionForm action={cancelOrderAction.bind(null, slug, o.orderId)} submitLabel="Cancel order">{null}</ActionForm>
            </div>
          );
        })}
      </section>
    </main>
  );
}
