import { getDb } from '@/db/client';
import { formatCedis } from '@/lib/money';
import { listOnlineOrders } from '@/server/online-orders';
import { pageCtx } from '../page-ctx';
import { STATUS_LABEL } from './status';

/** Spec 6.49: storefront orders to confirm, prepare and hand over. */
export default async function OnlineOrdersPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ all?: string }> }) {
  const { slug } = await params;
  const all = (await searchParams).all === '1';
  const ctx = await pageCtx(slug, 'online_orders');
  const rows = await listOnlineOrders(getDb(), ctx, all ? 'all' : 'open');
  return (
    <main className="flex max-w-3xl flex-col gap-4">
      <a href={`/${slug}/app`} className="text-sm text-blue-800 underline">← Home</a>
      <h1 className="text-2xl font-semibold">Online orders</h1>
      <p className="text-sm"><a className="text-blue-800 underline" href={`/${slug}/app/online-orders${all ? '' : '?all=1'}`}>{all ? 'Show open orders only' : 'Show all orders'}</a> · Turn online ordering on under Storefront.</p>
      {rows.length === 0 ? <p>No orders.</p> : (
        <table className="text-sm">
          <thead><tr className="text-left"><th>Order</th><th>Customer</th><th>How</th><th>Total</th><th>Status</th></tr></thead>
          <tbody>{rows.map((o) => (
            <tr key={o.id} className="border-t">
              <td className="py-1"><a className="text-blue-800 underline" href={`/${slug}/app/online-orders/${o.id}`}>{o.number}</a></td>
              <td>{o.contactName}</td>
              <td>{o.fulfilment} · {o.payMethod} · {o.source}</td>
              <td>{formatCedis(o.totalPesewas)}</td>
              <td>{STATUS_LABEL[o.status]}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </main>
  );
}
